import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { browserWebPreferences } from "../src/browser/session-policy.js";
import {
  isTrustedVillageSender,
  trustedWebPreferences,
} from "../src/main/security.js";

function sender(url: string, destroyed = false): WebContents {
  return {
    getURL: () => url,
    isDestroyed: () => destroyed,
  } as unknown as WebContents;
}

describe("trusted and remote view isolation", () => {
  it("gives only immutable local app code a narrow preload", () => {
    expect(isTrustedVillageSender(sender("village://app/"))).toBe(true);
    expect(isTrustedVillageSender(sender("https://village.example/"))).toBe(
      false,
    );
    expect(isTrustedVillageSender(sender("village://app.evil/"))).toBe(false);
    expect(isTrustedVillageSender(sender("village://app/", true))).toBe(false);

    expect(trustedWebPreferences("/app/preload.cjs")).toMatchObject({
      preload: "/app/preload.cjs",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: false,
    });
  });

  it("never gives remote content a preload or privileged renderer features", () => {
    expect(browserWebPreferences.preload).toBeUndefined();
    expect(browserWebPreferences.nodeIntegration).toBe(false);
    expect(browserWebPreferences.contextIsolation).toBe(true);
    expect(browserWebPreferences.sandbox).toBe(true);
    expect(browserWebPreferences.devTools).toBe(false);
  });
});
