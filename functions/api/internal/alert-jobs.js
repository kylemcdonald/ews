import { getAlertJobStatus, processAlertJobBatch } from '../../_lib/alert-jobs.js';
import { requireInternalAuth } from '../../_lib/internal-auth.js';
import { handleError, jsonResponse, readJsonRequest } from '../../_lib/http.js';

export async function onRequestGet({ request, env }) {
  try {
    requireInternalAuth(request, env);
    return jsonResponse({ ok: true, job: await getAlertJobStatus(env) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return handleError(error); }
}

export async function onRequestPost({ request, env }) {
  try {
    requireInternalAuth(request, env);
    const { alertId } = await readJsonRequest(request);
    return jsonResponse(await processAlertJobBatch(env, String(alertId || '')));
  } catch (error) { return handleError(error); }
}
