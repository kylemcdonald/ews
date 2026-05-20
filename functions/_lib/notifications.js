import {
  createAlertRecord,
  getActiveSubscribers,
  getMetaValue,
  getSubscriberById,
  hydrateSubscriberContacts,
  recordSubscriberWelcomeSent,
  recordDelivery,
  setMetaValue,
  updateAlertRecord,
} from "./db.js";
import { contactHash } from "./crypto.js";
import { getPhoneCountryName, isSupportedSmsPhone } from "./contacts.js";
import { createAccountManagementLink } from "./customer-portal.js";
import { HttpError } from "./http.js";
import { sendTelnyxMessage } from "./telnyx.js";

const LEVEL5_COOLDOWN_META_KEY = "level5_notification_last_sent_at";
const DEFAULT_NOTIFICATION_URL = "https://aews.cc/";
const LEVEL5_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LEVEL5_NOTIFICATION_CONCURRENCY = 8;
const DEFAULT_LEVEL5_SMS_MIN_INTERVAL_MS = 250;
export const SIGNUP_CONFIRMATION_SMS_TEXT =
  "Apocalypse Early Warning System: subscription confirmed. We will only text if emergency level reaches 5. Reply STOP to stop. Msg&data rates may apply.";
const HOPEFULLY_MESSAGE = "Hopefully we will not need to send you a message.";

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

export function getEmergencySnapshotSignal(snapshot) {
  return snapshot?.signals?.composite || {
    emergencyLevel: snapshot?.current?.emergencyLevel,
    actualConcurrentCount: snapshot?.current?.concurrentCount,
    expectedConcurrentCount: snapshot?.current?.baselineMean,
    asOf: snapshot?.current?.asOf,
  };
}

export function getLatestSlotKey(snapshot) {
  return (
    snapshot?.liveStatus?.latestSlotKey ||
    snapshot?.current?.asOf ||
    getEmergencySnapshotSignal(snapshot)?.asOf ||
    null
  );
}

export function getEmergencyLevel(snapshot) {
  return Math.round(Number(getEmergencySnapshotSignal(snapshot)?.emergencyLevel || 1));
}

export function formatEmergencyNotification(snapshot, { test = false, alertUrl = DEFAULT_NOTIFICATION_URL } = {}) {
  const signal = getEmergencySnapshotSignal(snapshot);
  const actualCount = Number(signal?.actualConcurrentCount ?? snapshot?.current?.concurrentCount ?? 0);
  const expectedCount = Number(signal?.expectedConcurrentCount ?? snapshot?.current?.baselineMean ?? 0);
  const aboveExpectedCount = actualCount - expectedCount;
  const prefix = test ? "TEST ALERT: " : "";

  return `${prefix}Apocalypse EWS: emergency level 5. ${formatCount(actualCount)} airborne (${formatSignedCount(
    aboveExpectedCount,
  )} vs expected). ${alertUrl}`;
}

function getAlertUrl(env) {
  return String(env.EWS_NOTIFICATION_URL || DEFAULT_NOTIFICATION_URL).trim() || DEFAULT_NOTIFICATION_URL;
}

function getNotificationBaseUrl(env) {
  return getAlertUrl(env).replace(/\/+$/, "");
}

function getPositiveIntegerEnv(env, key, fallback, { min = 1, max = Number.POSITIVE_INFINITY } = {}) {
  const rawValue = String(env[key] ?? "").trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Math.trunc(Number(rawValue));
  if (!Number.isFinite(value) || value < min) {
    return fallback;
  }

  return Math.min(value, max);
}

function getLevel5NotificationConcurrency(env) {
  return getPositiveIntegerEnv(env, "LEVEL5_NOTIFICATION_CONCURRENCY", DEFAULT_LEVEL5_NOTIFICATION_CONCURRENCY, {
    min: 1,
    max: 25,
  });
}

