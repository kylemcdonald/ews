import { contactHash, decryptString, encryptString, metadataHash } from "./crypto.js";
import { getPhoneCountry, isSupportedSmsPhone, normalizeEmail, normalizePhone } from "./contacts.js";
import { HttpError } from "./http.js";

export const SUBSCRIBER_STATUS = {
  PENDING: "pending_checkout",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
};

const DEFAULT_PENDING_SIGNUP_CONTACT_RETENTION_HOURS = 24;
const SMS_OPT_OUT_SOURCE = {
  SMS_STOP: "sms_stop",
  MANAGE_LINK: "manage_link",
};

function getDb(env) {
  if (!env.EWS_NOTIFY_DB) {
    throw new HttpError(500, "Missing D1 binding: EWS_NOTIFY_DB.");
  }

  return env.EWS_NOTIFY_DB;
}

function shouldUseRemoteSubscriberReads(env) {
  return String(env.ADMIN_SUBSCRIBERS_REMOTE_D1 || "").trim() === "1";
}

async function remoteD1Query(env, sql, params = []) {
  const apiToken = String(env.CLOUDFLARE_API_TOKEN || "").trim();
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const databaseId = String(env.CLOUDFLARE_D1_DATABASE_ID || "").trim();
  if (!apiToken || !accountId || !databaseId) {
    throw new HttpError(500, "Missing Cloudflare API settings for remote D1 subscriber reads.");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sql,
        params,
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new HttpError(
      response.status >= 500 ? 502 : response.status,
      payload.errors?.[0]?.message || `Cloudflare D1 query failed with ${response.status}.`,
    );
  }

  const result = payload.result?.[0];
  if (!result?.success) {
    throw new HttpError(502, result?.error || "Cloudflare D1 query failed.");
  }

  return result.results || [];
}

async function queryRows(env, sql, params = []) {
  if (shouldUseRemoteSubscriberReads(env)) {
    return remoteD1Query(env, sql, params);
  }

  const statement = getDb(env).prepare(sql);
  const query = params.length ? statement.bind(...params) : statement;
  const { results } = await query.all();
  return results || [];
}

function nowIso() {
  return new Date().toISOString();
}

function unixSecondsToIso(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return new Date(numericValue * 1000).toISOString();
}

function getPendingSignupContactRetentionHours(env) {
  const configuredHours = Number(env.PENDING_SIGNUP_CONTACT_RETENTION_HOURS || 0);
  if (Number.isFinite(configuredHours) && configuredHours > 0) {
    return configuredHours;
  }

  return DEFAULT_PENDING_SIGNUP_CONTACT_RETENTION_HOURS;
}

function getSubscriptionCurrentPeriodEnd(subscription) {
  return (
    subscription.current_period_end ||
    subscription.items?.data?.find((item) => item?.current_period_end)?.current_period_end ||
    null
  );
}

async function firstByContactHashes(env, emailHash, phoneHash, accountEmailHash = null) {
  if (!emailHash && !phoneHash && !accountEmailHash) {
    return null;
  }

  const db = getDb(env);
  const clauses = [];
  const params = [];
  if (emailHash) {
    clauses.push("email_hash = ?");
    params.push(emailHash);
  }
  if (accountEmailHash) {
    clauses.push("account_email_hash = ?");
    params.push(accountEmailHash);
  }
  if (phoneHash) {
    clauses.push("phone_hash = ?");
    params.push(phoneHash);
  }

  return db
    .prepare(
      `
        SELECT *
        FROM notification_signups
        WHERE ${clauses.join(" OR ")}
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'pending_checkout' THEN 1 ELSE 2 END,
          updated_at DESC
        LIMIT 1
      `,
    )
    .bind(...params)
    .first();
}

