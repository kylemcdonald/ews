import {
  createAlertRecord,
  getActiveSubscribers,
  getMetaValue,
  hydrateSubscriberContacts,
  recordDelivery,
  setMetaValue,
  updateAlertRecord,
} from "./db.js";
import { contactHash } from "./crypto.js";
import { createCustomerPortalLink } from "./customer-portal.js";
import { HttpError } from "./http.js";
import { sendTelnyxMessage } from "./telnyx.js";

const LEVEL5_COOLDOWN_META_KEY = "level5_notification_last_sent_at";
const DEFAULT_NOTIFICATION_URL = "https://aews.cc/";
const LEVEL5_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function formatCount(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return "0";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(numericValue));
}

function formatSignedCount(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return "+0";
  }

  const roundedValue = Math.round(numericValue);
  return `${roundedValue >= 0 ? "+" : ""}${formatCount(roundedValue)}`;
}

export function getEmergencySnapshotSignal(snapshot) {
  return snapshot?.signals?.composite || {
    emergencyLevel: snapshot?.current?.emergencyLevel,
    actualConcurrentCount: snapshot?.current?.concurrentCount,
    expectedConcurrentCount: snapshot?.current?.baselineMean,
    asOf: snapshot?.current?.asOf,
  };
}

export function getLatestSlotKey(snapshot) {
  return (
    snapshot?.liveStatus?.latestSlotKey ||
    snapshot?.current?.asOf ||
    getEmergencySnapshotSignal(snapshot)?.asOf ||
    null
  );
}

export function getEmergencyLevel(snapshot) {
  return Math.round(Number(getEmergencySnapshotSignal(snapshot)?.emergencyLevel || 1));
}

export function formatEmergencyNotification(snapshot, { test = false, alertUrl = DEFAULT_NOTIFICATION_URL } = {}) {
  const signal = getEmergencySnapshotSignal(snapshot);
  const actualCount = Number(signal?.actualConcurrentCount ?? snapshot?.current?.concurrentCount ?? 0);
  const expectedCount = Number(signal?.expectedConcurrentCount ?? snapshot?.current?.baselineMean ?? 0);
  const aboveExpectedCount = actualCount - expectedCount;
  const prefix = test ? "TEST ALERT: " : "";

  return `${prefix}Emergency level 5. ${formatCount(actualCount)} airborne (${formatSignedCount(
    aboveExpectedCount,
  )} above expected). ${alertUrl}`;
}

function getAlertUrl(env) {
  return String(env.EWS_NOTIFICATION_URL || DEFAULT_NOTIFICATION_URL).trim() || DEFAULT_NOTIFICATION_URL;
}

async function appendCustomerPortalLink(env, subscriber, messageText) {
  const portalUrl = await createCustomerPortalLink(env, subscriber);
  return `${messageText}\n\nManage or cancel your subscription: ${portalUrl}`;
}

async function sendEmail(env, { to, subject, text }) {
  const apiKey = String(env.SENDGRID_API_KEY || "").trim();
  const fromEmail = String(env.SENDGRID_FROM_EMAIL || "").trim();
  if (!apiKey || !fromEmail) {
    throw new HttpError(500, "SendGrid is not configured.");
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: to }],
          subject,
        },
      ],
      from: {
        email: fromEmail,
        name: String(env.SENDGRID_FROM_NAME || "Apocalypse EWS"),
      },
      content: [
        {
          type: "text/plain",
          value: text,
        },
      ],
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `SendGrid request failed with ${response.status}`);
  }

  return {
    id: response.headers.get("x-message-id") || null,
  };
}

async function sendSms(env, { to, text }) {
  return sendTelnyxMessage(env, { to, text });
}

async function sendDelivery(env, { alertId, subscriberId, channel, destination, text, subject = null }) {
  const destinationHash = await contactHash(env, channel === "sms" ? "phone" : channel, destination);

  try {
    const result =
      channel === "email"
        ? await sendEmail(env, { to: destination, subject, text })
        : await sendSms(env, { to: destination, text });
    await recordDelivery(env, {
      alertId,
      subscriberId,
      channel,
      destinationHash,
      status: "sent",
      providerMessageId: result.id,
    });

    return { ok: true, channel };
  } catch (error) {
    await recordDelivery(env, {
      alertId,
      subscriberId,
      channel,
      destinationHash,
      status: "failed",
      error: error.message,
    });

    return { ok: false, channel, error: error.message };
  }
}

async function recordDeliveryPreparationFailure(env, { alertId, subscriberId, channel, destination, error }) {
  const destinationHash = await contactHash(env, channel === "sms" ? "phone" : channel, destination);
  await recordDelivery(env, {
    alertId,
    subscriberId,
    channel,
    destinationHash,
    status: "failed",
    error: error.message,
  });
}

