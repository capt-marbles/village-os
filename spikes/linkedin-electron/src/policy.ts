export const LINKEDIN_PARTITION = "persist:village-principal-local-device-local-linkedin";
export const LINKEDIN_LOGIN_URL = "https://www.linkedin.com/login";

export const remoteWebPreferences = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  devTools: false,
  partition: LINKEDIN_PARTITION,
});

export type AuthRoute =
  | "standard"
  | "human-challenge"
  | "human-2fa"
  | "human-password-reset"
  | "human-terms-or-consent"
  | "unsupported-federated"
  | "unsupported-passkey"
  | "unknown";

export type AuthenticationStatus = "authenticated" | "confirmed_by_user" | "not_authenticated" | "unknown";
export const authenticationPredicateVersion = "linkedin-url-v1";

const linkedinHosts = new Set(["linkedin.com", "www.linkedin.com"]);
const federatedHosts = new Set([
  "accounts.google.com",
  "appleid.apple.com",
  "login.microsoftonline.com",
]);

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export function classifyAuthRoute(raw: string): AuthRoute {
  const url = parseUrl(raw);
  if (!url) return "unknown";
  if (federatedHosts.has(url.hostname)) return "unsupported-federated";
  if (!linkedinHosts.has(url.hostname)) return "unknown";
  const route = `${url.pathname}${url.search}`.toLowerCase();
  if (route.includes("passkey") || route.includes("webauthn")) return "unsupported-passkey";
  if (route.includes("login-submit") || route.includes("two-step") || route.includes("two_factor")) return "human-2fa";
  if (route.includes("checkpoint") || route.includes("challenge") || route.includes("captcha")) return "human-challenge";
  if (route.includes("password-reset") || route.includes("request-password")) return "human-password-reset";
  if (route.includes("legal") || route.includes("consent") || route.includes("terms")) return "human-terms-or-consent";
  return "standard";
}

export function verifyAuthentication(raw: string, ownerConfirmed: boolean): {
  status: AuthenticationStatus;
  predicateVersion: typeof authenticationPredicateVersion;
} {
  const url = parseUrl(raw);
  if (!url || url.protocol !== "https:" || !linkedinHosts.has(url.hostname)) {
    return { status: "unknown", predicateVersion: authenticationPredicateVersion };
  }
  if (url.pathname.startsWith("/login") || url.pathname.startsWith("/uas/login")) {
    return { status: "not_authenticated", predicateVersion: authenticationPredicateVersion };
  }
  // URL alone is not proof of identity. The spike deliberately emits no automatic
  // authenticated result until a stronger, separately reviewed predicate exists.
  if (ownerConfirmed && (url.pathname.startsWith("/feed") || url.pathname.startsWith("/in/"))) {
    return { status: "confirmed_by_user", predicateVersion: authenticationPredicateVersion };
  }
  return { status: "unknown", predicateVersion: authenticationPredicateVersion };
}

export type PolicyDecision = { action: "allow" } | { action: "deny"; reason: string };

export function decideNavigation(raw: string): PolicyDecision {
  const url = parseUrl(raw);
  if (!url) return { action: "deny", reason: "invalid-url" };
  if (url.protocol !== "https:") return { action: "deny", reason: "https-required" };
  if (!linkedinHosts.has(url.hostname)) return { action: "deny", reason: "origin-not-allowlisted" };
  return { action: "allow" };
}

export function decidePopup(raw: string): PolicyDecision {
  const route = classifyAuthRoute(raw);
  if (route === "unsupported-federated" || route === "unsupported-passkey") {
    return { action: "deny", reason: route };
  }
  return { action: "deny", reason: "popups-disabled" };
}

export function decidePermission(_permission: string): PolicyDecision {
  return { action: "deny", reason: "permissions-disabled" };
}

export function decideDebuggerTarget(raw: string): PolicyDecision {
  const url = parseUrl(raw);
  if (url?.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    return { action: "allow" };
  }
  return { action: "deny", reason: "debugger-owned-fixture-only" };
}

export const prohibitedLinkedInCapabilities = Object.freeze([
  "credential-submission",
  "scraping",
  "messaging",
  "posting",
  "reacting",
  "connections",
  "repeated-login",
  "debugger-or-cdp",
]);