export async function createPendingSignup(env, contacts, requestContext = {}) {
  const phoneCountry = contacts.phone ? getPhoneCountry(contacts.phone) : null;
  const [emailHash, phoneHash, emailCipher, phoneCipher, consentIpHash, consentUserAgentHash] = await Promise.all([
    contactHash(env, "email", contacts.email),
    contactHash(env, "phone", contacts.phone),
    encryptString(env, contacts.email),
    encryptString(env, contacts.phone),
    metadataHash(env, "sms_consent_ip", requestContext.ip),
    metadataHash(env, "sms_consent_user_agent", requestContext.userAgent),
  ]);
  const accountEmailHash = emailHash;
  const accountEmailCipher = emailCipher;

  const existing = await firstByContactHashes(env, emailHash, phoneHash, accountEmailHash);
  if (existing?.status === SUBSCRIBER_STATUS.ACTIVE) {
    throw new HttpError(409, "That email address or phone number is already subscribed.");
  }

  const db = getDb(env);
  const id = existing?.id || crypto.randomUUID();
  const createdAt = existing?.created_at || nowIso();
  const timestamp = nowIso();
  const smsConsentAt = contacts.phone && contacts.smsConsent ? timestamp : null;

  if (existing) {
    await db
      .prepare(
        `
          UPDATE notification_signups
          SET
            status = ?,
            source = ?,
            email_cipher = ?,
            email_hash = ?,
            account_email_cipher = ?,
            account_email_hash = ?,
            account_email_source = ?,
            phone_cipher = ?,
            phone_hash = ?,
            phone_country = ?,
            wants_email = ?,
            wants_sms = ?,
            sms_consent_at = ?,
            sms_consent_ip_hash = ?,
            sms_consent_user_agent_hash = ?,
            stripe_checkout_session_id = NULL,
            checkout_url = NULL,
            checkout_created_at = NULL,
            checkout_completed_at = NULL,
            canceled_at = NULL,
            sms_opted_out_at = NULL,
            sms_opt_out_source = NULL,
            email_opted_out_at = NULL,
            email_opt_out_source = NULL,
            stripe_cancel_at_period_end = 0,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(
        SUBSCRIBER_STATUS.PENDING,
        "stripe",
        emailCipher,
        emailHash,
        accountEmailCipher,
        accountEmailHash,
        contacts.email ? "signup" : null,
        phoneCipher,
        phoneHash,
        phoneCountry,
        contacts.wantsEmail ? 1 : 0,
        contacts.wantsSms ? 1 : 0,
        smsConsentAt,
        consentIpHash,
        consentUserAgentHash,
        timestamp,
        id,
      )
      .run();
  } else {
    await db
      .prepare(
        `
          INSERT INTO notification_signups (
            id,
            status,
            source,
            email_cipher,
            email_hash,
            account_email_cipher,
            account_email_hash,
            account_email_source,
            phone_cipher,
            phone_hash,
            phone_country,
            wants_email,
            wants_sms,
            sms_consent_at,
            sms_consent_ip_hash,
            sms_consent_user_agent_hash,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        id,
        SUBSCRIBER_STATUS.PENDING,
        "stripe",
        emailCipher,
        emailHash,
        accountEmailCipher,
        accountEmailHash,
        contacts.email ? "signup" : null,
        phoneCipher,
        phoneHash,
        phoneCountry,
        contacts.wantsEmail ? 1 : 0,
        contacts.wantsSms ? 1 : 0,
        smsConsentAt,
        consentIpHash,
        consentUserAgentHash,
        createdAt,
        timestamp,
      )
      .run();
  }

  return {
    id,
    email: contacts.email,
    phone: contacts.phone,
  };
}

export async function recordCheckoutSession(env, signupId, checkoutSession, priceId, productId) {
  const db = getDb(env);
  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          stripe_checkout_session_id = ?,
          stripe_product_id = ?,
          stripe_price_id = ?,
          checkout_url = ?,
          checkout_created_at = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      checkoutSession.id || null,
      productId || null,
      priceId || null,
      checkoutSession.url || null,
      unixSecondsToIso(checkoutSession.created) || nowIso(),
      nowIso(),
      signupId,
    )
    .run();
}

export async function anonymizeExpiredPendingSignups(env, options = {}) {
  const retentionHours =
    Number.isFinite(Number(options.retentionHours)) && Number(options.retentionHours) > 0
      ? Number(options.retentionHours)
      : getPendingSignupContactRetentionHours(env);
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
  const cutoffEpochSeconds = Math.floor(cutoff.getTime() / 1000);
  const timestamp = nowIso();

  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          email_cipher = NULL,
          email_hash = NULL,
          account_email_cipher = NULL,
          account_email_hash = NULL,
          account_email_source = NULL,
          phone_cipher = NULL,
          phone_hash = NULL,
          phone_country = NULL,
          sms_consent_ip_hash = NULL,
          sms_consent_user_agent_hash = NULL,
          checkout_url = NULL,
          contact_redacted_at = ?,
          updated_at = ?
        WHERE status = ?
          AND contact_redacted_at IS NULL
          AND CAST(COALESCE(strftime('%s', checkout_created_at), strftime('%s', created_at), '0') AS INTEGER) <= ?
          AND (
            email_cipher IS NOT NULL
            OR email_hash IS NOT NULL
            OR account_email_cipher IS NOT NULL
            OR account_email_hash IS NOT NULL
            OR phone_cipher IS NOT NULL
            OR phone_hash IS NOT NULL
            OR sms_consent_ip_hash IS NOT NULL
            OR sms_consent_user_agent_hash IS NOT NULL
            OR checkout_url IS NOT NULL
          )
      `,
    )
    .bind(timestamp, timestamp, SUBSCRIBER_STATUS.PENDING, cutoffEpochSeconds)
    .run();

  return {
    ok: true,
    retentionHours,
    cutoff: cutoff.toISOString(),
    redactedCount: result.meta?.changes || 0,
  };
}

export async function activateSubscriberFromCheckout(env, checkoutSession) {
  const signupId = checkoutSession.metadata?.signup_id || checkoutSession.client_reference_id || null;
  const sessionId = checkoutSession.id || null;
  if (!signupId && !sessionId) {
    return null;
  }

  const db = getDb(env);
  const subscriber = signupId
    ? await db.prepare("SELECT * FROM notification_signups WHERE id = ?").bind(signupId).first()
    : await db
        .prepare("SELECT * FROM notification_signups WHERE stripe_checkout_session_id = ?")
        .bind(sessionId)
        .first();

  if (!subscriber) {
    return null;
  }

  let wantsEmail = Number(subscriber.wants_email || 0);
  const stripeEmail = checkoutSession.customer_details?.email || checkoutSession.customer_email || null;
  let emailCipher = subscriber.email_cipher;
  let emailHash = subscriber.email_hash;
  let accountEmailCipher = subscriber.account_email_cipher;
  let accountEmailHash = subscriber.account_email_hash;
  let accountEmailSource = subscriber.account_email_source;
  if (!emailCipher && wantsEmail && stripeEmail) {
    const normalizedEmail = String(stripeEmail).trim().toLowerCase();
    emailCipher = await encryptString(env, normalizedEmail);
    emailHash = await contactHash(env, "email", normalizedEmail);
  }
  if (stripeEmail && (!accountEmailCipher || accountEmailSource === "stripe")) {
    const normalizedEmail = String(stripeEmail).trim().toLowerCase();
    accountEmailCipher = await encryptString(env, normalizedEmail);
    accountEmailHash = await contactHash(env, "email", normalizedEmail);
    accountEmailSource = "stripe";
  }

  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          email_cipher = ?,
          email_hash = ?,
          account_email_cipher = ?,
          account_email_hash = ?,
          account_email_source = ?,
          wants_email = ?,
          stripe_customer_id = ?,
          stripe_subscription_id = ?,
          stripe_checkout_session_id = ?,
          checkout_completed_at = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      SUBSCRIBER_STATUS.ACTIVE,
      emailCipher,
      emailHash,
      accountEmailCipher,
      accountEmailHash,
      accountEmailSource,
      wantsEmail,
      checkoutSession.customer || null,
      checkoutSession.subscription || null,
      sessionId,
      nowIso(),
      nowIso(),
      subscriber.id,
    )
    .run();

  return subscriber.id;
}

export async function cancelPendingSubscriberByCheckout(env, checkoutSession) {
  const sessionId = checkoutSession.id || null;
  if (!sessionId) {
    return 0;
  }

  const timestamp = nowIso();
  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          email_cipher = NULL,
          email_hash = NULL,
          account_email_cipher = NULL,
          account_email_hash = NULL,
          account_email_source = NULL,
          phone_cipher = NULL,
          phone_hash = NULL,
          phone_country = NULL,
          sms_consent_ip_hash = NULL,
          sms_consent_user_agent_hash = NULL,
          checkout_url = NULL,
          canceled_at = ?,
          contact_redacted_at = COALESCE(contact_redacted_at, ?),
          updated_at = ?
        WHERE stripe_checkout_session_id = ?
          AND status = ?
      `,
    )
    .bind(SUBSCRIBER_STATUS.CANCELED, timestamp, timestamp, timestamp, sessionId, SUBSCRIBER_STATUS.PENDING)
    .run();

  return result.meta?.changes || 0;
}

