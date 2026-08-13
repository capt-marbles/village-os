import type { Environment } from "../env.js";

function allowedOrigins(environment: Environment): Set<string> {
  return new Set(
    environment.VILLAGE_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function corsHeaders(
  request: Request,
  environment: Environment,
): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    vary: "Origin",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins(environment).has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    headers.set(
      "access-control-allow-headers",
      "content-type,x-village-connection-id,x-village-csrf,x-village-development-principal",
    );
  }
  return headers;
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export function authorizeBrowserMutation(
  request: Request,
  environment: Environment,
): { ok: true } | { ok: false; code: string } {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(environment).has(origin)) {
    return { ok: false, code: "ORIGIN_DENIED" };
  }
  const header = request.headers.get("x-village-csrf");
  const cookie = cookieValue(request, "village_csrf");
  if (!header || !cookie || header !== cookie || header.length < 32) {
    return { ok: false, code: "CSRF_DENIED" };
  }
  return { ok: true };
}

export function authorizeNonBrowserClient(
  request: Request,
  environment: Environment,
): { ok: true } | { ok: false; code: string } {
  const origin = request.headers.get("origin");
  if (!origin) return { ok: true };
  return allowedOrigins(environment).has(origin)
    ? { ok: true }
    : { ok: false, code: "ORIGIN_DENIED" };
}
