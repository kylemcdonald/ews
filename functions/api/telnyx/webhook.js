import { normalizePhone } from "../../_lib/contacts.js";
import {
  markStripeSubscriptionCancelAtPeriodEnd,
  optOutSmsByPhoneHash,
  recordInboundSmsMessage,
  updateDeliveryByProviderMessageId,
  updateSmsPreferenceByPhoneHash,
} from "../../_lib/db.js";
import { contactHash } from "../../_lib/crypto.js";
import { handleError, HttpError } from "../../_lib/http.js";
import { updateStripeSubscriptionCancelAtPeriodEnd } from "../../_lib/stripe.js";
import {
  classifyInboundSms,
  getTelnyxProviderMessageStatus,
  getTelnyxDeliveryError,
  hasTelnyxWebhookVerificationKey,
  normalizeTelnyxMessageStatus,
  telnyxWebhookResponse,
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

async function handleInboundMessage(env, event, payload) {
  const phone = normalizePhone(payload.from?.phone_number);
  if (!phone) {
    throw new HttpError(400, "Telnyx inbound message is missing a sender phone number.");
  }

  const action = classifyInboundSms(payload.text);
  const inboundMessage = await recordInboundSmsMessage(env, {
    provider: "telnyx",
    providerMessageId: payload.id,
    providerEventId: event.data?.id,
    fromPhone: phone,
    toPhone: payload.to?.[0]?.phone_number,
    text: payload.text,
    action,
    status: payload.from?.status || payload.status || "received",
    receivedAt: payload.received_at || payload.created_at || event.data?.occurred_at,
    metadata: {
      eventType: event.data?.event_type,
      messageType: payload.type || null,
      mediaCount: Array.isArray(payload.media) ? payload.media.length : 0,
      messagingProfileId: payload.messaging_profile_id || null,
    },
  });
  let updatedCount = 0;
  let cancelAtPeriodEndCount = 0;
  let stripeErrorCount = 0;
  if (action === "stop") {
    const phoneHash = await contactHash(env, "phone", phone);
    const affectedSubscribers = await optOutSmsByPhoneHash(env, phoneHash, "sms_stop");
    updatedCount = affectedSubscribers.length;
    const subscriptionIds = Array.from(
      new Set(affectedSubscribers.map((subscriber) => subscriber.stripe_subscription_id).filter(Boolean)),
    );
    for (const subscriptionId of subscriptionIds) {
      try {
        await updateStripeSubscriptionCancelAtPeriodEnd(env, subscriptionId, true);
        await markStripeSubscriptionCancelAtPeriodEnd(env, subscriptionId, true);
        cancelAtPeriodEndCount += 1;
      } catch {
        stripeErrorCount += 1;
      }
    }
    if (stripeErrorCount > 0) {
      throw new HttpError(502, "Failed to schedule one or more Stripe subscriptions for cancellation.");
    }
  } else if (action === "start") {
    const phoneHash = await contactHash(env, "phone", phone);
    updatedCount = await updateSmsPreferenceByPhoneHash(env, phoneHash, true);
  }

  return {
    action,
    inboundMessage,
    updatedCount,
    cancelAtPeriodEndCount,
    stripeErrorCount,
  };
}

async function handleOutboundStatus(env, eventType, payload) {
  const messageId = payload.id || null;
  const providerStatus = getTelnyxProviderMessageStatus(payload);
  const status = normalizeTelnyxMessageStatus(eventType, payload);
  const error = getTelnyxDeliveryError(payload);
  const deliveryUpdate = await updateDeliveryByProviderMessageId(env, messageId, {
    status,
    providerStatus,
    error,
  });

  return {
    messageId,
    status,
    updated: Boolean(deliveryUpdate),
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
      const result = await handleInboundMessage(env, event, payload);
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