function getLevel5SmsMinIntervalMs(env) {
  return getPositiveIntegerEnv(env, "LEVEL5_SMS_MIN_INTERVAL_MS", DEFAULT_LEVEL5_SMS_MIN_INTERVAL_MS, {
    min: 0,
    max: 60_000,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPacer(intervalMs) {
  if (!intervalMs) {
    return {
      wait: async () => {},
    };
  }

  let nextAvailableAt = 0;
  let chain = Promise.resolve();
  return {
    wait() {
      const turn = chain.then(async () => {
        const now = Date.now();
        const waitMs = Math.max(0, nextAvailableAt - now);
        nextAvailableAt = Math.max(now, nextAvailableAt) + intervalMs;
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      });
      chain = turn.catch(() => {});
      return turn;
    },
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

async function appendCustomerPortalLink(env, subscriber, messageText) {
  const portalUrl = await createAccountManagementLink(env, subscriber, { baseUrl: getNotificationBaseUrl(env) });
  return `${messageText}\n\nManage your notification settings: ${portalUrl}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatHtmlParagraphs(lines) {
  return lines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function getManagementLinkText(subscriber) {
  const hasStripeSubscription = Boolean(subscriber.stripe_customer_id || subscriber.stripeCustomerId);
  return hasStripeSubscription
    ? "Manage your notification settings and billing information."
    : "Manage your notification settings.";
}

async function sendEmail(env, { to, subject, text, html = null }) {
  const apiKey = String(env.SENDGRID_API_KEY || "").trim();
  const fromEmail = String(env.SENDGRID_FROM_EMAIL || "").trim();
  if (!apiKey || !fromEmail) {
    throw new HttpError(500, "SendGrid is not configured.");
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: to }],
          subject,
        },
      ],
      from: {
        email: fromEmail,
        name: String(env.SENDGRID_FROM_NAME || "Apocalypse EWS"),
      },
      content: [
        {
          type: "text/plain",
          value: text,
        },
        ...(html
          ? [
              {
                type: "text/html",
                value: html,
              },
            ]
          : []),
      ],
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `SendGrid request failed with ${response.status}`);
  }

  return {
    id: response.headers.get("x-message-id") || null,
  };
}

async function sendSms(env, { to, text }) {
  return sendTelnyxMessage(env, { to, text });
}

async function sendDelivery(env, { alertId, subscriberId, channel, destination, text, subject = null, html = null }) {
  const destinationHash = await contactHash(env, channel === "sms" ? "phone" : channel, destination);

  try {
    const result =
      channel === "email"
        ? await sendEmail(env, { to: destination, subject, text, html })
        : await sendSms(env, { to: destination, text });
    await recordDelivery(env, {
      alertId,
      subscriberId,
      channel,
      destinationHash,
      status: "sent",
      providerMessageId: result.id,
      providerStatus: result.providerStatus || null,
      messageText: text,
      subject,
    });

    return { ok: true, channel };
  } catch (error) {
    await recordDelivery(env, {
      alertId,
      subscriberId,
      channel,
      destinationHash,
      status: "failed",
      error: error.message,
      messageText: text,
      subject,
    });

    return { ok: false, channel, error: error.message };
  }
}

function getEmergencyMetrics(snapshot) {
  const signal = getEmergencySnapshotSignal(snapshot);
  const actualCount = Number(signal?.actualConcurrentCount ?? snapshot?.current?.concurrentCount ?? 0);
  const expectedCount = Number(signal?.expectedConcurrentCount ?? snapshot?.current?.baselineMean ?? 0);
  const excessCount = actualCount - expectedCount;
  return {
    asOf: signal?.asOf || snapshot?.current?.asOf || null,
    actualCount,
    expectedCount,
    excessCount,
  };
}

function formatLevel5AsOf(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toISOString().replace(".000Z", "Z");
}

function getLevel5EmailContent(env, snapshot, subscriber, managementUrl) {
  const metrics = getEmergencyMetrics(snapshot);
  const asOf = formatLevel5AsOf(metrics.asOf);
  const alertUrl = getAlertUrl(env);
  const bodyLines = [
    "Emergency level 5.",
    "",
    "Apocalypse Early Warning System detected an unusually high level of tracked aircraft activity.",
    "",
    "This does not mean we know there is an emergency. It means the system detected an anomaly that may potentially indicate one. There may also be unaccounted-for explanations, including major sports events, conferences, holidays, or other unusual travel patterns.",
    "",
    `Observed airborne aircraft: ${formatCount(metrics.actualCount)}`,
    `Expected for this time: ${formatCount(metrics.expectedCount)}`,
    `Difference: ${formatSignedCount(metrics.excessCount)}`,
    ...(asOf ? [`Observation time: ${asOf}`] : []),
    "",
    "View the dashboard for realtime information:",
    alertUrl,
    "",
    "This message was sent because you subscribed to emergency alerts. We will not send another level 5 notification for at least 24 hours.",
    "",
    "Manage your notification settings:",
    managementUrl,
  ];
  const html = [
    formatHtmlParagraphs([
      "Emergency level 5.",
      "",
      "Apocalypse Early Warning System detected an unusually high level of tracked aircraft activity.",
      "",
      "This does not mean we know there is an emergency. It means the system detected an anomaly that may potentially indicate one. There may also be unaccounted-for explanations, including major sports events, conferences, holidays, or other unusual travel patterns.",
      "",
      `Observed airborne aircraft: ${formatCount(metrics.actualCount)}`,
      `Expected for this time: ${formatCount(metrics.expectedCount)}`,
      `Difference: ${formatSignedCount(metrics.excessCount)}`,
      ...(asOf ? [`Observation time: ${asOf}`] : []),
    ]),
    `<p><a href="${escapeHtml(alertUrl)}">View the dashboard for realtime information</a></p>`,
    formatHtmlParagraphs([
      "This message was sent because you subscribed to emergency alerts. We will not send another level 5 notification for at least 24 hours.",
    ]),
    `<p><a href="${escapeHtml(managementUrl)}">${escapeHtml(getManagementLinkText(subscriber))}</a></p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    text: bodyLines.join("\n"),
    html,
  };
}

async function recordDeliveryPreparationFailure(env, { alertId, subscriberId, channel, destination, error }) {
  const destinationHash = await contactHash(env, channel === "sms" ? "phone" : channel, destination);
  await recordDelivery(env, {
    alertId,
    subscriberId,
    channel,
    destinationHash,
    status: "failed",
    error: error.message,
  });
}

async function sendAlertToSubscribers(
  env,
  {
    alertId,
    subscribers,
    messageText,
    subject,
    includeCustomerPortalLinks = false,
    emailContentFactory = null,
    concurrency = 1,
    smsMinIntervalMs = 0,
  },
) {
  const summary = {
    subscriberCount: subscribers.length,
    emailSentCount: 0,
    smsSentCount: 0,
    errorCount: 0,
    emailEligibleCount: 0,
    smsEligibleCount: 0,
    smsMinIntervalMs,
    concurrency,
  };
  const smsPacer = createPacer(smsMinIntervalMs);

  const results = await mapWithConcurrency(subscribers, concurrency, async (subscriber) => {
    const subscriberSummary = {
      emailEligibleCount: 0,
      smsEligibleCount: 0,
      emailSentCount: 0,
      smsSentCount: 0,
      errorCount: 0,
    };
    const hydrated = await hydrateSubscriberContacts(env, subscriber);
    if (hydrated.wantsEmail && hydrated.email) {
      let emailText = messageText;
      let emailHtml = null;
      try {
        if (emailContentFactory) {
          const managementUrl = await createAccountManagementLink(env, hydrated, { baseUrl: getNotificationBaseUrl(env) });
          const content = await emailContentFactory(hydrated, managementUrl);
          emailText = content.text;
          emailHtml = content.html || null;
        } else if (includeCustomerPortalLinks) {
          emailText = await appendCustomerPortalLink(env, hydrated, messageText);
        }
      } catch (error) {
        await recordDeliveryPreparationFailure(env, {
          alertId,
          subscriberId: hydrated.id,
          channel: "email",
          destination: hydrated.email,
          error,
        });
        subscriberSummary.errorCount += 1;
        return subscriberSummary;
      }

      subscriberSummary.emailEligibleCount += 1;
      const result = await sendDelivery(env, {
        alertId,
        subscriberId: hydrated.id,
        channel: "email",
        destination: hydrated.email,
        text: emailText,
        html: emailHtml,
        subject,
      });
      if (result.ok) {
        subscriberSummary.emailSentCount += 1;
      } else {
        subscriberSummary.errorCount += 1;
      }
    }

    if (hydrated.wantsSms && hydrated.phone && safelyIsSupportedSmsPhone(hydrated.phone)) {
      subscriberSummary.smsEligibleCount += 1;
      await smsPacer.wait();
      const result = await sendDelivery(env, {
        alertId,
        subscriberId: hydrated.id,
        channel: "sms",
        destination: hydrated.phone,
        text: messageText,
      });
      if (result.ok) {
        subscriberSummary.smsSentCount += 1;
      } else {
        subscriberSummary.errorCount += 1;
      }
    }

    return subscriberSummary;
  });

  for (const result of results) {
    summary.emailEligibleCount += Number(result.emailEligibleCount || 0);
    summary.smsEligibleCount += Number(result.smsEligibleCount || 0);
    summary.emailSentCount += Number(result.emailSentCount || 0);
    summary.smsSentCount += Number(result.smsSentCount || 0);
    summary.errorCount += Number(result.errorCount || 0);
  }

  summary.status = summary.errorCount > 0 ? "completed_with_errors" : "sent";
  await updateAlertRecord(env, alertId, summary);
  return summary;
}

function formatSignupConfirmationChannelSentence(subscriber) {
  const hasSupportedSms = Boolean(subscriber.wantsSms && safelyIsSupportedSmsPhone(subscriber.phone));
  const hasEmailAlerts = Boolean(subscriber.wantsEmail && subscriber.email);

  if (hasSupportedSms && hasEmailAlerts) {
    return `When the emergency level reaches 5, we will text you at ${subscriber.phone} and email you at ${subscriber.email}.`;
  }
  if (hasEmailAlerts) {
    return `When the emergency level reaches 5, we will email you at ${subscriber.email}.`;
  }
  if (hasSupportedSms) {
    return `When the emergency level reaches 5, we will text you at ${subscriber.phone}.`;
  }

  return "";
}

function getSignupConfirmationEmailContent(subscriber, managementUrl) {
  const smsSupported = safelyIsSupportedSmsPhone(subscriber.phone);
  const hasUnsupportedSms = Boolean(subscriber.wantsSms && subscriber.phone && !smsSupported);
  const managementLinkText = getManagementLinkText(subscriber);

  const bodyLines = ["You're subscribed to Apocalypse Early Warning System.", ""];

  if (hasUnsupportedSms) {
    const countryName = getPhoneCountryName(subscriber.phoneCountry);
    bodyLines.push(
      `The number you registered with us is based in ${countryName}. SMS alerts are currently available for US and Canada numbers.`,
      "",
    );
    if (subscriber.wantsEmail && subscriber.email) {
      bodyLines.push(`For now, we will keep you covered with emergency email alerts at ${subscriber.email}.`, "");
    } else {
      bodyLines.push("Use the management link below if you want email alerts.", "");
    }
  } else {
    const channelSentence = formatSignupConfirmationChannelSentence(subscriber);
    if (channelSentence) {
      bodyLines.push(channelSentence, "");
    } else if (!subscriber.wantsEmail || !subscriber.email) {
      bodyLines.push("This email is for account management. You are not currently signed up for email alerts.", "");
    }
  }

  bodyLines.push(HOPEFULLY_MESSAGE, "");

  const footerLines = [managementLinkText, managementUrl, "", "Questions: ews@kylemcdonald.net", "", "Thank you for subscribing,\nKyle"];
  const textLines = [...bodyLines, ...footerLines];
  const text = textLines.join("\n");
  const html = [
    formatHtmlParagraphs(bodyLines),
    `<p><a href="${escapeHtml(managementUrl)}">${escapeHtml(managementLinkText)}</a></p>`,
    formatHtmlParagraphs(["Questions: ews@kylemcdonald.net", "", "Thank you for subscribing,\nKyle"]),
  ]
    .filter(Boolean)
    .join("\n");

  return { text, html };
}

function safelyIsSupportedSmsPhone(phone) {
  try {
    return Boolean(phone && isSupportedSmsPhone(phone));
  } catch {
    return false;
  }
}

export async function sendSignupConfirmationToSubscriber(env, subscriberId, options = {}) {
  const subscriber = await getSubscriberById(env, subscriberId);
  if (!subscriber) {
    throw new HttpError(404, "Subscriber not found.");
  }

  const hydrated = await hydrateSubscriberContacts(env, subscriber);
  const managementUrl = await createAccountManagementLink(env, hydrated, { baseUrl: getNotificationBaseUrl(env) });
  const channels = options.channels || {};
  const skipAlreadySent = Boolean(options.skipAlreadySent);
  const emailAlreadySent = Boolean(hydrated.welcome_email_sent_at || hydrated.welcomeEmailSentAt);
  const smsAlreadySent = Boolean(hydrated.welcome_sms_sent_at || hydrated.welcomeSmsSentAt);
  const sendEmailConfirmation = channels.email !== false && (!skipAlreadySent || !emailAlreadySent);
  const sendSmsConfirmation = channels.sms !== false && (!skipAlreadySent || !smsAlreadySent);
  const emailDestination = hydrated.accountEmail || hydrated.email;
  const canSendEmailConfirmation = Boolean(sendEmailConfirmation && emailDestination);
  const canSendSmsConfirmation = Boolean(
    sendSmsConfirmation && hydrated.wantsSms && safelyIsSupportedSmsPhone(hydrated.phone),
  );
  const summary = {
    subscriberCount: 1,
    emailSentCount: 0,
    smsSentCount: 0,
    errorCount: 0,
  };

  if (!canSendEmailConfirmation && !canSendSmsConfirmation) {
    return {
      ok: true,
      sent: false,
      skipped: true,
      reason:
        skipAlreadySent &&
        (channels.email === false || emailAlreadySent) &&
        (channels.sms === false || smsAlreadySent)
          ? "signup_confirmation_already_sent"
          : "signup_confirmation_no_delivery_channels",
      managementUrl,
      status: "skipped",
      ...summary,
    };
  }

  const alertId = await createAlertRecord(env, {
    kind: "signup_confirmation",
    source: options.source || "admin",
    level: null,
    slotKey: null,
    messageText: "Signup confirmation",
  });

  if (canSendEmailConfirmation) {
    const emailContent = getSignupConfirmationEmailContent(hydrated, managementUrl);
    const result = await sendDelivery(env, {
      alertId,
      subscriberId: hydrated.id,
      channel: "email",
      destination: emailDestination,
      text: emailContent.text,
      html: emailContent.html,
      subject: "Apocalypse EWS subscription confirmation",
    });
    if (result.ok) {
      summary.emailSentCount += 1;
      await recordSubscriberWelcomeSent(env, hydrated.id, "email");
    } else {
      summary.errorCount += 1;
    }
  }

  if (canSendSmsConfirmation) {
    const result = await sendDelivery(env, {
      alertId,
      subscriberId: hydrated.id,
      channel: "sms",
      destination: hydrated.phone,
      text: SIGNUP_CONFIRMATION_SMS_TEXT,
    });
    if (result.ok) {
      summary.smsSentCount += 1;
      await recordSubscriberWelcomeSent(env, hydrated.id, "sms");
    } else {
      summary.errorCount += 1;
    }
  }

  summary.status = summary.errorCount > 0 ? "completed_with_errors" : "sent";
  await updateAlertRecord(env, alertId, summary);
  return {
    ok: summary.errorCount === 0,
    sent: true,
    alertId,
    managementUrl,
    ...summary,
  };
}

export async function maybeSendLevel5Notifications(env, snapshot, { source = "scheduled_refresh" } = {}) {
  const emergencyLevel = getEmergencyLevel(snapshot);
  const slotKey = getLatestSlotKey(snapshot);
  if (emergencyLevel !== 5) {
    return {
      ok: true,
      sent: false,
      reason: "emergency_level_not_5",
      emergencyLevel,
      slotKey,
    };
  }

  const lastSentAt = await getMetaValue(env, LEVEL5_COOLDOWN_META_KEY);
  if (lastSentAt && Date.now() - new Date(lastSentAt).getTime() < LEVEL5_COOLDOWN_MS) {
    return {
      ok: true,
      sent: false,
      reason: "cooldown_active",
      emergencyLevel,
      slotKey,
      lastSentAt,
    };
  }

  const triggeredAt = new Date().toISOString();
  await setMetaValue(env, LEVEL5_COOLDOWN_META_KEY, triggeredAt);

  const messageText = formatEmergencyNotification(snapshot, { alertUrl: getAlertUrl(env) });
  const alertId = await createAlertRecord(env, {
    kind: "level5",
    source,
    level: emergencyLevel,
    slotKey,
    messageText,
  });
  const subscribers = await getActiveSubscribers(env);
  const smsMinIntervalMs = getLevel5SmsMinIntervalMs(env);
  const concurrency = getLevel5NotificationConcurrency(env);
  const summary = await sendAlertToSubscribers(env, {
    alertId,
    subscribers,
    messageText,
    subject: "Apocalypse EWS: emergency level 5",
    emailContentFactory: (subscriber, managementUrl) => getLevel5EmailContent(env, snapshot, subscriber, managementUrl),
    concurrency,
    smsMinIntervalMs,
  });

  return {
    ok: summary.errorCount === 0,
    sent: true,
    alertId,
    emergencyLevel,
    slotKey,
    cooldownStartedAt: triggeredAt,
    estimatedSmsWindowSeconds: Math.ceil((Number(summary.smsEligibleCount || 0) * smsMinIntervalMs) / 1000),
    ...summary,
  };
}

export async function sendAdminSingleTest(env, { email, phone }) {
  const snapshot = {
    signals: {
      composite: {
        emergencyLevel: 5,
        actualConcurrentCount: 521,
        expectedConcurrentCount: 400,
        asOf: new Date().toISOString(),
      },
    },
  };
  const messageText = formatEmergencyNotification(snapshot, { test: true, alertUrl: getAlertUrl(env) });
  const alertId = await createAlertRecord(env, {
    kind: "admin_test_single",
    source: "admin",
    level: 5,
    slotKey: getLatestSlotKey(snapshot),
    messageText,
  });
  const summary = {
    subscriberCount: 0,
    emailSentCount: 0,
    smsSentCount: 0,
    errorCount: 0,
  };

  if (email) {
    const result = await sendDelivery(env, {
      alertId,
      channel: "email",
      destination: email,
      text: messageText,
      subject: "TEST: Apocalypse EWS emergency alert",
    });
    if (result.ok) {
      summary.emailSentCount += 1;
    } else {
      summary.errorCount += 1;
    }
  }

  if (phone) {
    const result = await sendDelivery(env, {
      alertId,
      channel: "sms",
      destination: phone,
      text: messageText,
    });
    if (result.ok) {
      summary.smsSentCount += 1;
    } else {
      summary.errorCount += 1;
    }
  }

  summary.status = summary.errorCount > 0 ? "completed_with_errors" : "sent";
  await updateAlertRecord(env, alertId, summary);

  return {
    ok: summary.errorCount === 0,
    sent: true,
    alertId,
    ...summary,
  };
}
