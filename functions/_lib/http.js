export function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

export function methodNotAllowed() {
  return jsonResponse({ error: "Method not allowed." }, { status: 405 });
}

export async function readJsonRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "Expected application/json.");
  }

  return request.json();
}

export function getRequestIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}

export function getRequestUserAgent(request) {
  return request.headers.get("user-agent") || null;
}

export function getOriginBaseUrl(request, env) {
  const configuredUrl = String(env.APP_BASE_URL || env.EWS_PUBLIC_URL || "").trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, "");
  }

  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function handleError(error) {
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        error: error.message,
        details: error.details || undefined,
      },
      { status: error.status },
    );
  }

  console.error(error);
  return jsonResponse({ error: "Internal server error." }, { status: 500 });
}
