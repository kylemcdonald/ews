import {
  createManualSubscriber,
  hydrateSubscriberContacts,
} from "../../_lib/db.js";
import { createAccountManagementPath } from "../../_lib/customer-portal.js";
import { handleError, HttpError, jsonResponse, getRequestIp, getRequestUserAgent, readJsonRequest } from "../../_lib/http.js";
import { sendSignupConfirmationToSubscriber } from "../../_lib/notifications.js";

async function mapSubscriberResult(env, subscriber) {
  const hydrated = subscriber.email_cipher || subscriber.account_email_cipher ? await hydrateSubscriberContacts(env, subscriber) : subscriber;
  const managementUrl = await createAccountManagementPath(env, hydrated);
  return {
    id: hydrated.id,
    status: hydrated.status,
    source: hydrated.source,
    accountEmail: hydrated.accountEmail,
    email: hydrated.email,
    phone: hydrated.phone,
    wantsEmail: hydrated.wantsEmail,
    wantsSms: hydrated.wantsSms,
    managementUrl,
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);
    const action = String(payload.action || "").trim();

    if (action === "create_manual") {
      const subscriber = await createManualSubscriber(env, payload, {
        ip: getRequestIp(request),
        userAgent: getRequestUserAgent(request),
      });
      const signupConfirmation = await sendSignupConfirmationToSubscriber(env, subscriber.id, {
        source: "manual_admin",
        skipAlreadySent: true,
      });
      return jsonResponse({
        ok: true,
        subscriber: await mapSubscriberResult(env, subscriber),
        signupConfirmation,
      });
    }

    throw new HttpError(400, "Unknown subscriber admin action.");
  } catch (error) {
    return handleError(error);
  }
}
