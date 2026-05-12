import { normalizePhone } from "../../_lib/contacts.js";
import { updateDeliveryByProviderMessageId, updateSmsPreferenceByPhoneHash } from "../../_lib/db.js";
import { handleError, HttpError } from "../../_lib/http.js";
import {
  classifyInboundSms,
  getTelnyxDeliveryError,
  hasTelnyxWebhookVerificationKey,
  normalizeTelnyxMessageStatus,
  sendInboundSmsReply,
  telnyxWebhookResponse,
  updateSmsPreferenceFromInbound,
  verifyTelnyxWebhook,
} from "../../_lib/telnyx.js";

function parseTelnyxEvent(rawBody) {
  try {
    const event = JSON.parse(rawBody);
    if (!event?.data?.event_type) {
      throw new Error("missing event_type");
    }
    return event;
  } catch {
    throw new HttpError(400, "Telnyx webhook payload is not valid JSON.");
  }
}

async function handleInboundMessage(env, payload) {
  const phone = normalizePhone(payload.from?.phone_number);
  if (!phone) {
    throw new HttpError(400, "Telnyx inbound message is missing a sender phone number.");
  }

  const action = classifyInboundSms(payload.text);
  const updatedCount = await updateSmsPreferenceFromInbound({
    env,
    phone,
    action,
    updateSmsPreferenceByPhoneHash,
  });

  if (action === "stop") {
    await sendInboundSmsReply(
      env,
      phone,
      "You have been unsubscribed from Apocalypse EWS SMS alerts. Reply START to resubscribe.",
    );
  } else if (action === "start") {
    await sendInboundSmsReply(env, phone, "You are subscribed to Apocalypse EWS SMS alerts. Reply STOP to unsubscribe.");
  } else {
    await sendInboundSmsReply(
      env,
      phone,
      "Apocalypse EWS alerts are event-driven. Reply STOP to unsubscribe or HELP for help.",
    );
  }

  return {
    action,
    updatedCount,
  };
}

async function handleOutboundStatus(env, eventType, payload) {
  const messageId = payload.id || null;
  const status = normalizeTelnyxMessageStatus(eventType, payload);
  const error = getTelnyxDeliveryError(payload);
  const alertId = await updateDeliveryByProviderMessageId(env, messageId, {
    status,
    error,
  });

  return {
    messageId,
    status,
    updated: Boolean(alertId),
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const rawBody = await request.text();
    if (!hasTelnyxWebhookVerificationKey(env)) {
      return telnyxWebhookResponse({ ignored: true, reason: "missing_telnyx_public_key" });
    }

    await verifyTelnyxWebhook(request, env, rawBody);

    const event = parseTelnyxEvent(rawBody);
    const eventType = event.data.event_type;
    const payload = event.data.payload || {};
    if (eventType === "message.received") {
      const result = await handleInboundMessage(env, payload);
      return telnyxWebhookResponse({ eventType, ...result });
    }

    if (eventType === "message.sent" || eventType === "message.finalized") {
      const result = await handleOutboundStatus(env, eventType, payload);
      return telnyxWebhookResponse({ eventType, ...result });
    }

    return telnyxWebhookResponse({ eventType, ignored: true });
  } catch (error) {
    return handleError(error);
  }
}
