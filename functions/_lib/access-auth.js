import { HttpError } from "./http.js";

// Cloudflare Access is the primary gate for /admin and /api/admin. This check
// re-verifies the Access JWT inside Functions so the admin API stays closed if
// the Access configuration ever stops covering a hostname or path.
//
// The issuer, certs URL, and audiences are fixed here on purpose: nothing from
// the request or the token decides where keys come from or which apps count.
export const ACCESS_TEAM_DOMAIN = "https://amends-pages.cloudflareaccess.com";
export const ACCESS_CERTS_URL = `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
export const ACCESS_AUDIENCES = Object.freeze([
  // EWS Admin - Custom Domain (ews.kylemcdonald.net)
  "bb73d1781d4d4e0631dce2e36f69ad64305d1b8d9331f41a7f440c7671db8142",
  // EWS Admin - Pages Dev (apocalypse-ews.pages.dev, previews, aews.cc)
  "586f6194f465dab4278212d633ce6a3e735b5e034f87b4085d27ed5e8e8b600e",
]);

const CLOCK_SKEW_SECONDS = 60;
const CERTS_TTL_MS = 60 * 60 * 1000;
const CERTS_MIN_REFRESH_MS = 30 * 1000;

let certsCache = { keys: null, fetchedAt: 0 };

export function resetAccessCertsCache() {
  certsCache = { keys: null, fetchedAt: 0 };
}

function decodeBase64Url(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new HttpError(401, "Unauthorized.");
  }
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJsonSegment(segment) {
  try {
    const value = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  } catch {
    // Fall through to the generic rejection below.
  }
  throw new HttpError(401, "Unauthorized.");
}

async function fetchCerts(fetchImpl) {
  const response = await fetchImpl(ACCESS_CERTS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new HttpError(503, "Admin authentication is temporarily unavailable.");
  }
  const body = await response.json();
  const keys = Array.isArray(body?.keys)
    ? body.keys.filter((key) => key && key.kty === "RSA" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string")
    : [];
  if (!keys.length) {
    throw new HttpError(503, "Admin authentication is temporarily unavailable.");
  }
  certsCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function findSigningKey(kid, fetchImpl) {
  const age = Date.now() - certsCache.fetchedAt;
  let keys = certsCache.keys && age < CERTS_TTL_MS ? certsCache.keys : await fetchCerts(fetchImpl);
  let jwk = keys.find((key) => key.kid === kid);
  // Access rotates keys; refetch once for an unknown kid, but not on every request.
  if (!jwk && Date.now() - certsCache.fetchedAt >= CERTS_MIN_REFRESH_MS) {
    keys = await fetchCerts(fetchImpl);
    jwk = keys.find((key) => key.kid === kid);
  }
  if (!jwk) {
    throw new HttpError(401, "Unauthorized.");
  }
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifyAccessJwt(token, { fetchImpl = fetch, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) {
    throw new HttpError(401, "Unauthorized.");
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeJsonSegment(headerSegment);
  // Only RS256 is accepted; this rejects "none", HMAC, and algorithm confusion.
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new HttpError(401, "Unauthorized.");
  }

  const key = await findSigningKey(header.kid, fetchImpl);
  const signature = decodeBase64Url(signatureSegment);
  const signedData = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!valid) {
    throw new HttpError(401, "Unauthorized.");
  }

  const payload = decodeJsonSegment(payloadSegment);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== ACCESS_TEAM_DOMAIN || !audiences.some((aud) => ACCESS_AUDIENCES.includes(aud))) {
    throw new HttpError(401, "Unauthorized.");
  }
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS <= nowSeconds) {
    throw new HttpError(401, "Unauthorized.");
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new HttpError(401, "Unauthorized.");
  }

  return payload;
}

export async function requireAccessAuth(request, options) {
  // Only the header Access injects at the edge is accepted, not the cookie.
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new HttpError(401, "Unauthorized.");
  }
  try {
    return await verifyAccessJwt(token, options);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // Malformed base64, bad key material, or a failed certs fetch: still closed.
    console.error("Access JWT verification failed", error);
    throw new HttpError(401, "Unauthorized.");
  }
}
