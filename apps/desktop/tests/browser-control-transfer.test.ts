import { describe, expect, it } from "vitest";
import { LocalActionExecutor } from "../src/browser/local-action-executor.js";
import { BrowserControlTransfer } from "../src/main/browser-control-transfer.js";
import { BrowserViewportCoordinator } from "../src/main/browser-viewport-coordinator.js";
import { DesktopBrowserUiState } from "../src/main/desktop-browser-ui-state.js";

describe("browser control transfer", () => {
  it("keeps automation fenced and gives the user recovery control when reload fails", async () => {
    const input: boolean[] = [];
    const viewport = new BrowserViewportCoordinator({
      setBounds: () => undefined,
      setVisible: () => undefined,
      setInputEnabled: (enabled) => input.push(enabled),
      focus: () => undefined,
      destroy: () => undefined,
    });
    const state = new DesktopBrowserUiState();
    const executor = new LocalActionExecutor({ leaseEpoch: 1 });
    let finish!: () => void;
    const inFlight = executor.execute({
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      mutationClass: "NON_IDEMPOTENT",
      run: () =>
        new Promise((resolve) => {
          finish = () => resolve("UNKNOWN");
        }),
    });
    const transfer = new BrowserControlTransfer(
      state,
      viewport,
      executor,
      async () => {
        throw new Error("reload failed");
      },
      async () => undefined,
    );

    await expect(transfer.takeover(0)).resolves.toBe("RECOVERY_REQUIRED");
    expect(executor.isAutomationBlocked()).toBe(true);
    expect(state.current()).toMatchObject({
      controller: "USER",
      humanGate: "UNKNOWN_CHALLENGE",
    });
    expect(input.at(-1)).toBe(true);

    await expect(transfer.returnControl()).rejects.toThrow(
      "ACTION_RECONCILIATION_REQUIRED",
    );
    expect(executor.isAutomationBlocked()).toBe(true);
    expect(state.current()).toMatchObject({ controller: "USER" });
    expect(input.at(-1)).toBe(true);

    finish();
    await inFlight;
  });

  it("keeps an unknown action gated even when recovery reload succeeds", async () => {
    const viewport = new BrowserViewportCoordinator({
      setBounds: () => undefined,
      setVisible: () => undefined,
      setInputEnabled: () => undefined,
      focus: () => undefined,
      destroy: () => undefined,
    });
    const state = new DesktopBrowserUiState();
    const executor = new LocalActionExecutor({ leaseEpoch: 1 });
    let finish!: () => void;
    const inFlight = executor.execute({
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      mutationClass: "NON_IDEMPOTENT",
      run: () =>
        new Promise((resolve) => {
          finish = () => resolve("UNKNOWN");
        }),
    });
    const transfer = new BrowserControlTransfer(
      state,
      viewport,
      executor,
      async () => undefined,
      async () => undefined,
    );

    await expect(transfer.takeover(0)).resolves.toBe("OUTCOME_UNKNOWN");
    expect(state.current()).toMatchObject({
      controller: "USER",
      humanGate: "UNKNOWN_CHALLENGE",
    });
    finish();
    await inFlight;
  });

  it("reconciles the visible browser before returning control", async () => {
    const input: boolean[] = [];
    const viewport = new BrowserViewportCoordinator({
      setBounds: () => undefined,
      setVisible: () => undefined,
      setInputEnabled: (enabled) => input.push(enabled),
      focus: () => undefined,
      destroy: () => undefined,
    });
    const state = new DesktopBrowserUiState({
      jobState: "RUNNING_USER",
      controller: "USER",
    });
    const executor = new LocalActionExecutor({ leaseEpoch: 1 });
    executor.markOfflineTakeover();
    const transfer = new BrowserControlTransfer(
      state,
      viewport,
      executor,
      async () => undefined,
      async () => {
        throw new Error("browser reconciliation failed");
      },
    );

    await expect(transfer.returnControl()).rejects.toThrow(
      "browser reconciliation failed",
    );
    expect(state.current()).toMatchObject({
      controller: "USER",
      humanGate: "UNKNOWN_CHALLENGE",
    });
    expect(executor.isAutomationBlocked()).toBe(true);
    expect(input.at(-1)).toBe(true);
  });
});
