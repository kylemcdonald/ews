import { requireAccessAuth } from "../../_lib/access-auth.js";
import { handleError } from "../../_lib/http.js";

// Runs before every /api/admin/* handler. Fails closed: any verification error
// returns a response and the handler never runs.
export async function onRequest(context) {
  try {
    await requireAccessAuth(context.request);
  } catch (error) {
    return handleError(error);
  }
  return context.next();
}
