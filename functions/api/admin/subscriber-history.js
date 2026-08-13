import { getAdminSubscriberMessageHistory } from "../../_lib/db.js";
import { handleError, HttpError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { sendAdminSubscriberEmailReply, sendAdminSubscriberSmsReply } from "../../_lib/notifications.js";

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const subscriberId = String(url.searchParams.get("subscriber") || "").trim();
    if (!subscriberId) {
      throw new HttpError(400, "Enter a subscriber ID.");
    }

    const history = await getAdminSubscriberMessageHistory(env, subscriberId, {
      limit: url.searchParams.get("limit"),
    });
    return jsonResponse(
      {
        ok: true,
        ...history,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);
    const subscriberId = String(payload.subscriber || "").trim();
    if (!subscriberId) {
      throw new HttpError(400, "Enter a subscriber ID.");
    }

    const action = String(payload.action || "send_sms_reply").trim();
    let result = null;
    if (action === "send_sms_reply") {
      result = await sendAdminSubscriberSmsReply(env, subscriberId, payload.message || payload.text);
    } else if (action === "send_email_reply") {
      result = await sendAdminSubscriberEmailReply(env, subscriberId, {
        subject: payload.subject,
        body: payload.body || payload.message || payload.text,
      });
    } else {
      throw new HttpError(400, "Unknown subscriber history action.");
    }

    return jsonResponse(
      {
        ok: true,
        action,
        ...result,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return handleError(error);
  }
}
