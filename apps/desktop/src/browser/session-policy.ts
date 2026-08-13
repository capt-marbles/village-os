import type { WebPreferences } from "electron";

export type BrowserSite = "OWNED_FIXTURE" | "LINKEDIN";

const allowedOrigin: Record<BrowserSite, string> = {
  OWNED_FIXTURE: "https://fixture.village.test",
  LINKEDIN: "https://www.linkedin.com",
};

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
  if (url.protocol !== "https:" || url.origin !== allowedOrigin[site]) {
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
  return allowedOrigin[site];
}