export async function updateSubscriberFromSubscription(env, subscription) {
  const subscriptionId = subscription.id || null;
  if (!subscriptionId) {
    return null;
  }

  const db = getDb(env);
  const signupId = subscription.metadata?.signup_id || null;
  const subscriber = signupId
    ? await db.prepare("SELECT * FROM notification_signups WHERE id = ?").bind(signupId).first()
    : await db
        .prepare("SELECT * FROM notification_signups WHERE stripe_subscription_id = ?")
        .bind(subscriptionId)
        .first();

  if (!subscriber) {
    return null;
  }

  const stripeStatus = String(subscription.status || "");
  const nextStatus =
    stripeStatus === "active" || stripeStatus === "trialing"
      ? SUBSCRIBER_STATUS.ACTIVE
      : stripeStatus === "canceled" || stripeStatus === "incomplete_expired"
        ? SUBSCRIBER_STATUS.CANCELED
        : SUBSCRIBER_STATUS.PAST_DUE;

  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = ?,
          current_period_end = ?,
          canceled_at = ?,
          stripe_cancel_at_period_end = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      nextStatus,
      subscription.customer || null,
      subscriptionId,
      unixSecondsToIso(getSubscriptionCurrentPeriodEnd(subscription)),
      nextStatus === SUBSCRIBER_STATUS.CANCELED ? nowIso() : null,
      subscription.cancel_at_period_end ? 1 : 0,
      nowIso(),
      subscriber.id,
    )
    .run();

  return subscriber.id;
}

