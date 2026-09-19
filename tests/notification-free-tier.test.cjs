const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { Miniflare } = require('miniflare');

// Load the Pages ES modules without changing the CommonJS application package.
const compiled = buildSync({ stdin: { contents: `
  export * from './functions/_lib/alert-jobs.js';
  export * from './functions/_lib/db.js';
  export * from './functions/_lib/crypto.js';
  export { default as dispatcher } from './workers/alert-dispatch.js';
  export { onRequestGet as jobStatus, onRequestPost as batchEndpoint } from './functions/api/internal/alert-jobs.js';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(path.join(process.cwd(), 'tests', 'bundled.cjs'));
mod.filename = path.join(process.cwd(), 'tests', 'bundled.cjs');
mod._compile(compiled.outputFiles[0].text, mod.filename);
const api = mod.exports;
const snapshot = { signals: { composite: { emergencyLevel: 5, actualConcurrentCount: 521,
  expectedConcurrentCount: 400, asOf: '2026-09-19T00:00:00Z' } } };
const noSleep = { sleep: async () => {} };
let mf, raw, db, env, calls, providerBehavior, failSql, stats, capturedStatements;
const originalFetch = global.fetch;

function resetStats() { stats = { reads: 0, writes: 0, queries: 0 }; }
function account(result) {
  stats.reads += result.meta?.rows_read || 0;
  stats.writes += result.meta?.rows_written || 0;
  stats.queries += 1;
  return result;
}
function wrap(statement, sql) {
  return {
    statement,
    bind(...args) { return wrap(statement.bind(...args), sql); },
    async all() { if (failSql?.(sql)) throw new Error('Injected database failure'); return account(await statement.all()); },
    async run() { if (failSql?.(sql)) throw new Error('Injected database failure'); return account(await statement.run()); },
    async first(column) { if (capturedStatements) { capturedStatements.push(statement); return null; } const result = await this.all(); const row = result.results[0] || null; return column && row ? row[column] : row; },
  };
}
before(async () => {
  // No provider/network passthrough: any unexpected fetch fails this test.
  global.fetch = async (url, options) => {
    assert.ok(['https://api.sendgrid.com/v3/mail/send', 'https://api.telnyx.com/v2/messages'].includes(String(url)),
      `Unexpected network request blocked: ${url}`);
    assert.equal(options.headers.authorization, 'Bearer test-only');
    const call = { url: String(url), body: JSON.parse(options.body), id: `mock-${calls.length}` };
    calls.push(call);
    if (providerBehavior) { const response = await providerBehavior(call); if (response) return response; }
    return call.url.includes('sendgrid')
      ? new Response(null, { status: 202, headers: { 'x-message-id': call.id } })
      : Response.json({ data: { id: call.id, to: [{ status: 'queued', carrier: 'Synthetic carrier' }] } });
  };
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("test only")}}',
    d1Databases: ['DB'], host: '0.0.0.0' });
  raw = await mf.getD1Database('DB');
  for (const file of fs.readdirSync('migrations').filter(x => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join('migrations', file), 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
    await raw.exec(sql);
  }
  db = { prepare(sql) { return wrap(raw.prepare(sql), sql); },
    async batch(statements) { return (await raw.batch(statements.map(s => s.statement))).map(account); } };
  env = { EWS_NOTIFY_DB: db, SENDGRID_API_KEY: 'test-only', SENDGRID_FROM_EMAIL: 'sender@example.invalid',
    TELNYX_API_KEY: 'test-only', TELNYX_NUMBER: '+12025550100', INTERNAL_ALERT_TOKEN: 'test-only',
    NOTIFICATION_HASH_SECRET: 'test-only', NOTIFICATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    EWS_NOTIFICATION_URL: 'https://example.invalid' };
});
after(async () => { global.fetch = originalFetch; await mf?.dispose(); });

async function reset() {
  await raw.exec('DELETE FROM notification_alert_jobs; DELETE FROM notification_deliveries; DELETE FROM notification_alerts; DELETE FROM notification_signups; DELETE FROM notification_inbound_messages; DELETE FROM notification_meta;');
  calls = []; providerBehavior = null; failSql = null; resetStats();
}
async function seed(count, { emailCount = count, smsCount = count, inactive = 0 } = {}) {
  const phone = '+12025550123';
  const phoneCipher = await api.encryptString(env, phone);
  const phoneHash = await api.contactHash(env, 'phone', phone);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const email = `subscriber-${i}@example.invalid`;
    rows.push([`s${String(i).padStart(6, '0')}`, 'active',
      i < emailCount ? await api.encryptString(env, email) : null,
      i < emailCount ? await api.contactHash(env, 'email', email) : null,
      i >= count - smsCount ? phoneCipher : null, i >= count - smsCount ? phoneHash : null,
      i < emailCount ? 1 : 0, i >= count - smsCount ? 1 : 0]);
  }
  for (let i = 0; i < inactive; i++) rows.push([`z${i}`, 'canceled', null, null, null, null, 0, 0]);
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10);
    await raw.prepare(`INSERT INTO notification_signups
      (id,status,email_cipher,email_hash,phone_cipher,phone_hash,wants_email,wants_sms,created_at,updated_at,phone_country)
      VALUES ${chunk.map(() => "(?,?,?,?,?,?,?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','US')").join(',')}`
    ).bind(...chunk.flat()).run();
  }
}
async function finish(id) {
  let batches = 0, maxQueries = 0, maxProviderCalls = 0;
  while (true) {
    const q = stats.queries, c = calls.length;
    const result = await api.processAlertJobBatch(env, id, noSleep);
    maxQueries = Math.max(maxQueries, stats.queries - q);
    maxProviderCalls = Math.max(maxProviderCalls, calls.length - c);
    batches++;
    if (batches % 250 === 0) console.log('Completed synthetic alert batches:', batches);
    if (!result.more) break;
    assert.ok(batches < 2000, 'Campaign must terminate');
  }
  return { batches, maxQueries, maxProviderCalls };
}

test('concurrent triggers, cooldown, lease exclusion, eligibility, and completion', async () => {
  await reset(); await seed(6, { inactive: 3 });
  const [first, second] = await Promise.all([api.maybeSendLevel5Notifications(env, snapshot), api.maybeSendLevel5Notifications(env, snapshot)]);
  assert.equal(first.alertId, second.alertId);
  assert.equal(calls.length, 0, 'Trigger only persists the job');
  assert.equal((await raw.prepare('SELECT COUNT(*) n FROM notification_alerts').first()).n, 1);
  await raw.prepare("UPDATE notification_alert_jobs SET lease_until = ?").bind(Math.floor(Date.now()/1000) + 100).run();
  assert.equal((await api.processAlertJobBatch(env, first.alertId, noSleep)).retryAfter, 60);
  assert.equal(calls.length, 0);
  await raw.exec('UPDATE notification_alert_jobs SET lease_until = 0;');
  assert.equal((await api.maybeSendLevel5Notifications(env, {current:{emergencyLevel:1}})).resumed, true);
  await finish(first.alertId);
  assert.equal(calls.length, 12);
  const job = await api.getAlertJobStatus(env);
  assert.equal(job.status, 'complete'); assert.equal(job.subscriber_count, 6);
  assert.equal(job.email_sent_count, 6); assert.equal(job.sms_sent_count, 6);
  assert.equal((await api.maybeSendLevel5Notifications(env, snapshot)).reason, 'cooldown_active');
  await api.processAlertJobBatch(env, first.alertId, noSleep);
  assert.equal(calls.length, 12);
});

test('rate limits retry safely; ambiguous responses are not resent', async () => {
  await reset(); await seed(2, {smsCount:0});
  providerBehavior = (call) => {
    if (call.body.personalizations[0].to[0].email === 'subscriber-0@example.invalid') {
      if (calls.filter(c=>c.body.personalizations?.[0]?.to?.[0]?.email === 'subscriber-0@example.invalid').length === 1) return new Response('rate limited', {status:429});
    } else throw new Error('Connection lost after provider may have accepted');
  };
  const {alertId} = await api.maybeSendLevel5Notifications(env, snapshot);
  await finish(alertId);
  assert.equal(calls.length, 3);
  const deliveries = (await raw.prepare('SELECT status,attempt_count FROM notification_deliveries ORDER BY subscriber_id').all()).results;
  assert.deepEqual(deliveries, [{status:'sent',attempt_count:2},{status:'unknown',attempt_count:1}]);
  assert.equal((await api.getAlertJobStatus(env)).error_count, 1);
});

test('crash after provider accepts resumes remaining recipients without duplicates', async () => {
  await reset(); await seed(2, {smsCount:0});
  const {alertId} = await api.maybeSendLevel5Notifications(env, snapshot);
  let injected = false;
  failSql = (sql) => {
    if (!injected && sql.includes("SET status = 'sent'")) { injected = true; return true; }
    return false;
  };
  await assert.rejects(api.processAlertJobBatch(env, alertId, noSleep), /Injected/);
  assert.equal(calls.length, 2);
  await raw.exec('UPDATE notification_alert_jobs SET lease_until = 0;');
  await finish(alertId);
  assert.equal(calls.length, 2);
  assert.equal((await api.getAlertJobStatus(env)).error_count, 1);
});

test('terminal callbacks are idempotent, do not regress, and maintain counters', async () => {
  await reset(); await seed(1);
  const {alertId} = await api.maybeSendLevel5Notifications(env, snapshot); await finish(alertId);
  const id = calls.find(c => c.url.includes('telnyx')).id;
  await api.updateDeliveryByProviderMessageId(env, id, {status:'undelivered',providerStatus:'delivery_failed'});
  let job = await api.getAlertJobStatus(env); assert.equal(job.sms_sent_count,0);assert.equal(job.error_count,1);
  resetStats();
  await api.updateDeliveryByProviderMessageId(env, id, {status:'undelivered',providerStatus:'delivery_failed'});
  assert.equal(stats.writes,0);
  await api.updateDeliveryByProviderMessageId(env, id, {status:'sent',providerStatus:'sent'});
  assert.equal(stats.writes,0);
  await api.updateDeliveryByProviderMessageId(env, id, {status:'delivered',providerStatus:'delivered'});
  job = await api.getAlertJobStatus(env); assert.equal(job.sms_sent_count,1);assert.equal(job.error_count,0);
});

test('dispatcher enqueue recovery and API authentication never send a provider message', async () => {
  await reset(); await seed(1);
  const {alertId} = await api.maybeSendLevel5Notifications(env, snapshot);
  const messages = [];
  const dispatchEnv = {...env,EWS_ALERT_QUEUE:{send:async (body)=>messages.push(body)}};
  await api.dispatcher.scheduled(null,dispatchEnv);
  await api.dispatcher.scheduled(null,dispatchEnv);
  assert.deepEqual(messages,[{alertId}]);
  const response = await api.batchEndpoint({env,request:new Request('https://example.invalid/api/internal/alert-jobs',
    {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({alertId})})});
  assert.equal(response.status,401);assert.equal(calls.length,0);
});

test('partial search scans bounded chunks and retains all matching contacts', async () => {
  await reset(); await seed(61, {smsCount:0,inactive:100});
  let cursor='', ids=[];
  do {
    const result=await api.getAdminSubscriberRecords(env,{emailSearch:'subscriber-',searchCursor:cursor});
    assert.ok(result.subscribers.length<=25);
    ids.push(...result.subscribers.map(s=>s.id)); cursor=result.nextSearchCursor;
  } while(cursor);
  assert.equal(ids.length,61);assert.equal(new Set(ids).size,61);
});

test('imported encryption keys remain isolated when environments change', async () => {
  const other={...env,NOTIFICATION_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),NOTIFICATION_HASH_SECRET:'other-test'};
  const one=await api.encryptString(env,'one'), two=await api.encryptString(other,'two');
  assert.equal(await api.decryptString(env,one),'one');assert.equal(await api.decryptString(other,two),'two');
  assert.notEqual(await api.contactHash(env,'email','x'),await api.contactHash(other,'email','x'));
});

test('dispatcher acknowledges only after continuation is durable and retries failures', async () => {
  await reset();
  const providerStub=global.fetch;
  const sent=[];let acked=0,retried=0;
  const message={body:{alertId:'synthetic'},ack:()=>acked++,retry:()=>retried++};
  const dispatchEnv={...env,EWS_ALERT_ORIGIN:'https://example.invalid',EWS_ALERT_QUEUE:{send:async(body)=>sent.push(body)}};
  try {
    global.fetch=async(url,options)=>{
      assert.equal(url,'https://example.invalid/api/internal/alert-jobs');
      assert.equal(options.headers.authorization,'Bearer test-only');
      return Response.json({ok:true,more:true});
    };
    await api.dispatcher.queue({messages:[message]},dispatchEnv);
    assert.equal(acked,1);assert.equal(sent.length,1);
    dispatchEnv.EWS_ALERT_QUEUE.send=async()=>{throw new Error('Synthetic queue outage');};
    await api.dispatcher.queue({messages:[message]},dispatchEnv);
    assert.equal(acked,1);assert.equal(retried,1);
  } finally { global.fetch=providerStub; }
  assert.equal(calls.length,0);
});

test('opt-outs between a rejected send and retry are honored', async () => {
  await reset();await seed(1,{smsCount:0});
  providerBehavior=()=>new Response('rate limited',{status:429});
  const {alertId}=await api.maybeSendLevel5Notifications(env,snapshot);
  await api.processAlertJobBatch(env,alertId,noSleep);
  await raw.exec("UPDATE notification_signups SET wants_email = 0;");
  await finish(alertId);
  assert.equal(calls.length,1);
  assert.equal((await api.getAlertJobStatus(env)).error_count,1);
});

test('legacy unconfirmed deliveries cannot make error counters negative', async () => {
  await reset();
  const alertId=await api.createAlertRecord(env,{kind:'admin_test_single',source:'test',messageText:'synthetic',status:'sent'});
  await api.recordDelivery(env,{alertId,channel:'sms',status:'unconfirmed',providerMessageId:'legacy-synthetic'});
  await api.updateDeliveryByProviderMessageId(env,'legacy-synthetic',{status:'delivered',providerStatus:'delivered'});
  const alert=await raw.prepare('SELECT error_count,sms_sent_count FROM notification_alerts WHERE id = ?').bind(alertId).first();
  assert.equal(alert.error_count,0);assert.equal(alert.sms_sent_count,1);assert.equal(calls.length,0);
});

test('full production-sized simulation stays inside free read/write and per-invocation budgets', {timeout:900_000}, async () => {
  await reset();
  await seed(5327, {emailCount:5056,smsCount:5054,inactive:14389});
  resetStats();
  const {alertId} = await api.maybeSendLevel5Notifications(env,snapshot);
  const batchMetrics = await finish(alertId);
  assert.equal(calls.length,10110);
  const smsCalls = calls.filter(c=>c.url.includes('telnyx'));
  // Replay the exact callback SQL produced by the application in local D1
  // batches. This avoids tens of thousands of test-harness RPC round trips;
  // individual callback behavior and return values are tested separately above.
  capturedStatements=[];
  for (let i=0;i<smsCalls.length;i++) {
    const id=smsCalls[i].id;
    await api.updateDeliveryByProviderMessageId(env,id,{status:'sent',providerStatus:'sent'});
    const final=i%100===0 ? {status:'undelivered',providerStatus:'delivery_failed'} : {status:'delivered',providerStatus:'delivered'};
    await api.updateDeliveryByProviderMessageId(env,id,final);
    await api.updateDeliveryByProviderMessageId(env,id,final);
    await api.updateDeliveryByProviderMessageId(env,id,{status:'sent',providerStatus:'sent'});
  }
  const callbacks=capturedStatements;capturedStatements=null;
  for(let i=0;i<callbacks.length;i+=40) (await raw.batch(callbacks.slice(i,i+40))).forEach(account);
  const campaign = {...stats,...batchMetrics, queueOperationsEstimate:(batchMetrics.batches+1)*3};
  console.log('FULL_ALERT_METRICS', JSON.stringify(campaign));
  assert.ok(campaign.reads<500_000, `Read headroom: ${campaign.reads}`);
  assert.ok(campaign.writes<90_000, `Write headroom: ${campaign.writes}`);
  assert.ok(campaign.maxQueries<50); assert.ok(campaign.maxProviderCalls<50);
  assert.ok(campaign.queueOperationsEstimate<5000);
  const job=await api.getAlertJobStatus(env);assert.equal(job.email_sent_count,5056);
  assert.equal(job.sms_sent_count,5003);assert.equal(job.error_count,51);

  resetStats();
  const exact=await api.getAdminSubscriberRecords(env,{emailSearch:'subscriber-500@example.invalid',exactSearch:true});
  assert.equal(exact.total,1);assert.equal(exact.subscribers[0].id,'s000500');
  const exactMetrics={...stats};assert.ok(stats.reads<100);
  resetStats();
  const history=await api.getAdminSubscriberMessageHistory(env,'s000500');
  assert.ok(history.messages.length>0);
  // Synthetic users share a phone; use email-only subscriber for isolated history.
  resetStats();await api.getAdminSubscriberMessageHistory(env,'s000001');const historyMetrics={...stats};
  assert.ok(stats.reads<50);
  resetStats();await api.getAdminSubscriberMessageHistory(env,'s000001');assert.equal(stats.writes,0);
  resetStats();const list=await api.getAdminSubscriberRecords(env,{page:2,pageSize:20,includeStats:false});
  assert.equal(list.subscribers.length,20);assert.equal(list.summary,undefined);
  const pageMetrics={...stats};assert.ok(stats.reads<1000);
  console.log('ADMIN_METRICS',JSON.stringify({exact:exactMetrics,history:historyMetrics,pageWithoutRepeatedStats:pageMetrics}));
});
