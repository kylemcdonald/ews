const { getMetaValue, setMetaValue } = require("./db");

const TELEGRAM_ALERT_LAST_SLOT_META_KEY = "telegram_level5_alert_last_slot_key";
const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_ALERT_URL = "https://ews.kylemcdonald.net/";

function normalizeTelegramChannel(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  const tmeMatch = trimmed.match(/^https?:\/\/t\.me\/([^/?#]+)/i);
  if (tmeMatch) {
    return `@${tmeMatch[1]}`;
  }

  if (trimmed.startsWith("@") || trimmed.startsWith("-")) {
    return trimmed;
  }

  return `@${trimmed}`;
}

function getTelegramAlertConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const channel = normalizeTelegramChannel(env.TELEGRAM_CHANNEL);

  return {
    enabled: Boolean(token && channel),
    token,
    botUsername: String(env.TELEGRAM_BOT_USERNAME || "").trim() || null,
    channel,
    alertUrl: String(env.EWS_PUBLIC_URL || DEFAULT_ALERT_URL).trim() || DEFAULT_ALERT_URL,
  };
}

function getEmergencySnapshotSignal(snapshot) {
  return snapshot?.signals?.composite || {
    emergencyLevel: snapshot?.current?.emergencyLevel,
    actualConcurrentCount: snapshot?.current?.concurrentCount,
    expectedConcurrentCount: snapshot?.current?.baselineMean,
    asOf: snapshot?.current?.asOf,
  };
}

function getLatestSlotKey(snapshot, status) {
  return (
    status?.latestSlotKey ||
    snapshot?.liveStatus?.latestSlotKey ||
    snapshot?.current?.asOf ||
    getEmergencySnapshotSignal(snapshot)?.asOf ||
    null
  );
}

function formatCount(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return "0";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.round(numericValue));
}

function formatSignedCount(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return "+0";
  }

  const roundedValue = Math.round(numericValue);
  return `${roundedValue >= 0 ? "+" : ""}${formatCount(roundedValue)}`;
}

function formatEmergencyLevelAlert(snapshot, { alertUrl = DEFAULT_ALERT_URL } = {}) {
  const signal = getEmergencySnapshotSignal(snapshot);
  const actualCount = Number(signal?.actualConcurrentCount ?? snapshot?.current?.concurrentCount ?? 0);
  const expectedCount = Number(signal?.expectedConcurrentCount ?? snapshot?.current?.baselineMean ?? 0);
  const aboveExpectedCount = actualCount - expectedCount;

  return [
    "emergency level 5!",
    `${formatCount(actualCount)} airborne (${formatSignedCount(aboveExpectedCount)} above expected)`,
    alertUrl,
  ].join("\n");
}

async function sendTelegramMessage({ token, channel }, text) {
  const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: channel,
      text,
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram request failed with ${response.status}`);
  }

  return payload.result;
}

async function maybeSendEmergencyLevelTelegramAlert({
  snapshot,
  status = null,
  env = process.env,
  dryRun = false,
  logger = console,
} = {}) {
  const config = getTelegramAlertConfig(env);
  if (!config.enabled) {
    return {
      ok: true,
      sent: false,
      reason: "telegram_not_configured",
    };
  }

  const signal = getEmergencySnapshotSignal(snapshot);
  const emergencyLevel = Math.round(Number(signal?.emergencyLevel || 1));
  if (emergencyLevel !== 5) {
    return {
      ok: true,
      sent: false,
      reason: "emergency_level_not_5",
      emergencyLevel,
    };
  }

  const latestSlotKey = getLatestSlotKey(snapshot, status);
  const lastAlertedSlotKey = getMetaValue(TELEGRAM_ALERT_LAST_SLOT_META_KEY);
  if (latestSlotKey && lastAlertedSlotKey === latestSlotKey) {
    return {
      ok: true,
      sent: false,
      reason: "already_alerted_for_slot",
      latestSlotKey,
    };
  }

  const text = formatEmergencyLevelAlert(snapshot, {
    alertUrl: config.alertUrl,
  });

  if (dryRun) {
    logger.log(text);
    return {
      ok: true,
      sent: false,
      reason: "dry_run",
      latestSlotKey,
      text,
    };
  }

  const message = await sendTelegramMessage(config, text);
  if (latestSlotKey) {
    setMetaValue(TELEGRAM_ALERT_LAST_SLOT_META_KEY, latestSlotKey);
  }

  return {
    ok: true,
    sent: true,
    latestSlotKey,
    messageId: message?.message_id ?? null,
  };
}

module.exports = {
  DEFAULT_ALERT_URL,
  TELEGRAM_ALERT_LAST_SLOT_META_KEY,
  formatEmergencyLevelAlert,
  getTelegramAlertConfig,
  getEmergencySnapshotSignal,
  getLatestSlotKey,
  maybeSendEmergencyLevelTelegramAlert,
  normalizeTelegramChannel,
  sendTelegramMessage,
};
