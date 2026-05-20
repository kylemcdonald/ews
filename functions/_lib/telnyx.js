import { contactHash } from "./crypto.js";
import { base64ToBytes, utf8Bytes } from "./encoding.js";
import { HttpError, jsonResponse } from "./http.js";

const TELNYX_API_BASE_URL = "https://api.telnyx.com/v2";
const WEBHOOK_TOLERANCE_SECONDS = 300;
const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const HELP_KEYWORDS = new Set(["HELP", "INFO"]);

function getPublicBaseUrl(env) {
  return String(env.APP_BASE_URL || env.EWS_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function normalizeConfiguredUrl(value) {
  const text = String(value || "").trim();
  return text || null;
}

function getConfiguredFromNumber(env) {
  return String(env.TELNYX_FROM_PHONE || env.TELNYX_NUMBER || "").trim();
}

function requireTelnyxApiKey(env) {
  const apiKey = String(env.TELNYX_API_KEY || "").trim();
  if (!apiKey) {
    throw new HttpError(500, "Telnyx API key is not configured.");
  }

  return apiKey;
}

export function getTelnyxWebhookUrl(env) {
  const configuredUrl = normalizeConfiguredUrl(env.TELNYX_WEBHOOK_URL);
  if (configuredUrl) {
    return configuredUrl;
  }

  const publicBaseUrl = getPublicBaseUrl(env);
  if (!publicBaseUrl.startsWith("https://")) {
    return null;
  }

  return `${publicBaseUrl}/api/telnyx/webhook`;
}

export function getTelnyxWebhookFailoverUrl(env) {
  return normalizeConfiguredUrl(env.TELNYX_WEBHOOK_FAILOVER_URL);
}

async function telnyxRequest(env, method, path, body = null) {
  const init = {
    method,
    headers: {
      authorization: `Bearer ${requireTelnyxApiKey(env)}`,
    },
  };

  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${TELNYX_API_BASE_URL}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const firstError = Array.isArray(payload.errors) ? payload.errors[0] : null;
    const message =
      firstError?.detail ||
      firstError?.title ||
      payload.message ||
      `Telnyx request failed with ${response.status}.`;
    throw new HttpError(response.status >= 500 ? 502 : response.status, message);
  }

  return payload;
}

export async function telnyxJson(env, path) {
  return telnyxRequest(env, "GET", path);
}

export async function sendTelnyxMessage(env, { to, text, useStatusWebhook = true }) {
  const from = getConfiguredFromNumber(env);
  const messagingProfileId = String(env.TELNYX_MESSAGING_PROFILE_ID || "").trim();
  if (!from && !messagingProfileId) {
    throw new HttpError(500, "Telnyx sender is not configured.");
  }

  const body = {
    to,
    text,
    type: "SMS",
    use_profile_webhooks: true,
  };
  if (from) {
    body.from = from;
  } else if (messagingProfileId) {
    body.messaging_profile_id = messagingProfileId;
  }
  if (useStatusWebhook) {
    const webhookUrl = getTelnyxWebhookUrl(env);
    const webhookFailoverUrl = getTelnyxWebhookFailoverUrl(env);
    if (webhookUrl) {
      body.webhook_url = webhookUrl;
    }
    if (webhookFailoverUrl) {
      body.webhook_failover_url = webhookFailoverUrl;
    }
  }

  const payload = await telnyxRequest(env, "POST", "/messages", body);
  return {
    id: payload.data?.id || null,
    cost: payload.data?.cost || null,
    providerStatus: payload.data?.to?.[0]?.status || payload.data?.status || null,
  };
}

function decodeHex(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < text.length; index += 2) {
    bytes[index / 2] = Number.parseInt(text.slice(index, index + 2), 16);
  }

  return bytes;
}

function decodePemSpki(value) {
  const match = String(value || "").match(/-----BEGIN PUBLIC KEY-----(?<body>[\s\S]+?)-----END PUBLIC KEY-----/);
  if (!match?.groups?.body) {
    return null;
  }

  return base64ToBytes(match.groups.body.replace(/\s+/g, ""));
}

function decodeTelnyxPublicKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const pemBytes = decodePemSpki(text);
  if (pemBytes) {
    return { format: "spki", bytes: pemBytes };
  }

  try {
    const bytes = base64ToBytes(text.replace(/\s+/g, ""));
    if (bytes.length === 32) {
      return { format: "raw", bytes };
    }
  } catch {
    // Some tooling displays the raw key as hex. Try that before failing.
  }

  const hexBytes = decodeHex(text);
  if (hexBytes?.length === 32) {
    return { format: "raw", bytes: hexBytes };
  }

  return null;
}

async function importTelnyxPublicKey(value) {
  const decodedKey = decodeTelnyxPublicKey(value);
  if (!decodedKey) {
    throw new HttpError(500, "TELNYX_PUBLIC_KEY is not a supported Ed25519 public key format.");
  }

  return crypto.subtle.importKey(decodedKey.format, decodedKey.bytes, { name: "Ed25519" }, false, ["verify"]);
}

export async function verifyTelnyxWebhook(request, env, rawBody) {
  const publicKey = String(env.TELNYX_PUBLIC_KEY || "").trim();
  if (!publicKey) {
    throw new HttpError(500, "Missing required secret: TELNYX_PUBLIC_KEY.");
  }

  const signature = request.headers.get("telnyx-signature-ed25519") || "";
  const timestamp = request.headers.get("telnyx-timestamp") || "";
  if (!signature || !timestamp) {
    throw new HttpError(403, "Missing Telnyx webhook signature.");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new HttpError(403, "Invalid Telnyx webhook timestamp.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new HttpError(403, "Telnyx webhook timestamp is outside the allowed tolerance.");
  }

  let signatureBytes;
  try {
    signatureBytes = base64ToBytes(signature);
  } catch {
    throw new HttpError(403, "Invalid Telnyx webhook signature encoding.");
  }

  const key = await importTelnyxPublicKey(publicKey);
  const signedPayload = utf8Bytes(`${timestamp}|${rawBody}`);
  const signatureMatches = await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, signedPayload);
  if (!signatureMatches) {
    throw new HttpError(403, "Invalid Telnyx webhook signature.");
  }
}

export function hasTelnyxWebhookVerificationKey(env) {
  return Boolean(String(env.TELNYX_PUBLIC_KEY || "").trim());
}

export function classifyInboundSms(body) {
  const keyword = String(body || "").trim().split(/\s+/)[0]?.toUpperCase() || "";
  if (STOP_KEYWORDS.has(keyword)) {
    return "stop";
  }
  if (START_KEYWORDS.has(keyword)) {
    return "start";
  }
  if (HELP_KEYWORDS.has(keyword)) {
    return "help";
  }
  return "unknown";
}

export function getTelnyxProviderMessageStatus(payload = {}) {
  return String(payload.to?.[0]?.status || payload.from?.status || payload.status || "").trim().toLowerCase();
}

export function normalizeTelnyxMessageStatus(eventType, payload = {}) {
  const status = getTelnyxProviderMessageStatus(payload);
  if (status === "delivered") {
    return "delivered";
  }
  if (status === "sending_failed") {
    return "failed";
  }
  if (status === "delivery_failed") {
    return "undelivered";
  }
  if (status === "delivery_unconfirmed") {
    return "unconfirmed";
  }
  if (["queued", "sending", "sent", "webhook_delivered"].includes(status) || eventType === "message.sent") {
    return "sent";
  }

  return status || "sent";
}

export function getTelnyxDeliveryError(payload = {}) {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (!errors.length) {
    return null;
  }

  return errors
    .map((error) =>
      [error.code ? `Telnyx error ${error.code}` : "Telnyx error", error.title, error.detail]
        .filter(Boolean)
        .join(": "),
    )
    .join("; ");
}

export async function sendInboundSmsReply(env, to, text) {
  if (!to || !text) {
    return null;
  }

  return sendTelnyxMessage(env, { to, text, useStatusWebhook: false });
}

export function telnyxWebhookResponse(payload = {}) {
  return jsonResponse({ ok: true, ...payload });
}

export async function updateSmsPreferenceFromInbound({ env, phone, action, updateSmsPreferenceByPhoneHash }) {
  const phoneHash = await contactHash(env, "phone", phone);
  if (action === "stop") {
    return updateSmsPreferenceByPhoneHash(env, phoneHash, false);
  }
  if (action === "start") {
    return updateSmsPreferenceByPhoneHash(env, phoneHash, true);
  }

  return 0;
}