export async function cancelSubscriberBySubscription(env, subscription) {
  const subscriptionId = subscription.id || null;
  if (!subscriptionId) {
    return null;
  }

  const db = getDb(env);
  const result = await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          canceled_at = ?,
          stripe_cancel_at_period_end = 0,
          updated_at = ?
        WHERE stripe_subscription_id = ?
      `,
    )
    .bind(SUBSCRIBER_STATUS.CANCELED, nowIso(), nowIso(), subscriptionId)
    .run();

  return result.meta?.changes || 0;
}

export async function getActiveSubscribers(env) {
  const db = getDb(env);
  const { results } = await db
    .prepare(
      `
        SELECT *
        FROM notification_signups
        WHERE status = ?
          AND (wants_email = 1 OR wants_sms = 1)
        ORDER BY created_at ASC
      `,
    )
    .bind(SUBSCRIBER_STATUS.ACTIVE)
    .all();

  return results || [];
}

export async function hydrateSubscriberContacts(env, subscriber) {
  const [email, accountEmail, phone] = await Promise.all([
    decryptString(env, subscriber.email_cipher),
    decryptString(env, subscriber.account_email_cipher),
    decryptString(env, subscriber.phone_cipher),
  ]);

  return {
    ...subscriber,
    email,
    alertEmail: email,
    accountEmail,
    phone,
    wantsEmail: Number(subscriber.wants_email || 0) === 1,
    wantsSms: Number(subscriber.wants_sms || 0) === 1,
    source: subscriber.source || "stripe",
    phoneCountry: subscriber.phone_country || (phone ? getPhoneCountry(phone) : null),
    stripeCancelAtPeriodEnd: Number(subscriber.stripe_cancel_at_period_end || 0) === 1,
  };
}

export async function getSubscriberById(env, subscriberId) {
  if (!subscriberId) {
    return null;
  }

  return getDb(env).prepare("SELECT * FROM notification_signups WHERE id = ?").bind(subscriberId).first();
}

export async function createManualSubscriber(env, payload = {}, requestContext = {}) {
  const accountEmail = normalizeEmail(payload.accountEmail || payload.email);
  const wantsEmail = Boolean(payload.wantsEmail);
  const email = wantsEmail ? normalizeEmail(payload.email || accountEmail) : null;
  const phone = normalizePhone(payload.phone);
  const wantsSms = Boolean(payload.wantsSms) && Boolean(phone);

  if (!accountEmail) {
    throw new HttpError(400, "Enter an account email address for the manual subscriber.");
  }
  if (!email && !phone) {
    throw new HttpError(400, "Enter an alert email address, a phone number, or both.");
  }
  if (phone && !isSupportedSmsPhone(phone)) {
    throw new HttpError(400, "Manual SMS subscribers must use a US or Canada phone number.");
  }
  if (wantsSms && !payload.smsConsent) {
    throw new HttpError(400, "Confirm SMS consent before enabling SMS for a manual subscriber.");
  }

  const phoneCountry = phone ? getPhoneCountry(phone) : null;
  const timestamp = nowIso();
  const [accountEmailHash, accountEmailCipher, emailHash, emailCipher, phoneHash, phoneCipher, consentIpHash, consentUserAgentHash] =
    await Promise.all([
      contactHash(env, "email", accountEmail),
      encryptString(env, accountEmail),
      contactHash(env, "email", email),
      encryptString(env, email),
      contactHash(env, "phone", phone),
      encryptString(env, phone),
      metadataHash(env, "sms_consent_ip", requestContext.ip),
      metadataHash(env, "sms_consent_user_agent", requestContext.userAgent),
    ]);
  const existing = await firstByContactHashes(env, emailHash, phoneHash, accountEmailHash);
  if (existing?.status === SUBSCRIBER_STATUS.ACTIVE || existing?.status === SUBSCRIBER_STATUS.PAST_DUE) {
    throw new HttpError(409, "That email address or phone number is already subscribed.");
  }

  const id = existing?.id || crypto.randomUUID();
  const createdAt = existing?.created_at || timestamp;
  const db = getDb(env);
  if (existing) {
    await db
      .prepare(
        `
          UPDATE notification_signups
          SET
            status = ?,
            source = ?,
            account_email_cipher = ?,
            account_email_hash = ?,
            account_email_source = ?,
            email_cipher = ?,
            email_hash = ?,
            phone_cipher = ?,
            phone_hash = ?,
            phone_country = ?,
            wants_email = ?,
            wants_sms = ?,
            sms_consent_at = ?,
            sms_consent_ip_hash = ?,
            sms_consent_user_agent_hash = ?,
            stripe_customer_id = NULL,
            stripe_subscription_id = NULL,
            stripe_checkout_session_id = NULL,
            stripe_product_id = NULL,
            stripe_price_id = NULL,
            checkout_url = NULL,
            checkout_created_at = NULL,
            checkout_completed_at = NULL,
            current_period_end = NULL,
            canceled_at = NULL,
            contact_redacted_at = NULL,
            sms_opted_out_at = NULL,
            sms_opt_out_source = NULL,
            email_opted_out_at = NULL,
            email_opt_out_source = NULL,
            stripe_cancel_at_period_end = 0,
            manual_note = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(
        SUBSCRIBER_STATUS.ACTIVE,
        "manual",
        accountEmailCipher,
        accountEmailHash,
        "manual",
        emailCipher,
        emailHash,
        phoneCipher,
        phoneHash,
        phoneCountry,
        wantsEmail ? 1 : 0,
        wantsSms ? 1 : 0,
        wantsSms ? timestamp : null,
        wantsSms ? consentIpHash : null,
        wantsSms ? consentUserAgentHash : null,
        String(payload.manualNote || "").trim() || null,
        timestamp,
        id,
      )
      .run();
  } else {
    await db
      .prepare(
        `
          INSERT INTO notification_signups (
            id,
            status,
            source,
            account_email_cipher,
            account_email_hash,
            account_email_source,
            email_cipher,
            email_hash,
            phone_cipher,
            phone_hash,
            phone_country,
            wants_email,
            wants_sms,
            sms_consent_at,
            sms_consent_ip_hash,
            sms_consent_user_agent_hash,
            manual_note,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        id,
        SUBSCRIBER_STATUS.ACTIVE,
        "manual",
        accountEmailCipher,
        accountEmailHash,
        "manual",
        emailCipher,
        emailHash,
        phoneCipher,
        phoneHash,
        phoneCountry,
        wantsEmail ? 1 : 0,
        wantsSms ? 1 : 0,
        wantsSms ? timestamp : null,
        wantsSms ? consentIpHash : null,
        wantsSms ? consentUserAgentHash : null,
        String(payload.manualNote || "").trim() || null,
        createdAt,
        timestamp,
      )
      .run();
  }

  return hydrateSubscriberContacts(env, await getSubscriberById(env, id));
}

export async function updateSubscriberContactSettings(env, subscriberId, payload = {}) {
  const subscriber = await getSubscriberById(env, subscriberId);
  if (!subscriber) {
    throw new HttpError(404, "Subscriber not found.");
  }

  const previous = await hydrateSubscriberContacts(env, subscriber);
  const accountEmail =
    subscriber.source === "manual"
      ? normalizeEmail(payload.accountEmail || payload.email || previous.accountEmail)
      : previous.accountEmail;
  const wantsEmail = Boolean(payload.wantsEmail);
  const email = wantsEmail ? normalizeEmail(payload.email || payload.accountEmail || accountEmail) : null;
  const phone = normalizePhone(payload.phone);
  const wantsSms = Boolean(payload.wantsSms);
  if (!accountEmail) {
    throw new HttpError(400, "Enter an account email address.");
  }
  if (wantsEmail && !email) {
    throw new HttpError(400, "Enter an alert email address.");
  }
  if (wantsSms && !phone) {
    throw new HttpError(400, "Enter a phone number before enabling SMS alerts.");
  }
  if (phone && !isSupportedSmsPhone(phone)) {
    throw new HttpError(400, "SMS alerts currently support US and Canada phone numbers only.");
  }

  const timestamp = nowIso();
  const phoneCountry = phone ? getPhoneCountry(phone) : null;
  const [accountEmailHash, accountEmailCipher, emailHash, emailCipher, phoneHash, phoneCipher] =
    subscriber.source === "manual"
      ? await Promise.all([
          contactHash(env, "email", accountEmail),
          encryptString(env, accountEmail),
          contactHash(env, "email", email),
          encryptString(env, email),
          contactHash(env, "phone", phone),
          encryptString(env, phone),
        ])
      : await Promise.all([
          Promise.resolve(subscriber.account_email_hash),
          Promise.resolve(subscriber.account_email_cipher),
          contactHash(env, "email", email),
          encryptString(env, email),
          contactHash(env, "phone", phone),
          encryptString(env, phone),
        ]);

  await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          account_email_cipher = ?,
          account_email_hash = ?,
          account_email_source = ?,
          email_cipher = ?,
          email_hash = ?,
          phone_cipher = ?,
          phone_hash = ?,
          phone_country = ?,
          wants_email = ?,
          wants_sms = ?,
          email_opted_out_at = CASE WHEN ? = 1 AND ? = 0 THEN ? ELSE email_opted_out_at END,
          email_opt_out_source = CASE WHEN ? = 1 AND ? = 0 THEN ? ELSE email_opt_out_source END,
          sms_opted_out_at = CASE WHEN ? = 1 AND ? = 0 THEN ? ELSE sms_opted_out_at END,
          sms_opt_out_source = CASE WHEN ? = 1 AND ? = 0 THEN ? ELSE sms_opt_out_source END,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      accountEmailCipher,
      accountEmailHash,
      subscriber.source === "manual" ? "manual" : subscriber.account_email_source,
      emailCipher,
      emailHash,
      phoneCipher,
      phoneHash,
      phoneCountry,
      wantsEmail ? 1 : 0,
      wantsSms ? 1 : 0,
      previous.wantsEmail ? 1 : 0,
      wantsEmail ? 1 : 0,
      timestamp,
      previous.wantsEmail ? 1 : 0,
      wantsEmail ? 1 : 0,
      SMS_OPT_OUT_SOURCE.MANAGE_LINK,
      previous.wantsSms ? 1 : 0,
      wantsSms ? 1 : 0,
      timestamp,
      previous.wantsSms ? 1 : 0,
      wantsSms ? 1 : 0,
      SMS_OPT_OUT_SOURCE.MANAGE_LINK,
      timestamp,
      subscriberId,
    )
    .run();

  return hydrateSubscriberContacts(env, await getSubscriberById(env, subscriberId));
}

export async function updateSubscriberEmailPreference(env, subscriberId, wantsEmail, source = SMS_OPT_OUT_SOURCE.MANAGE_LINK) {
  const timestamp = nowIso();
  await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          wants_email = ?,
          email_opted_out_at = CASE WHEN ? = 0 THEN COALESCE(email_opted_out_at, ?) ELSE NULL END,
          email_opt_out_source = CASE WHEN ? = 0 THEN ? ELSE NULL END,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(wantsEmail ? 1 : 0, wantsEmail ? 1 : 0, timestamp, wantsEmail ? 1 : 0, source, timestamp, subscriberId)
    .run();

  return hydrateSubscriberContacts(env, await getSubscriberById(env, subscriberId));
}

export async function updateSubscriberSmsPreference(env, subscriberId, wantsSms, source = SMS_OPT_OUT_SOURCE.MANAGE_LINK) {
  const timestamp = nowIso();
  await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          wants_sms = ?,
          sms_opted_out_at = CASE WHEN ? = 0 THEN COALESCE(sms_opted_out_at, ?) ELSE NULL END,
          sms_opt_out_source = CASE WHEN ? = 0 THEN ? ELSE NULL END,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(wantsSms ? 1 : 0, wantsSms ? 1 : 0, timestamp, wantsSms ? 1 : 0, source, timestamp, subscriberId)
    .run();

  return hydrateSubscriberContacts(env, await getSubscriberById(env, subscriberId));
}

export async function recordSubscriberWelcomeSent(env, subscriberId, channel) {
  const column = channel === "sms" ? "welcome_sms_sent_at" : "welcome_email_sent_at";
  await getDb(env)
    .prepare(`UPDATE notification_signups SET ${column} = ?, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), nowIso(), subscriberId)
    .run();
}

