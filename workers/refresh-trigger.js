// The only scheduler for this repository's GitHub workflows. GitHub's own schedule ran the
// half-hour live refresh (and with it the level 5 check) only a few times a day in October 2026
// and started the daily job hours late, so every workflow is dispatched from this cron instead.
// Each schedule has repeating windows; a window that already has a live or successful run is
// left alone, and a failed or lost run is retried on later ticks up to maxAttempts.
const MINUTE_MS = 60 * 1000;

export const SCHEDULES = [
  // Four minutes after each half-hour heatmap boundary.
  { workflow: 'refresh-live-data.yml', everyMinutes: 30, offsetMinutes: 4, maxAttempts: 2 },
  { workflow: 'refresh-daily-history.yml', everyMinutes: 24 * 60, offsetMinutes: 20, maxAttempts: 3 },
  { workflow: 'send-renewal-reminders.yml', everyMinutes: 24 * 60, offsetMinutes: 17 * 60 + 5, maxAttempts: 3 },
];

export function windowStart(schedule, now) {
  const every = schedule.everyMinutes * MINUTE_MS;
  const offset = schedule.offsetMinutes * MINUTE_MS;
  return new Date(Math.floor((now - offset) / every) * every + offset);
}

async function github(env, workflow, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      'user-agent': 'ews-refresh-trigger',
      'x-github-api-version': '2022-11-28',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${init.method || 'GET'} ${workflow}${path} returned HTTP ${response.status}`);
  return response;
}

export async function dispatchIfDue(env, schedule, now = Date.now()) {
  const start = windowStart(schedule, now).toISOString();
  const query = new URLSearchParams({ created: `>=${start}`, per_page: '20' });
  const { workflow_runs: runs = [] } = await (await github(env, schedule.workflow, `/runs?${query}`)).json();
  const covered = runs.some((run) => run.status !== 'completed' || run.conclusion === 'success');
  if (covered || runs.length >= schedule.maxAttempts) {
    return { workflow: schedule.workflow, windowStart: start, dispatched: false };
  }
  await github(env, schedule.workflow, '/dispatches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main' }),
  });
  return { workflow: schedule.workflow, windowStart: start, dispatched: true };
}

export async function runSchedules(env, now = Date.now()) {
  const settled = await Promise.allSettled(SCHEDULES.map((schedule) => dispatchIfDue(env, schedule, now)));
  for (const result of settled) console.log(JSON.stringify(result.value ?? { error: result.reason.message }));
  const failures = settled.filter((result) => result.status === 'rejected');
  if (failures.length) throw new Error(failures.map((result) => result.reason.message).join('; '));
  return settled.map((result) => result.value);
}

export default {
  async scheduled(controller, env) {
    await runSchedules(env, controller.scheduledTime);
  },

  async fetch() {
    return new Response('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
};
