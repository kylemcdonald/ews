import { hmacHex } from "./crypto.js";
import { timingSafeEqualHex } from "./encoding.js";
import { HttpError } from "./http.js";

const DEFAULT_PUBLIC_URL = "https://ews.kylemcdonald.net/";

export function getPublicBaseUrl(env) {
  return String(env.APP_BASE_URL || env.EWS_PUBLIC_URL || DEFAULT_PUBLIC_URL)
    .trim()
    .replace(/\/+$/, "");
}

function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function getSubscriberStripeCustomerId(subscriber) {
  return subscriber?.stripe_customer_id || subscriber?.stripeCustomerId || null;
}

function requirePortalSecret(env) {
  const secret = String(env.NOTIFICATION_HASH_SECRET || "").trim();
  if (!secret) {
    throw new HttpError(500, "Missing required secret: NOTIFICATION_HASH_SECRET.");
  }

  return secret;
}

async function createCustomerPortalToken(env, subscriber) {
  const customerId = getSubscriberStripeCustomerId(subscriber);
  if (!subscriber?.id || !customerId) {
    throw new HttpError(500, "Subscriber is missing Stripe customer portal fields.");
  }

  return hmacHex(requirePortalSecret(env), `customer_portal:${subscriber.id}:${customerId}`);
}

async function createAccountManagementToken(env, subscriber) {
  if (!subscriber?.id || !subscriber?.created_at) {
    throw new HttpError(500, "Subscriber is missing account management fields.");
  }

  return hmacHex(requirePortalSecret(env), `account_management:${subscriber.id}:${subscriber.created_at}`);
}

export async function createCustomerPortalLink(env, subscriber, options = {}) {
  const token = await createCustomerPortalToken(env, subscriber);
  const url = new URL("/api/stripe/customer-portal", normalizeBaseUrl(options.baseUrl) || getPublicBaseUrl(env));
  url.searchParams.set("subscriber", subscriber.id);
  url.searchParams.set("token", token);

  return url.toString();
}

export async function createAccountManagementPath(env, subscriber) {
  const token = await createAccountManagementToken(env, subscriber);
  const searchParams = new URLSearchParams({
    subscriber: subscriber.id,
    token,
  });

  return `/manage?${searchParams.toString()}`;
}

export async function createAccountManagementLink(env, subscriber, options = {}) {
  const path = await createAccountManagementPath(env, subscriber);
  return new URL(path, normalizeBaseUrl(options.baseUrl) || getPublicBaseUrl(env)).toString();
}

export async function verifyCustomerPortalToken(env, subscriber, token) {
  const expectedToken = await createCustomerPortalToken(env, subscriber);
  return timingSafeEqualHex(token, expectedToken);
}

export async function verifyAccountManagementToken(env, subscriber, token) {
  const expectedToken = await createAccountManagementToken(env, subscriber);
  return timingSafeEqualHex(token, expectedToken);
}
