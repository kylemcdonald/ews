const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

// The live refresh, and with it the level 5 check, must be triggered every half hour from
// Cloudflare: GitHub's own schedule ran only a few times a day in October 2026.
const compiled = buildSync({ entryPoints: ['workers/refresh-trigger.js'], bundle: true, platform: 'node',
  format: 'cjs', write: false });
const mod = new Module(path.join(process.cwd(), 'tests', 'refresh-trigger.bundled.cjs'));
mod.filename = path.join(process.cwd(), 'tests', 'refresh-trigger.bundled.cjs');
mod._compile(compiled.outputFiles[0].text, mod.filename);
const { default: worker, dispatchRefreshIfDue, refreshWindowStart } = mod.exports;

const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'main', GITHUB_DISPATCH_TOKEN: 'test-token' };
const originalFetch = global.fetch;
let calls, existingRuns;

beforeEach(() => {
  calls = [];
  existingRuns = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body });
    if (String(url).includes('/runs?')) return Response.json({ workflow_runs: existingRuns });
    return new Response(null, { status: 204 });
  };
});
after(() => { global.fetch = originalFetch; });

const dispatches = () => calls.filter((call) => call.method === 'POST');

test('refresh windows start four minutes after each half-hour heatmap boundary', () => {
  assert.equal(refreshWindowStart(Date.parse('2026-10-18T09:05:00Z')).toISOString(), '2026-10-18T09:04:00.000Z');
  assert.equal(refreshWindowStart(Date.parse('2026-10-18T09:20:00Z')).toISOString(), '2026-10-18T09:04:00.000Z');
  assert.equal(refreshWindowStart(Date.parse('2026-10-18T09:35:00Z')).toISOString(), '2026-10-18T09:34:00.000Z');
  assert.equal(refreshWindowStart(Date.parse('2026-10-18T09:02:00Z')).toISOString(), '2026-10-18T08:34:00.000Z');
});

test('dispatches the live refresh on main when the window has no run yet', async () => {
  const result = await dispatchRefreshIfDue(env, Date.parse('2026-10-18T09:05:00Z'));
  assert.deepEqual(result, { dispatched: true, windowStart: '2026-10-18T09:04:00.000Z' });
  assert.match(calls[0].url, /\/repos\/owner\/repo\/actions\/workflows\/refresh-live-data\.yml\/runs\?created=%3E%3D2026-10-18T09%3A04%3A00\.000Z/);
  assert.equal(dispatches().length, 1);
  assert.equal(dispatches()[0].url, 'https://api.github.com/repos/owner/repo/actions/workflows/refresh-live-data.yml/dispatches');
  assert.deepEqual(JSON.parse(dispatches()[0].body), { ref: 'main' });
  assert.equal(dispatches()[0].headers.authorization, 'Bearer test-token');
});

test('leaves a window alone when a run is queued, running or already succeeded', async () => {
  for (const run of [{ status: 'queued' }, { status: 'in_progress' }, { status: 'completed', conclusion: 'success' }]) {
    calls = [];
    existingRuns = [run];
    const result = await dispatchRefreshIfDue(env, Date.parse('2026-10-18T09:20:00Z'));
    assert.equal(result.dispatched, false, JSON.stringify(run));
    assert.equal(dispatches().length, 0);
  }
});

test('retries a window whose only run failed or was cancelled', async () => {
  existingRuns = [{ status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'cancelled' }];
  const result = await dispatchRefreshIfDue(env, Date.parse('2026-10-18T09:20:00Z'));
  assert.equal(result.dispatched, true);
  assert.equal(dispatches().length, 1);
});

test('a rejected GitHub token fails the cron invocation instead of passing silently', async () => {
  global.fetch = async () => new Response('Bad credentials', { status: 401 });
  await assert.rejects(worker.scheduled({}, env), /HTTP 401/);
});

test('the trigger cron fires at :05 and :35 with a retry before the next refresh', () => {
  const config = fs.readFileSync('wrangler.refresh-trigger.toml', 'utf8');
  assert.match(config, /^main = "workers\/refresh-trigger\.js"$/m);
  assert.match(config, /^crons = \["5,20,35,50 \* \* \* \*"\]$/m);
  assert.match(fs.readFileSync('.github/workflows/refresh-live-data.yml', 'utf8'), /^  workflow_dispatch:$/m);
  assert.match(fs.readFileSync('.github/workflows/deploy-pages.yml', 'utf8'),
    /wrangler deploy --config wrangler\.refresh-trigger\.toml/);
});
