import { describe, expect, it } from "vitest";
import {
  browserWebPreferences,
  decideNavigation,
  decidePopup,
  isPermissionAllowed,
} from "../src/browser/session-policy.js";

describe("remote browser deny policy", () => {
  it("allows exact top-level HTTPS destinations for the selected site", () => {
    expect(
      decideNavigation("OWNED_FIXTURE", "https://fixture.village.test/login"),
    ).toEqual({ allow: true });
    expect(
      decideNavigation("LINKEDIN", "https://www.linkedin.com/login"),
    ).toEqual({ allow: true });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "http://www.linkedin.com/login",
    "https://evil.example/login",
    "https://www.linkedin.com.evil.example/login",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
  ])("rejects unsafe navigation %s", (url) => {
    expect(decideNavigation("LINKEDIN", url)).toEqual({
      allow: false,
      code: "NAVIGATION_DENIED",
    });
  });

  it("denies popups, permissions, and privileged renderer features", () => {
    expect(decidePopup()).toEqual({ action: "deny" });
    expect(isPermissionAllowed("notifications")).toBe(false);
    expect(browserWebPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    });
    expect(browserWebPreferences.preload).toBeUndefined();
  });
});
