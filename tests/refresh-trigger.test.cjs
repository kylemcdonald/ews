const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// The live refresh, and with it the level 5 check, must be triggered every half hour from
// Cloudflare: GitHub's own schedule ran only a few times a day in October 2026. The worker is
// the only scheduler, so no workflow may keep a GitHub schedule of its own.
const compiled = buildSync({ entryPoints: ['workers/refresh-trigger.js'], bundle: true, platform: 'node',
  format: 'cjs', write: false });
const mod = new Module(path.join(process.cwd(), 'tests', 'refresh-trigger.bundled.cjs'));
mod.filename = path.join(process.cwd(), 'tests', 'refresh-trigger.bundled.cjs');
mod._compile(compiled.outputFiles[0].text, mod.filename);
const { default: worker, SCHEDULES, dispatchIfDue, runSchedules, windowStart } = mod.exports;

const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'main', GITHUB_DISPATCH_TOKEN: 'test-token' };
const live = SCHEDULES.find((schedule) => schedule.workflow === 'refresh-live-data.yml');
const daily = SCHEDULES.find((schedule) => schedule.workflow === 'refresh-daily-history.yml');
const workflowsDir = '.github/workflows';
const originalFetch = global.fetch;
let calls, runsByWorkflow;

beforeEach(() => {
  calls = [];
  runsByWorkflow = {};
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body });
    const workflow = String(url).match(/workflows\/([^/]+)\//)[1];
    if (String(url).includes('/runs?')) {
      const created = Date.parse(new URL(url).searchParams.get('created').slice(2));
      const runs = (runsByWorkflow[workflow] || []).filter((run) => (run.created ?? created) >= created);
      return Response.json({ workflow_runs: runs });
    }
    return new Response(null, { status: 204 });
  };
});
after(() => { global.fetch = originalFetch; });

const dispatches = () => calls.filter((call) => call.method === 'POST');
const at = (iso) => Date.parse(iso);

test('live refresh windows start four minutes after each half-hour heatmap boundary', () => {
  assert.equal(windowStart(live, at('2026-10-18T09:05:00Z')).toISOString(), '2026-10-18T09:04:00.000Z');
  assert.equal(windowStart(live, at('2026-10-18T09:20:00Z')).toISOString(), '2026-10-18T09:04:00.000Z');
  assert.equal(windowStart(live, at('2026-10-18T09:35:00Z')).toISOString(), '2026-10-18T09:34:00.000Z');
  assert.equal(windowStart(live, at('2026-10-18T09:02:00Z')).toISOString(), '2026-10-18T08:34:00.000Z');
  assert.equal(windowStart(daily, at('2026-10-18T00:20:00Z')).toISOString(), '2026-10-18T00:20:00.000Z');
  assert.equal(windowStart(daily, at('2026-10-18T00:05:00Z')).toISOString(), '2026-10-17T00:20:00.000Z');
});

test('a day of cron ticks dispatches each live and daily window exactly once', async () => {
  const windows = {};
  for (let minute = 0; minute < 24 * 60; minute += 15) {
    const now = at('2026-10-18T00:05:00Z') + minute * 60 * 1000;
    for (const result of await runSchedules(env, now)) {
      if (!result.dispatched) continue;
      const key = `${result.workflow} ${result.windowStart}`;
      windows[key] = (windows[key] || 0) + 1;
      // The dispatched run succeeds, so later ticks in the same window see it.
      (runsByWorkflow[result.workflow] ||= []).push({ status: 'completed', conclusion: 'success', created: now });
    }
  }
  const count = (workflow) => Object.keys(windows).filter((key) => key.startsWith(workflow)).length;
  assert.ok(Object.values(windows).every((value) => value === 1), JSON.stringify(windows));
  assert.equal(count('refresh-live-data.yml'), 48);
  // The first tick also catches up the previous day's windows, which had no runs.
  assert.equal(count('refresh-daily-history.yml'), 2);
  assert.equal(count('send-renewal-reminders.yml'), 2);
});

test('dispatches the workflow on main when its window has no run yet', async () => {
  const result = await dispatchIfDue(env, live, at('2026-10-18T09:05:00Z'));
  assert.deepEqual(result, { workflow: 'refresh-live-data.yml', windowStart: '2026-10-18T09:04:00.000Z', dispatched: true });
  assert.match(calls[0].url, /\/repos\/owner\/repo\/actions\/workflows\/refresh-live-data\.yml\/runs\?created=%3E%3D2026-10-18T09%3A04%3A00\.000Z/);
  assert.equal(dispatches().length, 1);
  assert.equal(dispatches()[0].url, 'https://api.github.com/repos/owner/repo/actions/workflows/refresh-live-data.yml/dispatches');
  assert.deepEqual(JSON.parse(dispatches()[0].body), { ref: 'main' });
  assert.equal(dispatches()[0].headers.authorization, 'Bearer test-token');
});

test('leaves a window alone when a run is queued, running or already succeeded', async () => {
  for (const run of [{ status: 'queued' }, { status: 'in_progress' }, { status: 'completed', conclusion: 'success' }]) {
    calls = [];
    runsByWorkflow = { 'refresh-live-data.yml': [run] };
    const result = await dispatchIfDue(env, live, at('2026-10-18T09:20:00Z'));
    assert.equal(result.dispatched, false, JSON.stringify(run));
    assert.equal(dispatches().length, 0);
  }
});

test('retries a failed or cancelled run, but only up to the attempt limit', async () => {
  runsByWorkflow = { 'refresh-live-data.yml': [{ status: 'completed', conclusion: 'failure' }] };
  assert.equal((await dispatchIfDue(env, live, at('2026-10-18T09:20:00Z'))).dispatched, true);
  runsByWorkflow = { 'refresh-live-data.yml': [{ status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'cancelled' }] };
  assert.equal((await dispatchIfDue(env, live, at('2026-10-18T09:20:00Z'))).dispatched, false);
});

test('a rejected GitHub token fails the cron invocation instead of passing silently', async () => {
  global.fetch = async () => new Response('Bad credentials', { status: 401 });
  await assert.rejects(worker.scheduled({ scheduledTime: at('2026-10-18T09:05:00Z') }, env), /HTTP 401/);
});

test('the worker is the only scheduler and is deployed with the site', () => {
  const config = fs.readFileSync('wrangler.refresh-trigger.toml', 'utf8');
  assert.match(config, /^main = "workers\/refresh-trigger\.js"$/m);
  assert.match(config, /^crons = \["5,20,35,50 \* \* \* \*"\]$/m);
  for (const name of fs.readdirSync(workflowsDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(workflowsDir, name), 'utf8'), /^\s*schedule:/m, name);
  }
  for (const { workflow } of SCHEDULES) {
    assert.match(fs.readFileSync(path.join(workflowsDir, workflow), 'utf8'), /^  workflow_dispatch:$/m, workflow);
  }
  assert.match(fs.readFileSync(path.join(workflowsDir, 'deploy-pages.yml'), 'utf8'),
    /wrangler deploy --config wrangler\.refresh-trigger\.toml/);
});

test('the daily refresh queues behind the live refresh instead of racing its state upload', () => {
  for (const workflow of ['refresh-live-data.yml', 'refresh-daily-history.yml']) {
    assert.match(fs.readFileSync(path.join(workflowsDir, workflow), 'utf8'),
      /concurrency:\n  group: refresh-live-data\n  cancel-in-progress: false/, workflow);
  }
});
