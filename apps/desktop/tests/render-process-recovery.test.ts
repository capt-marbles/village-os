import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LocalActionExecutor } from "../src/browser/local-action-executor.js";
import { DesktopBrowserUiState } from "../src/main/desktop-browser-ui-state.js";
import { RenderProcessRecovery } from "../src/main/render-process-recovery.js";

describe("render process recovery", () => {
  it("fences browser automation and publishes only a bounded diagnostic", () => {
    const browser = new EventEmitter();
    const trustedRenderer = new EventEmitter();
    const executor = new LocalActionExecutor({ leaseEpoch: 1 });
    const uiState = new DesktopBrowserUiState();
    const fenceBrowser = vi.fn(() => executor.markOfflineTakeover());
    const markBrowserUnavailable = vi.fn(() =>
      uiState.markConnection("ABSENT"),
    );
    const capture = vi.fn();
    const recovery = new RenderProcessRecovery({
      browser,
      trustedRenderer,
      fenceBrowser,
      markBrowserUnavailable,
      capture,
      reloadTrustedRenderer: vi.fn(),
      republishTrustedState: vi.fn(),
    });

    recovery.start();
    browser.emit(
      "render-process-gone",
      {},
      {
        reason: "crashed with https://private.example/?token=secret",
        exitCode: 137,
      },
    );

    expect(fenceBrowser).toHaveBeenCalledOnce();
    expect(markBrowserUnavailable).toHaveBeenCalledOnce();
    expect(executor.isAutomationBlocked()).toBe(true);
    expect(uiState.current()).toMatchObject({
      jobState: "WAITING_FOR_BROWSER",
      connection: "ABSENT",
      controller: "NONE",
      takeover: "NONE",
    });
    expect(capture).toHaveBeenCalledWith({
      component: "BROWSER_HOST",
      code: "REMOTE_RENDERER_GONE",
      retriable: true,
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private");
    expect(JSON.stringify(capture.mock.calls)).not.toContain("137");
  });

  it("reloads only the trusted local surface and republishes current state", async () => {
    const browser = new EventEmitter();
    const trustedRenderer = new EventEmitter();
    const reloadTrustedRenderer = vi.fn(async () => undefined);
    const republishTrustedState = vi.fn();
    const capture = vi.fn();
    const recovery = new RenderProcessRecovery({
      browser,
      trustedRenderer,
      fenceBrowser: vi.fn(),
      markBrowserUnavailable: vi.fn(),
      capture,
      reloadTrustedRenderer,
      republishTrustedState,
    });

    recovery.start();
    trustedRenderer.emit(
      "render-process-gone",
      {},
      {
        reason: "oom",
        exitCode: 9,
      },
    );
    trustedRenderer.emit(
      "render-process-gone",
      {},
      {
        reason: "crashed",
        exitCode: 10,
      },
    );
    await recovery.settled();

    expect(reloadTrustedRenderer).toHaveBeenCalledOnce();
    expect(reloadTrustedRenderer).toHaveBeenCalledWith("village://app/");
    expect(republishTrustedState).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith({
      component: "BROWSER_HOST",
      code: "TRUSTED_RENDERER_GONE",
      retriable: true,
    });
  });

  it("reports a bounded reload failure and detaches before intentional close", async () => {
    const browser = new EventEmitter();
    const trustedRenderer = new EventEmitter();
    const capture = vi.fn();
    const recovery = new RenderProcessRecovery({
      browser,
      trustedRenderer,
      fenceBrowser: vi.fn(),
      markBrowserUnavailable: vi.fn(),
      capture,
      reloadTrustedRenderer: vi.fn(async () => {
        throw new Error("page title and profile path must stay local");
      }),
      republishTrustedState: vi.fn(),
    });

    recovery.start();
    trustedRenderer.emit("render-process-gone", {}, {});
    await recovery.settled();
    expect(capture).toHaveBeenLastCalledWith({
      component: "BROWSER_HOST",
      code: "TRUSTED_RENDERER_RECOVERY_FAILED",
      retriable: true,
    });

    recovery.stop();
    browser.emit("render-process-gone", {}, {});
    trustedRenderer.emit("render-process-gone", {}, {});
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