export async function markStripeSubscriptionCancelAtPeriodEnd(env, subscriptionId, cancelAtPeriodEnd = true) {
  if (!subscriptionId) {
    return 0;
  }

  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          stripe_cancel_at_period_end = ?,
          updated_at = ?
        WHERE stripe_subscription_id = ?
      `,
    )
    .bind(cancelAtPeriodEnd ? 1 : 0, nowIso(), subscriptionId)
    .run();

  return result.meta?.changes || 0;
}

export async function cancelManualSubscriber(env, subscriberId) {
  const timestamp = nowIso();
  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          status = ?,
          account_email_cipher = NULL,
          account_email_hash = NULL,
          account_email_source = NULL,
          email_cipher = NULL,
          email_hash = NULL,
          phone_cipher = NULL,
          phone_hash = NULL,
          phone_country = NULL,
          wants_email = 0,
          wants_sms = 0,
          sms_consent_at = NULL,
          sms_consent_ip_hash = NULL,
          sms_consent_user_agent_hash = NULL,
          canceled_at = COALESCE(canceled_at, ?),
          contact_redacted_at = COALESCE(contact_redacted_at, ?),
          manual_note = NULL,
          updated_at = ?
        WHERE id = ?
          AND source = 'manual'
      `,
    )
    .bind(SUBSCRIBER_STATUS.CANCELED, timestamp, timestamp, timestamp, subscriberId)
    .run();

  return result.meta?.changes || 0;
}

