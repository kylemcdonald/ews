import { normalizeEmail, normalizePhone } from "../../_lib/contacts.js";
import { getAdminSubscriberRecords, getRecentAlertDeliveries } from "../../_lib/db.js";
import { handleError, HttpError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { sendAdminSingleTest } from "../../_lib/notifications.js";

function getNotificationBaseUrl(env) {
  return String(env.EWS_NOTIFICATION_URL || env.APP_BASE_URL || "https://aews.cc/")
    .trim()
    .replace(/\/+$/, "");
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);
    const email = normalizeEmail(payload.email);
    const phone = normalizePhone(payload.phone);

    if (!email && !phone) {
      throw new HttpError(400, "Enter an email address, a phone number, or both.");
    }

    const result = await sendAdminSingleTest(env, { email, phone });
    return jsonResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("view") === "subscribers") {
      const subscriberRecords = await getAdminSubscriberRecords(env, {
        page: url.searchParams.get("page"),
        pageSize: url.searchParams.get("pageSize"),
        emailSearch: url.searchParams.get("emailSearch") || url.searchParams.get("search"),
        managementBaseUrl: getNotificationBaseUrl(env),
      });
      return jsonResponse(
        {
          ok: true,
          ...subscriberRecords,
        },
        {
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }

    const limit = Number(url.searchParams.get("limit") || 25);
    const deliveries = await getRecentAlertDeliveries(env, limit);
    return jsonResponse(
      { ok: true, deliveries },
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