async function sendAlertToSubscribers(env, { alertId, subscribers, messageText, subject, includeCustomerPortalLinks = false }) {
  const summary = {
    subscriberCount: subscribers.length,
    emailSentCount: 0,
    smsSentCount: 0,
    errorCount: 0,
  };

  for (const subscriber of subscribers) {
    const hydrated = await hydrateSubscriberContacts(env, subscriber);
    if (hydrated.wantsEmail && hydrated.email) {
      let emailText = messageText;
      try {
        if (includeCustomerPortalLinks) {
          emailText = await appendCustomerPortalLink(env, hydrated, messageText);
        }
      } catch (error) {
        await recordDeliveryPreparationFailure(env, {
          alertId,
          subscriberId: hydrated.id,
          channel: "email",
          destination: hydrated.email,
          error,
        });
        summary.errorCount += 1;
        continue;
      }

      const result = await sendDelivery(env, {
        alertId,
        subscriberId: hydrated.id,
        channel: "email",
        destination: hydrated.email,
        text: emailText,
        subject,
      });
      if (result.ok) {
        summary.emailSentCount += 1;
      } else {
        summary.errorCount += 1;
      }
    }

    if (hydrated.wantsSms && hydrated.phone) {
      const result = await sendDelivery(env, {
        alertId,
        subscriberId: hydrated.id,
        channel: "sms",
        destination: hydrated.phone,
        text: messageText,
      });
      if (result.ok) {
        summary.smsSentCount += 1;
      } else {
        summary.errorCount += 1;
      }
    }
  }

  summary.status = summary.errorCount > 0 ? "completed_with_errors" : "sent";
  await updateAlertRecord(env, alertId, summary);
  return summary;
}

export async function maybeSendLevel5Notifications(env, snapshot, { source = "scheduled_refresh" } = {}) {
  const emergencyLevel = getEmergencyLevel(snapshot);
  const slotKey = getLatestSlotKey(snapshot);
  if (emergencyLevel !== 5) {
    return {
      ok: true,
      sent: false,
      reason: "emergency_level_not_5",
      emergencyLevel,
      slotKey,
    };
  }

  const lastSentAt = await getMetaValue(env, LEVEL5_COOLDOWN_META_KEY);
  if (lastSentAt && Date.now() - new Date(lastSentAt).getTime() < LEVEL5_COOLDOWN_MS) {
    return {
      ok: true,
      sent: false,
      reason: "cooldown_active",
      emergencyLevel,
      slotKey,
      lastSentAt,
    };
  }

  const messageText = formatEmergencyNotification(snapshot, { alertUrl: getAlertUrl(env) });
  const alertId = await createAlertRecord(env, {
    kind: "level5",
    source,
    level: emergencyLevel,
    slotKey,
    messageText,
  });
  const subscribers = await getActiveSubscribers(env);
  const summary = await sendAlertToSubscribers(env, {
    alertId,
    subscribers,
    messageText,
    subject: "Apocalypse EWS: emergency level 5",
    includeCustomerPortalLinks: true,
  });

  await setMetaValue(env, LEVEL5_COOLDOWN_META_KEY, new Date().toISOString());

  return {
    ok: summary.errorCount === 0,
    sent: true,
    alertId,
    emergencyLevel,
    slotKey,
    ...summary,
  };
}

export async function sendAdminTestToAll(env, snapshot) {
  const messageText = formatEmergencyNotification(snapshot, { test: true, alertUrl: getAlertUrl(env) });
  const alertId = await createAlertRecord(env, {
    kind: "admin_test_all",
    source: "admin",
    level: 5,
    slotKey: getLatestSlotKey(snapshot),
    messageText,
  });
  const subscribers = await getActiveSubscribers(env);
  const summary = await sendAlertToSubscribers(env, {
    alertId,
    subscribers,
    messageText,
    subject: "TEST: Apocalypse EWS emergency alert",
    includeCustomerPortalLinks: true,
  });

  return {
    ok: summary.errorCount === 0,
    sent: true,
    alertId,
    ...summary,
  };
}

export async function sendAdminSingleTest(env, { email, phone }) {
  const snapshot = {
    signals: {
      composite: {
        emergencyLevel: 5,
        actualConcurrentCount: 521,
        expectedConcurrentCount: 400,
        asOf: new Date().toISOString(),
      },
    },
  };
  const messageText = formatEmergencyNotification(snapshot, { test: true, alertUrl: getAlertUrl(env) });
  const alertId = await createAlertRecord(env, {
    kind: "admin_test_single",
    source: "admin",
    level: 5,
    slotKey: getLatestSlotKey(snapshot),
    messageText,
  });
  const summary = {
    subscriberCount: 0,
    emailSentCount: 0,
    smsSentCount: 0,
    errorCount: 0,
  };

  if (email) {
    const result = await sendDelivery(env, {
      alertId,
      channel: "email",
      destination: email,
      text: messageText,
      subject: "TEST: Apocalypse EWS emergency alert",
    });
    if (result.ok) {
      summary.emailSentCount += 1;
    } else {
      summary.errorCount += 1;
    }
  }

  if (phone) {
    const result = await sendDelivery(env, {
      alertId,
      channel: "sms",
      destination: phone,
      text: messageText,
    });
    if (result.ok) {
      summary.smsSentCount += 1;
    } else {
      summary.errorCount += 1;
    }
  }

  summary.status = summary.errorCount > 0 ? "completed_with_errors" : "sent";
  await updateAlertRecord(env, alertId, summary);

  return {
    ok: summary.errorCount === 0,
    sent: true,
    alertId,
    ...summary,
  };
}
