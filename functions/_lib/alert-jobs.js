import { getMetaValue, hydrateSubscriberContacts, updateAlertRecord } from './db.js';
import { contactHash, encryptString } from './crypto.js';
import { createAccountManagementLink } from './customer-portal.js';
import { isSupportedSmsPhone } from './contacts.js';
import { HttpError } from './http.js';
import { sendTelnyxMessage } from './telnyx.js';
import {
  formatEmergencyNotification, getEmergencyLevel, getEmergencySnapshotSignal,
  getLatestSlotKey, getLevel5EmailContent, sendEmail,
} from './notifications.js';

export const ALERT_BATCH_SIZE = 5;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LEASE_SECONDS = 300;
const isoNow = () => new Date().toISOString();
const alertUrl = (env) => String(env.EWS_NOTIFICATION_URL || 'https://aews.cc/').trim();

function validateProviders(env) {
  for (const key of ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL', 'TELNYX_API_KEY',
    'NOTIFICATION_ENCRYPTION_KEY', 'NOTIFICATION_HASH_SECRET']) {
    if (!String(env[key] || '').trim()) throw new HttpError(503, `Missing required secret: ${key}.`);
  }
  if (!(env.TELNYX_FROM_PHONE || env.TELNYX_NUMBER || env.TELNYX_MESSAGING_PROFILE_ID)) {
    throw new HttpError(503, 'Telnyx sender is not configured.');
  }
}

export async function getAlertJobStatus(env) {
  return env.EWS_NOTIFY_DB.prepare(`SELECT j.alert_id, j.status, j.cursor,
    j.started_at, j.updated_at, j.completed_at, j.lease_until,
    a.subscriber_count, a.email_sent_count, a.sms_sent_count, a.error_count,
    a.status AS alert_status
    FROM notification_alert_jobs j JOIN notification_alerts a ON a.id = j.alert_id
    WHERE j.id = 1`).first();
}

export async function maybeSendLevel5Notifications(env, snapshot, { source = 'scheduled_refresh' } = {}) {
  // Resumption is independent of today's signal and the cooldown.
  const existing = await getAlertJobStatus(env);
  if (existing?.status === 'running') {
    await wakeDispatcher(env);
    return { ok: true, queued: true, resumed: true, alertId: existing.alert_id };
  }
  if (getEmergencyLevel(snapshot) !== 5) {
    return { ok: true, sent: false, reason: 'emergency_level_not_5' };
  }
  const lastSentAt = existing?.completed_at || await getMetaValue(env, 'level5_notification_last_sent_at');
  if (lastSentAt && Date.now() - Date.parse(lastSentAt) < COOLDOWN_MS) {
    return { ok: true, sent: false, reason: 'cooldown_active', lastSentAt };
  }
  validateProviders(env);
  const db = env.EWS_NOTIFY_DB;
  const id = crypto.randomUUID();
  const now = isoNow();
  const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString();
  // Store only the signal needed to reproduce the message, not a whole dashboard.
  const storedSnapshot = { signals: { composite: getEmergencySnapshotSignal(snapshot) },
    liveStatus: { latestSlotKey: getLatestSlotKey(snapshot) } };
  await db.batch([
    db.prepare(`INSERT INTO notification_alert_jobs (id, alert_id, snapshot_json, started_at, updated_at)
      VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        alert_id = excluded.alert_id, snapshot_json = excluded.snapshot_json, cursor = '',
        status = 'running', lease_token = NULL, lease_until = 0, dispatch_after = 0,
        started_at = excluded.started_at, updated_at = excluded.updated_at, completed_at = NULL
      WHERE notification_alert_jobs.status = 'complete' AND notification_alert_jobs.completed_at <= ?`
    ).bind(id, JSON.stringify(storedSnapshot), now, now, cutoff),
    db.prepare(`INSERT INTO notification_alerts
      (id, kind, source, level, slot_key, message_text, status, created_at, updated_at)
      SELECT ?, 'level5', ?, 5, ?, ?, 'sending', ?, ?
      WHERE EXISTS (SELECT 1 FROM notification_alert_jobs WHERE id = 1 AND alert_id = ?)`
    ).bind(id, source, getLatestSlotKey(snapshot), formatEmergencyNotification(storedSnapshot,
      { alertUrl: alertUrl(env) }), now, now, id),
  ]);
  const job = await getAlertJobStatus(env);
  await wakeDispatcher(env);
  return { ok: true, queued: true, alertId: job.alert_id, resumed: job.alert_id !== id };
}

