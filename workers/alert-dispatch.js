import { requireInternalAuth } from '../functions/_lib/internal-auth.js';

async function enqueueActiveJob(env) {
  const now = Math.floor(Date.now() / 1000);
  const job = await env.EWS_NOTIFY_DB.prepare(`UPDATE notification_alert_jobs SET dispatch_after = ?
    WHERE id = 1 AND status = 'running' AND lease_until <= ? AND dispatch_after <= ?
    RETURNING alert_id`).bind(now + 300, now, now).first();
  if (job) await env.EWS_ALERT_QUEUE.send({ alertId: job.alert_id });
}

export default {
  async fetch(request, env) {
    try { requireInternalAuth(request, env); } catch { return new Response('Unauthorized', { status: 401 }); }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    await enqueueActiveJob(env);
    return Response.json({ ok: true });
  },
  async scheduled(_controller, env) {
    // Recover a lost enqueue, exhausted queue retry, or expired message using D1.
    await enqueueActiveJob(env);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const response = await fetch(`${env.EWS_ALERT_ORIGIN}/api/internal/alert-jobs`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.INTERNAL_ALERT_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ alertId: message.body.alertId }),
          signal: AbortSignal.timeout(240_000),
        });
        if (!response.ok) throw new Error(`Alert batch returned HTTP ${response.status}`);
        const result = await response.json();
        if (result.more) {
          await env.EWS_ALERT_QUEUE.send(message.body, { delaySeconds: result.retryAfter || 0 });
        }
        message.ack();
      } catch (error) {
        console.error('Alert batch will retry:', error.message);
        message.retry({ delaySeconds: 60 });
      }
    }
  },
};
