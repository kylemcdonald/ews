import { anonymizeExpiredPendingSignups } from "../../_lib/db.js";
import { handleError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { requireInternalAuth } from "../../_lib/internal-auth.js";
import { maybeSendLevel5Notifications } from "../../_lib/alert-jobs.js";

export async function onRequestPost({ request, env }) {
  try {
    requireInternalAuth(request, env);
    await anonymizeExpiredPendingSignups(env);
    const snapshot = await readJsonRequest(request);
    const result = await maybeSendLevel5Notifications(env, snapshot, {
      source: "github_actions_refresh",
    });

    return jsonResponse(result);
  } catch (error) {
    return handleError(error);
  }
}