export async function optOutSmsByPhoneHash(env, phoneHash, source = SMS_OPT_OUT_SOURCE.SMS_STOP) {
  if (!phoneHash) {
    return [];
  }

  const db = getDb(env);
  const { results } = await db
    .prepare(
      `
        SELECT id, source, status, stripe_subscription_id
        FROM notification_signups
        WHERE phone_hash = ?
          AND status IN (?, ?)
      `,
    )
    .bind(phoneHash, SUBSCRIBER_STATUS.ACTIVE, SUBSCRIBER_STATUS.PAST_DUE)
    .all();
  const rows = results || [];
  if (!rows.length) {
    return [];
  }

  const timestamp = nowIso();
  await db
    .prepare(
      `
        UPDATE notification_signups
        SET
          wants_sms = 0,
          sms_opted_out_at = COALESCE(sms_opted_out_at, ?),
          sms_opt_out_source = ?,
          updated_at = ?
        WHERE phone_hash = ?
          AND wants_sms = 1
          AND status IN (?, ?)
      `,
    )
    .bind(timestamp, source, timestamp, phoneHash, SUBSCRIBER_STATUS.ACTIVE, SUBSCRIBER_STATUS.PAST_DUE)
    .run();

  return rows;
}

export async function getMetaValue(env, key) {
  const row = await getDb(env).prepare("SELECT value FROM notification_meta WHERE key = ?").bind(key).first();
  return row?.value || null;
}

