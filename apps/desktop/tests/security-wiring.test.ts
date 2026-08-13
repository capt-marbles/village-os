import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { configureRemoteContents } from "../src/main/security.js";

describe("remote WebContents security wiring", () => {
  it.each(["will-navigate", "will-redirect"] as const)(
    "allows exact-origin and denies cross-origin %s events",
    (navigationEvent) => {
      const listeners = new Map<string, (...arguments_: unknown[]) => void>();
      const contents = {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(
          (event: string, listener: (...arguments_: unknown[]) => void) => {
            listeners.set(event, listener);
          },
        ),
        setVisualZoomLevelLimits: vi.fn(async () => undefined),
      } as unknown as WebContents;
      configureRemoteContents(contents, "LINKEDIN");

      const denied = {
        url: "https://attacker.example/",
        preventDefault: vi.fn(),
      };
      listeners.get(navigationEvent)?.(denied);
      expect(denied.preventDefault).toHaveBeenCalledOnce();

      const allowed = {
        url: "https://www.linkedin.com/checkpoint",
        preventDefault: vi.fn(),
      };
      listeners.get(navigationEvent)?.(allowed);
      expect(allowed.preventDefault).not.toHaveBeenCalled();
    },
  );
});
