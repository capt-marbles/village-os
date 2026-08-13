import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { configureRemoteContents } from "../src/main/security.js";

describe("remote WebContents security wiring", () => {
  it("denies server redirects that leave the exact site origin", () => {
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

    const denied = { preventDefault: vi.fn() };
    listeners.get("will-redirect")?.(denied, "https://attacker.example/");
    expect(denied.preventDefault).toHaveBeenCalledOnce();

    const allowed = { preventDefault: vi.fn() };
    listeners.get("will-redirect")?.(
      allowed,
      "https://www.linkedin.com/checkpoint",
    );
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });
});