async function wakeDispatcher(env) {
  // Cron is the recovery path if enqueue or service binding availability fails.
  if (!env.EWS_ALERT_DISPATCH) return;
  try {
    const response = await env.EWS_ALERT_DISPATCH.fetch('https://dispatcher/wake', {
      method: 'POST', headers: { authorization: `Bearer ${env.INTERNAL_ALERT_TOKEN}` },
    });
    if (!response.ok) console.error('Alert dispatcher wake failed:', response.status);
  } catch {
    console.error('Alert dispatcher wake failed; the scheduled dispatcher will resume the saved job.');
  }
}

async function sendJobDelivery(env, { job, subscriber, channel, destination, text, html, subject }) {
  const db = env.EWS_NOTIFY_DB;
  const id = `${job.alert_id}:${subscriber.id}:${channel}`;
  const now = isoNow();
  // The primary key is the deduplication key. Claim before making a provider call.
  const claim = await db.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (id, alert_id, subscriber_id, channel, destination_hash, status,
      message_text_cipher, subject, created_at, updated_at, attempt_count)
    VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, 1)`
  ).bind(id, job.alert_id, subscriber.id, channel,
    await contactHash(env, channel === 'sms' ? 'phone' : 'email', destination),
    await encryptString(env, text), subject || null, now, now).run();
  if (!claim.meta.changes) {
    // Only explicit provider rate-limit rejections are safe to automatically resend.
    const retry = await db.prepare(`UPDATE notification_deliveries SET status = 'sending',
      attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ? AND status = 'retry' AND attempt_count < 3 RETURNING id`).bind(now, id).first();
    if (!retry) {
      await db.prepare(`UPDATE notification_deliveries SET status = 'unknown',
        error = 'Interrupted after send claim; confirm provider outcome before retrying.', updated_at = ?
        WHERE id = ? AND status = 'sending'`).bind(now, id).run();
      return false;
    }
  }
  let result;
  try {
    result = channel === 'email'
      ? await sendEmail(env, { to: destination, subject, text, html })
      : await sendTelnyxMessage(env, { to: destination, text });
  } catch (error) {
    const status = Number(error.status || 0);
    const safeRejection = status >= 400 && status < 500 && status !== 408;
    const row = await db.prepare(`UPDATE notification_deliveries SET
      status = CASE WHEN ? = 429 AND attempt_count < 3 THEN 'retry' ELSE ? END,
      error = ?, updated_at = ? WHERE id = ? RETURNING status`
    ).bind(status, safeRejection ? 'failed' : 'unknown',
      String(error.message || 'Provider outcome unknown').slice(0, 1000), isoNow(), id).first();
    return row.status === 'retry';
  }
  // A failure here must propagate. Retrying the job will flag the existing claim,
  // never repeat the provider call after an ambiguous successful send.
  await db.prepare(`UPDATE notification_deliveries SET status = 'sent',
    provider_message_id = ?, provider_status = ?, carrier = ?, line_type = ?, error = NULL, updated_at = ?
    WHERE id = ?`).bind(result.id, result.providerStatus || null, result.carrier || null,
    result.lineType || null, isoNow(), id).run();
  return false;
}

export async function processAlertJobBatch(env, alertId, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const db = env.EWS_NOTIFY_DB;
  const token = crypto.randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const job = await db.prepare(`UPDATE notification_alert_jobs SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = 1 AND alert_id = ? AND status = 'running' AND lease_until <= ? RETURNING *`
  ).bind(token, nowSeconds + LEASE_SECONDS, isoNow(), alertId, nowSeconds).first();
  if (!job) {
    const current = await getAlertJobStatus(env);
    return { ok: true, more: current?.alert_id === alertId && current.status === 'running', retryAfter: 60 };
  }
  validateProviders(env);
  const { results: subscribers } = await db.prepare(`SELECT * FROM notification_signups
    WHERE status = 'active' AND id > ? AND created_at <= ?
      AND (wants_email = 1 OR wants_sms = 1)
    ORDER BY id LIMIT ?`).bind(job.cursor, job.started_at, ALERT_BATCH_SIZE).all();
  const snapshot = JSON.parse(job.snapshot_json);
  let nextSmsAt = Date.now();
  const outcomes = await Promise.allSettled(subscribers.map(async (row) => {
    let retry = false;
    const subscriber = await hydrateSubscriberContacts(env, row);
    if (subscriber.wantsEmail && subscriber.email) {
      const managementUrl = await createAccountManagementLink(env, subscriber, { baseUrl: alertUrl(env) });
      const content = getLevel5EmailContent(env, snapshot, subscriber, managementUrl);
      retry = await sendJobDelivery(env, { job, subscriber, channel: 'email',
        destination: subscriber.email, subject: 'Apocalypse EWS: emergency level 5', ...content }) || retry;
    }
    if (subscriber.wantsSms && subscriber.phone && isSupportedSmsPhone(subscriber.phone)) {
      // Reserve SMS slots synchronously; email/provider waits can overlap without
      // exceeding the existing four SMS/second ceiling or five concurrent sends.
      nextSmsAt = Math.max(Date.now(), nextSmsAt) + 250;
      await sleep(Math.max(0, nextSmsAt - Date.now()));
      retry = await sendJobDelivery(env, { job, subscriber, channel: 'sms',
        destination: subscriber.phone, text: formatEmergencyNotification(snapshot, { includeAlertUrl: false }) }) || retry;
    }
    return retry;
  }));
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  const retry = outcomes.some((outcome) => outcome.value);
  if (!subscribers.length) {
    // A subscriber can opt out between a rate-limit rejection and its retry.
    await db.prepare(`UPDATE notification_deliveries SET status = 'failed',
      error = 'Recipient became ineligible before the rate-limited delivery could be retried.', updated_at = ?
      WHERE alert_id = ? AND status = 'retry'`).bind(isoNow(), alertId).run();
    const alert = await db.prepare('SELECT subscriber_count FROM notification_alerts WHERE id = ?').bind(alertId).first();
    await updateAlertRecord(env, alertId, { status: 'sent', subscriberCount: alert.subscriber_count });
    await db.prepare(`UPDATE notification_alert_jobs SET status = 'complete', completed_at = ?,
      updated_at = ?, lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?`
    ).bind(isoNow(), isoNow(), token).run();
    return { ok: true, more: false };
  }
  await db.batch([
    db.prepare(`UPDATE notification_alerts SET subscriber_count = subscriber_count + ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM notification_alert_jobs WHERE id = 1 AND lease_token = ?)`
    ).bind(retry ? 0 : subscribers.length, isoNow(), alertId, token),
    db.prepare(`UPDATE notification_alert_jobs SET cursor = ?, updated_at = ?, lease_token = NULL, lease_until = 0, dispatch_after = ?
      WHERE id = 1 AND lease_token = ?`).bind(retry ? job.cursor : subscribers.at(-1).id, isoNow(), Math.floor(Date.now() / 1000) + 300, token),
  ]);
  return { ok: true, more: true, retryAfter: retry ? 60 : 0 };
}
