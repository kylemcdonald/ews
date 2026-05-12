import { HttpError } from "./http.js";
import { getTelnyxWebhookFailoverUrl, getTelnyxWebhookUrl, telnyxJson } from "./telnyx.js";

const NANP_TOLL_FREE_AREA_CODES = new Set(["800", "833", "844", "855", "866", "877", "888"]);

function maskPhone(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  return text.replace(/\d(?=\d{2})/g, "x");
}

function maskId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function getNanpAreaCode(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1, 4);
  }

  return digits.slice(0, 3);
}

function isTollFreePhone(phone) {
  return NANP_TOLL_FREE_AREA_CODES.has(getNanpAreaCode(phone));
}

function getConfiguredFromNumber(env) {
  return String(env.TELNYX_FROM_PHONE || env.TELNYX_NUMBER || "").trim();
}

function getConfiguredProfileId(env) {
  return String(env.TELNYX_MESSAGING_PROFILE_ID || "").trim();
}

function isSmsCapable(features = {}) {
  return Boolean(features.domestic_two_way || features.international_inbound || features.international_outbound);
}

async function getConfiguredSender(env, fromPhone) {
  const sender = {
    configured: Boolean(fromPhone),
    number: maskPhone(fromPhone),
    foundInAccount: false,
    messagingProfileId: null,
    countryCode: null,
    type: null,
    smsCapable: false,
    mmsCapable: false,
    domesticTwoWaySms: false,
    internationalOutboundSms: false,
    isTollFree: isTollFreePhone(fromPhone),
  };

  if (!fromPhone) {
    return sender;
  }

  try {
    const payload = await telnyxJson(env, `/messaging_phone_numbers/${encodeURIComponent(fromPhone)}`);
    const number = payload.data || null;
    const smsFeatures = number?.features?.sms || {};
    const mmsFeatures = number?.features?.mms || {};
    return {
      ...sender,
      foundInAccount: Boolean(number),
      messagingProfileId: number?.messaging_profile_id || null,
      countryCode: number?.country_code || null,
      type: number?.type || null,
      smsCapable: isSmsCapable(smsFeatures),
      mmsCapable: isSmsCapable(mmsFeatures),
      domesticTwoWaySms: Boolean(smsFeatures.domestic_two_way),
      internationalOutboundSms: Boolean(smsFeatures.international_outbound),
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return sender;
    }

    throw error;
  }
}

async function getMessagingProfile(env, profileId) {
  const profile = {
    configured: Boolean(profileId),
    id: maskId(profileId),
    foundInAccount: false,
    status: profileId ? "not_found" : "not_configured",
    name: null,
    enabled: null,
    webhookUrl: null,
    webhookFailoverUrl: null,
    webhookApiVersion: null,
    whitelistedDestinations: [],
  };

  if (!profileId) {
    return profile;
  }

  try {
    const payload = await telnyxJson(env, `/messaging_profiles/${encodeURIComponent(profileId)}`);
    const data = payload.data || null;
    return {
      ...profile,
      foundInAccount: Boolean(data),
      status: data?.enabled === false ? "disabled" : "configured",
      name: data?.name || null,
      enabled: data?.enabled ?? null,
      webhookUrl: data?.webhook_url || null,
      webhookFailoverUrl: data?.webhook_failover_url || null,
      webhookApiVersion: data?.webhook_api_version || null,
      whitelistedDestinations: Array.isArray(data?.whitelisted_destinations) ? data.whitelisted_destinations : [],
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return profile;
    }

    throw error;
  }
}

function buildBlockingIssue({ sender, messagingProfile, sendMethod }) {
  if (sendMethod === "unconfigured") {
    return "No TELNYX_NUMBER sender or TELNYX_MESSAGING_PROFILE_ID is configured.";
  }

  if (sender.configured && !sender.foundInAccount) {
    return "Configured TELNYX_NUMBER was not found in this Telnyx account.";
  }

  if (sender.configured && !sender.smsCapable) {
    return "Configured TELNYX_NUMBER is not SMS capable.";
  }

  if (sender.configured && !sender.messagingProfileId) {
    return "Configured TELNYX_NUMBER is not assigned to a messaging profile.";
  }

  if (messagingProfile.configured && !messagingProfile.foundInAccount) {
    return "Configured Telnyx messaging profile was not found in this account.";
  }

  if (messagingProfile.enabled === false) {
    return "Configured Telnyx messaging profile is disabled.";
  }

  return null;
}

function buildWebhookWarning(env, messagingProfile) {
  if (!String(env.TELNYX_PUBLIC_KEY || "").trim()) {
    return "TELNYX_PUBLIC_KEY is not configured; Telnyx webhooks will be acknowledged but ignored until it is added.";
  }

  if (messagingProfile.configured && messagingProfile.webhookApiVersion && messagingProfile.webhookApiVersion !== "2") {
    return "Telnyx messaging profile webhooks are not set to API version 2.";
  }

  return null;
}

export async function getMessagingStatus(env) {
  const apiKey = String(env.TELNYX_API_KEY || "").trim();
  if (!apiKey) {
    throw new HttpError(500, "Telnyx API key is not configured.");
  }

  const fromPhone = getConfiguredFromNumber(env);
  const configuredProfileId = getConfiguredProfileId(env);
  const sendMethod = fromPhone ? "from_phone" : configuredProfileId ? "messaging_profile" : "unconfigured";
  const sender = await getConfiguredSender(env, fromPhone);
  const profileId = configuredProfileId || sender.messagingProfileId || "";
  const messagingProfile = await getMessagingProfile(env, profileId);
  const blockingIssue = buildBlockingIssue({ sender, messagingProfile, sendMethod });

  return {
    ok: true,
    provider: "telnyx",
    checkedAt: new Date().toISOString(),
    sendMethod,
    readyForSms: !blockingIssue,
    blockingIssue,
    webhookWarning: buildWebhookWarning(env, messagingProfile),
    webhooks: {
      url: getTelnyxWebhookUrl(env),
      failoverUrl: getTelnyxWebhookFailoverUrl(env),
      publicKeyConfigured: Boolean(String(env.TELNYX_PUBLIC_KEY || "").trim()),
    },
    messagingProfile,
    sender,
  };
}
