// GitHub's own schedule for refresh-live-data.yml fell to a few runs a day in October 2026,
// which also meant the level 5 check ran only that often. This cron dispatches the workflow
// every half hour instead. Each refresh window starts four minutes after a half-hour heatmap
// boundary, and a window that already has a live or successful run is left alone, so the
// :20/:50 retry and a late GitHub-scheduled run do not pile up duplicate refreshes.
const WORKFLOW = 'refresh-live-data.yml';
const WINDOW_MS = 30 * 60 * 1000;
const WINDOW_OFFSET_MS = 4 * 60 * 1000;

export function refreshWindowStart(now) {
  return new Date(Math.floor((now - WINDOW_OFFSET_MS) / WINDOW_MS) * WINDOW_MS + WINDOW_OFFSET_MS);
}

async function github(env, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      'user-agent': 'ews-refresh-trigger',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} returned HTTP ${response.status}`);
  return response;
}

export async function dispatchRefreshIfDue(env, now = Date.now()) {
  const windowStart = refreshWindowStart(now).toISOString();
  const query = new URLSearchParams({ created: `>=${windowStart}`, per_page: '20' });
  const { workflow_runs: runs = [] } = await (await github(env, `/runs?${query}`)).json();
  if (runs.some((run) => run.status !== 'completed' || run.conclusion === 'success')) {
    return { dispatched: false, windowStart };
  }
  await github(env, '/dispatches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main' }),
  });
  return { dispatched: true, windowStart };
}

export default {
  async scheduled(_controller, env) {
    const result = await dispatchRefreshIfDue(env);
    console.log(JSON.stringify(result));
  },

  async fetch() {
    return new Response('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
};