export async function setMetaValue(env, key, value) {
  await getDb(env)
    .prepare(
      `
        INSERT INTO notification_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .bind(key, String(value), nowIso())
    .run();
}

async function recalculateAlertDeliveryCounts(env, alertId) {
  const row = await getDb(env)
    .prepare(
      `
        SELECT
          SUM(CASE WHEN channel = 'email' AND status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS email_sent_count,
          SUM(CASE WHEN channel = 'sms' AND status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS sms_sent_count,
          SUM(CASE WHEN status IN ('failed', 'undelivered') THEN 1 ELSE 0 END) AS error_count
        FROM notification_deliveries
        WHERE alert_id = ?
      `,
    )
    .bind(alertId)
    .first();

  const errorCount = Number(row?.error_count || 0);
  await getDb(env)
    .prepare(
      `
        UPDATE notification_alerts
        SET
          email_sent_count = ?,
          sms_sent_count = ?,
          error_count = ?,
          status = CASE
            WHEN ? > 0 THEN 'completed_with_errors'
            WHEN status = 'created' THEN 'sent'
            ELSE status
          END,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(
      Number(row?.email_sent_count || 0),
      Number(row?.sms_sent_count || 0),
      errorCount,
      errorCount,
      nowIso(),
      alertId,
    )
    .run();
}

export async function createAlertRecord(env, { kind, source, level, slotKey, messageText, status = "created" }) {
  const id = crypto.randomUUID();
  await getDb(env)
    .prepare(
      `
        INSERT INTO notification_alerts (
          id,
          kind,
          source,
          level,
          slot_key,
          message_text,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(id, kind, source, level ?? null, slotKey || null, messageText, status, nowIso())
    .run();

  return id;
}

export async function updateAlertRecord(env, alertId, summary) {
  await getDb(env)
    .prepare(
      `
        UPDATE notification_alerts
        SET
          status = ?,
          subscriber_count = ?,
          email_sent_count = ?,
          sms_sent_count = ?,
          error_count = ?,
          sent_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .bind(
      summary.status,
      summary.subscriberCount || 0,
      summary.emailSentCount || 0,
      summary.smsSentCount || 0,
      summary.errorCount || 0,
      nowIso(),
      alertId,
    )
    .run();
}

export async function recordDelivery(env, delivery) {
  await getDb(env)
    .prepare(
      `
        INSERT INTO notification_deliveries (
          id,
          alert_id,
          subscriber_id,
          channel,
          destination_hash,
          status,
          provider_message_id,
          error,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      crypto.randomUUID(),
      delivery.alertId,
      delivery.subscriberId || null,
      delivery.channel,
      delivery.destinationHash || null,
      delivery.status,
      delivery.providerMessageId || null,
      delivery.error ? String(delivery.error).slice(0, 1000) : null,
      nowIso(),
      nowIso(),
    )
    .run();
}

export async function getRecentAlertDeliveries(env, limit = 25) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { results } = await getDb(env)
    .prepare(
      `
        SELECT
          a.id AS alert_id,
          a.kind,
          a.status AS alert_status,
          a.subscriber_count,
          a.email_sent_count,
          a.sms_sent_count,
          a.error_count,
          a.created_at AS alert_created_at,
          a.sent_at,
          d.channel,
          d.status AS delivery_status,
          d.provider_message_id,
          d.error,
          d.created_at AS delivery_created_at,
          d.updated_at AS delivery_updated_at
        FROM notification_alerts a
        LEFT JOIN notification_deliveries d ON d.alert_id = a.id
        ORDER BY a.created_at DESC, d.created_at DESC
        LIMIT ?
      `,
    )
    .bind(safeLimit)
    .all();

  return results || [];
}

function clampAdminSubscriberPage(value) {
  const page = Math.trunc(Number(value || 1));
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function clampAdminSubscriberPageSize(value) {
  const pageSize = Math.trunc(Number(value || 20));
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 20;
  }

  return Math.min(pageSize, 100);
}

function mapSubscriberSummary(row = {}) {
  return {
    total: Number(row.total || 0),
    active: Number(row.active || 0),
    pending_checkout: Number(row.pending_checkout || 0),
    past_due: Number(row.past_due || 0),
    canceled: Number(row.canceled || 0),
    wantsEmail: Number(row.wants_email || 0),
    wantsSms: Number(row.wants_sms || 0),
    wantsBoth: Number(row.wants_both || 0),
  };
}

function mapSubscriberDailyStats(row) {
  const active = Number(row.active || 0);
  return {
    day: row.day,
    active,
    pending: Number(row.pending || 0),
    canceled: Number(row.canceled || 0),
    email: Number(row.email || 0),
    sms: Number(row.sms || 0),
    both: Number(row.both || 0),
    grossVolume: active * 5,
  };
}

async function mapAdminSubscriberRow(env, row) {
  const [email, accountEmail, phone] = await Promise.all([
    decryptString(env, row.email_cipher),
    decryptString(env, row.account_email_cipher),
    decryptString(env, row.phone_cipher),
  ]);

  return {
    id: row.id,
    status: row.status,
    source: row.source || "stripe",
    email,
    emailHash: row.email_hash,
    accountEmail,
    accountEmailHash: row.account_email_hash,
    accountEmailSource: row.account_email_source,
    phone,
    phoneHash: row.phone_hash,
    phoneCountry: row.phone_country,
    wantsEmail: Number(row.wants_email || 0) === 1,
    wantsSms: Number(row.wants_sms || 0) === 1,
    smsConsentAt: row.sms_consent_at,
    smsConsentIpHash: row.sms_consent_ip_hash,
    smsConsentUserAgentHash: row.sms_consent_user_agent_hash,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripeProductId: row.stripe_product_id,
    stripePriceId: row.stripe_price_id,
    checkoutUrl: row.checkout_url,
    checkoutCreatedAt: row.checkout_created_at,
    checkoutCompletedAt: row.checkout_completed_at,
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at,
    contactRedactedAt: row.contact_redacted_at,
    smsOptedOutAt: row.sms_opted_out_at,
    smsOptOutSource: row.sms_opt_out_source,
    emailOptedOutAt: row.email_opted_out_at,
    emailOptOutSource: row.email_opt_out_source,
    welcomeEmailSentAt: row.welcome_email_sent_at,
    welcomeSmsSentAt: row.welcome_sms_sent_at,
    stripeCancelAtPeriodEnd: Number(row.stripe_cancel_at_period_end || 0) === 1,
    manualNote: row.manual_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasEmailCipher: Boolean(row.email_cipher),
    hasAccountEmailCipher: Boolean(row.account_email_cipher),
    hasPhoneCipher: Boolean(row.phone_cipher),
    deliveryCount: Number(row.delivery_count || 0),
    emailDeliveryCount: Number(row.email_delivery_count || 0),
    smsDeliveryCount: Number(row.sms_delivery_count || 0),
    deliveryErrorCount: Number(row.delivery_error_count || 0),
    lastDeliveryAt: row.last_delivery_at,
  };
}

export async function getAdminSubscriberRecords(env, options = {}) {
  const page = clampAdminSubscriberPage(options.page);
  const pageSize = clampAdminSubscriberPageSize(options.pageSize);
  const offset = (page - 1) * pageSize;
  const summaryQuery = `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'pending_checkout' THEN 1 ELSE 0 END) AS pending_checkout,
          SUM(CASE WHEN status = 'past_due' THEN 1 ELSE 0 END) AS past_due,
          SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
          SUM(CASE WHEN wants_email = 1 THEN 1 ELSE 0 END) AS wants_email,
          SUM(CASE WHEN wants_sms = 1 THEN 1 ELSE 0 END) AS wants_sms,
          SUM(CASE WHEN wants_email = 1 AND wants_sms = 1 THEN 1 ELSE 0 END) AS wants_both
        FROM notification_signups
      `;
  const dailyStatsQuery = `
        SELECT
          day,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'pending_checkout' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
          SUM(CASE WHEN wants_email = 1 THEN 1 ELSE 0 END) AS email,
          SUM(CASE WHEN wants_sms = 1 THEN 1 ELSE 0 END) AS sms,
          SUM(CASE WHEN wants_email = 1 AND wants_sms = 1 THEN 1 ELSE 0 END) AS both
        FROM (
          SELECT
            status,
            wants_email,
            wants_sms,
            SUBSTR(
              CASE
                WHEN status = 'active' THEN COALESCE(checkout_completed_at, checkout_created_at, created_at)
                WHEN status = 'canceled' THEN COALESCE(canceled_at, updated_at, created_at)
                ELSE COALESCE(checkout_created_at, created_at, updated_at)
              END,
              1,
              10
            ) AS day
          FROM notification_signups
        )
        WHERE day IS NOT NULL AND day != ''
        GROUP BY day
        ORDER BY day ASC
      `;
  const subscribersQuery = `
        SELECT
          s.*,
          COUNT(d.id) AS delivery_count,
          SUM(CASE WHEN d.channel = 'email' THEN 1 ELSE 0 END) AS email_delivery_count,
          SUM(CASE WHEN d.channel = 'sms' THEN 1 ELSE 0 END) AS sms_delivery_count,
          SUM(CASE WHEN d.status IN ('failed', 'undelivered') THEN 1 ELSE 0 END) AS delivery_error_count,
          MAX(COALESCE(d.updated_at, d.created_at)) AS last_delivery_at
        FROM (
          SELECT *
          FROM notification_signups
          ORDER BY
            CASE status
              WHEN 'active' THEN 0
              WHEN 'pending_checkout' THEN 1
              WHEN 'past_due' THEN 2
              ELSE 3
            END,
            updated_at DESC,
            id ASC
          LIMIT ? OFFSET ?
        ) s
        LEFT JOIN notification_deliveries d ON d.subscriber_id = s.id
        GROUP BY s.id
        ORDER BY
          CASE s.status
            WHEN 'active' THEN 0
            WHEN 'pending_checkout' THEN 1
            WHEN 'past_due' THEN 2
            ELSE 3
          END,
          s.updated_at DESC,
          s.id ASC
      `;

  const [summaryRows, dailyStatsRows, subscriberRows] = await Promise.all([
    queryRows(env, summaryQuery),
    queryRows(env, dailyStatsQuery),
    queryRows(env, subscribersQuery, [pageSize, offset]),
  ]);
  const summary = mapSubscriberSummary(summaryRows[0]);
  const subscribers = await Promise.all(subscriberRows.map((row) => mapAdminSubscriberRow(env, row)));

  return {
    subscribers,
    summary,
    dailyStats: dailyStatsRows.map(mapSubscriberDailyStats),
    page,
    pageSize,
    total: summary.total,
  };
}

export async function getSubscriberForCustomerPortal(env, subscriberId) {
  if (!subscriberId) {
    return null;
  }

  return getDb(env)
    .prepare(
      `
        SELECT
          id,
          status,
          stripe_customer_id
        FROM notification_signups
        WHERE id = ?
      `,
    )
    .bind(subscriberId)
    .first();
}

export async function updateDeliveryByProviderMessageId(env, providerMessageId, { status, error = null }) {
  if (!providerMessageId) {
    return null;
  }

  const db = getDb(env);
  const existing = await db
    .prepare(
      `
        SELECT id, alert_id
        FROM notification_deliveries
        WHERE provider_message_id = ?
        LIMIT 1
      `,
    )
    .bind(providerMessageId)
    .first();
  if (!existing) {
    return null;
  }

  await db
    .prepare(
      `
        UPDATE notification_deliveries
        SET
          status = ?,
          error = ?,
          updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(status, error ? String(error).slice(0, 1000) : null, nowIso(), existing.id)
    .run();

  await recalculateAlertDeliveryCounts(env, existing.alert_id);
  return existing.alert_id;
}

export async function updateSmsPreferenceByPhoneHash(env, phoneHash, wantsSms) {
  if (!phoneHash) {
    return 0;
  }

  const timestamp = nowIso();
  const result = await getDb(env)
    .prepare(
      `
        UPDATE notification_signups
        SET
          wants_sms = ?,
          sms_opted_out_at = CASE WHEN ? = 0 THEN COALESCE(sms_opted_out_at, ?) ELSE NULL END,
          sms_opt_out_source = CASE WHEN ? = 0 THEN ? ELSE NULL END,
          updated_at = ?
        WHERE phone_hash = ?
      `,
    )
    .bind(
      wantsSms ? 1 : 0,
      wantsSms ? 1 : 0,
      timestamp,
      wantsSms ? 1 : 0,
      SMS_OPT_OUT_SOURCE.SMS_STOP,
      timestamp,
      phoneHash,
    )
    .run();

  return result.meta?.changes || 0;
}
