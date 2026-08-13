import type { WebPreferences } from "electron";
import { commandPolicyFor, type Site } from "@village/contracts";

export type BrowserSite = Site;

export const browserWebPreferences = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  devTools: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  autoplayPolicy: "user-gesture-required",
} satisfies WebPreferences);

export function decideNavigation(
  site: BrowserSite,
  candidate: string,
): { allow: true } | { allow: false; code: "NAVIGATION_DENIED" } {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { allow: false, code: "NAVIGATION_DENIED" };
  }
  const policy = commandPolicyFor(site);
  if (
    url.protocol !== "https:" ||
    !policy.allowedOrigins.some((origin) => origin === url.origin)
  ) {
    return { allow: false, code: "NAVIGATION_DENIED" };
  }
  return { allow: true };
}

export function decidePopup(): { action: "deny" } {
  return { action: "deny" };
}

export function isPermissionAllowed(_permission: string): false {
  return false;
}

export function originForSite(site: BrowserSite): string {
  const [origin] = commandPolicyFor(site).allowedOrigins;
  if (!origin) throw new Error("SITE_POLICY_MISSING_ORIGIN");
  return origin;
}
