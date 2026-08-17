import { describe, expect, it, vi } from "vitest";
import {
  createProductionActivationCoordinator,
  type BrowserWorkspaceLifecycle,
} from "../src/main/production-activation.js";

const pairingLink =
  "village-pair://complete?principalId=prn_01J00000000000000000000000&pairingId=par_01J00000000000000000000000";

function workspace() {
  let closed: (() => void) | undefined;
  const value: BrowserWorkspaceLifecycle = {
    window: {
      once: (event, listener) => {
        expect(event).toBe("closed");
        closed = listener;
      },
    },
  };
  return {
    value,
    close: () => closed?.(),
  };
}

function activation(
  options: {
    runSteward?: () => Promise<unknown>;
    runBrowserWorkspace?: () => Promise<BrowserWorkspaceLifecycle>;
    acceptPairingLink?: (value: string) => boolean;
    reportActivationFailure?: (error: unknown) => void;
  } = {},
) {
  return createProductionActivationCoordinator({
    runSteward: options.runSteward ?? vi.fn(async () => undefined),
    runBrowserWorkspace:
      options.runBrowserWorkspace ?? vi.fn(async () => workspace().value),
    acceptPairingLink:
      options.acceptPairingLink ?? ((value) => value === pairingLink),
    reportActivationFailure:
      options.reportActivationFailure ?? vi.fn<(error: unknown) => void>(),
  });
}

describe("production activation", () => {
  it("starts the Steward by default without opening the browser workspace", async () => {
    const runSteward = vi.fn(async () => undefined);
    const runBrowserWorkspace = vi.fn(async () => workspace().value);
    const coordinator = activation({ runSteward, runBrowserWorkspace });

    await coordinator.initialLaunch(["Village"]);

    expect(runSteward).toHaveBeenCalledOnce();
    expect(runBrowserWorkspace).not.toHaveBeenCalled();
  });

  it("singleflights repeated existing-instance pairing activations", async () => {
    let resolveWorkspace:
      ((value: BrowserWorkspaceLifecycle) => void) | undefined;
    const runBrowserWorkspace = vi.fn(
      () =>
        new Promise<BrowserWorkspaceLifecycle>((resolve) => {
          resolveWorkspace = resolve;
        }),
    );
    const coordinator = activation({ runBrowserWorkspace });

    coordinator.activateExistingInstance(["Village", pairingLink]);
    coordinator.activateExistingInstance(["Village", pairingLink]);

    expect(runBrowserWorkspace).toHaveBeenCalledOnce();
    resolveWorkspace?.(workspace().value);
    await Promise.resolve();
  });

  it("opens a new browser workspace after the earlier one closes", async () => {
    const firstWorkspace = workspace();
    const secondWorkspace = workspace();
    const runBrowserWorkspace = vi
      .fn<() => Promise<BrowserWorkspaceLifecycle>>()
      .mockResolvedValueOnce(firstWorkspace.value)
      .mockResolvedValueOnce(secondWorkspace.value);
    const coordinator = activation({ runBrowserWorkspace });

    coordinator.activateExistingInstance(["Village", pairingLink]);
    await Promise.resolve();
    firstWorkspace.close();
    coordinator.activateExistingInstance(["Village", pairingLink]);

    expect(runBrowserWorkspace).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected browser workspace launch on the next activation", async () => {
    const failure = new Error("control plane unavailable");
    const reportActivationFailure = vi.fn<(error: unknown) => void>();
    const runBrowserWorkspace = vi
      .fn<() => Promise<BrowserWorkspaceLifecycle>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(workspace().value);
    const coordinator = activation({
      runBrowserWorkspace,
      reportActivationFailure,
    });

    coordinator.activateExistingInstance(["Village", pairingLink]);
    await vi.waitFor(() =>
      expect(reportActivationFailure).toHaveBeenCalledWith(failure),
    );
    coordinator.activateExistingInstance(["Village", pairingLink]);

    expect(runBrowserWorkspace).toHaveBeenCalledTimes(2);
  });

  it("prevents open-url only when it activates the browser workspace", () => {
    const runBrowserWorkspace = vi.fn(async () => workspace().value);
    const coordinator = activation({ runBrowserWorkspace });
    const validEvent = { preventDefault: vi.fn() };
    const invalidEvent = { preventDefault: vi.fn() };

    coordinator.activateOpenUrl(validEvent, pairingLink);
    coordinator.activateOpenUrl(invalidEvent, "village-pair://complete?bad=1");

    expect(validEvent.preventDefault).toHaveBeenCalledOnce();
    expect(invalidEvent.preventDefault).not.toHaveBeenCalled();
    expect(runBrowserWorkspace).toHaveBeenCalledOnce();
  });
});
