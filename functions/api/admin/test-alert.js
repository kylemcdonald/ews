import { normalizeEmail, normalizePhone } from "../../_lib/contacts.js";
import { getAdminSubscriberRecords, getRecentAlertDeliveries } from "../../_lib/db.js";
import { handleError, HttpError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { sendAdminSingleTest, sendAdminTestToAll } from "../../_lib/notifications.js";

function getNotificationBaseUrl(env) {
  return String(env.EWS_NOTIFICATION_URL || env.APP_BASE_URL || "https://aews.cc/")
    .trim()
    .replace(/\/+$/, "");
}

function buildDefaultTestSnapshot() {
  return {
    signals: {
      composite: {
        emergencyLevel: 5,
        actualConcurrentCount: 521,
        expectedConcurrentCount: 400,
        asOf: new Date().toISOString(),
      },
    },
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);

    if (payload.mode === "all") {
      const result = await sendAdminTestToAll(env, payload.snapshot || buildDefaultTestSnapshot());
      return jsonResponse(result);
    }

    if (payload.mode === "single") {
      const email = normalizeEmail(payload.email);
      const phone = normalizePhone(payload.phone);
      if (!email && !phone) {
        throw new HttpError(400, "Enter an email address, a phone number, or both.");
      }

      const result = await sendAdminSingleTest(env, { email, phone });
      return jsonResponse(result);
    }

    throw new HttpError(400, "Unknown test mode.");
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
