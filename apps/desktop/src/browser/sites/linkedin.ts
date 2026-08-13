const supportedIdentityOrigins = new Set([
  "https://accounts.google.com",
  "https://login.microsoftonline.com",
  "https://appleid.apple.com",
]);

export type LinkedInRoute =
  | "SIGN_IN"
  | "AUTHENTICATED"
  | "FEDERATED_IDENTITY"
  | "HUMAN_CHALLENGE"
  | "UNKNOWN";

function classifyParsedLinkedInRoute(url: URL): LinkedInRoute {
  if (supportedIdentityOrigins.has(url.origin)) return "FEDERATED_IDENTITY";
  if (url.origin !== "https://www.linkedin.com") return "UNKNOWN";
  if (
    url.pathname.startsWith("/checkpoint/") ||
    url.pathname.startsWith("/uas/consumer-email-challenge")
  ) {
    return "HUMAN_CHALLENGE";
  }
  if (
    url.pathname === "/login" ||
    url.pathname.startsWith("/uas/login") ||
    url.pathname.startsWith("/signup")
  ) {
    return "SIGN_IN";
  }
  if (url.pathname.startsWith("/feed")) {
    return "AUTHENTICATED";
  }
  return "UNKNOWN";
}

export function classifyLinkedInRoute(candidate: string): LinkedInRoute {
  try {
    return classifyParsedLinkedInRoute(new URL(candidate));
  } catch {
    return "UNKNOWN";
  }
}

export function authorizeLinkedInNavigation(
  candidate: string,
):
  | { allow: true; route: LinkedInRoute }
  | { allow: false; code: "LINKEDIN_DESTINATION_DENIED" } {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { allow: false, code: "LINKEDIN_DESTINATION_DENIED" };
  }
  const route = classifyParsedLinkedInRoute(url);
  return route === "UNKNOWN" || route === "FEDERATED_IDENTITY"
    ? { allow: false, code: "LINKEDIN_DESTINATION_DENIED" }
    : { allow: true, route };
}

export const linkedInPolicy = Object.freeze({
  automation: "HUMAN_ONLY" as const,
  debuggerAttachmentAllowed: false,
  repeatedLoginAllowed: false,
  autonomousCredentialSubmissionAllowed: false,
  autonomousPostLoginActionsAllowed: false,
  distribution: "REQUIRES_WRITTEN_TERMS_REVIEW" as const,
  authorizeAction(action: BrowserSiteAction) {
    return authorizeBrowserSiteAction("LINKEDIN", action);
  },
});
import {
  authorizeBrowserSiteAction,
  type BrowserSiteAction,
} from "@village/contracts";
