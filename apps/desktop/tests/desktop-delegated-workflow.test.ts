import { describe, expect, it, vi } from "vitest";
import { DesktopDelegatedWorkflow } from "../src/main/desktop-delegated-workflow.js";

const snapshot = (state = "WORKING", time = "2026-08-13T12:00:00.000Z") => ({
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
  state: state as "WORKING",
  logicalStep: "SET_DISPLAY_NAME" as const,
  controller: "AGENT" as const,
  connection: "ONLINE" as const,
  actionPhase: "ACCEPTED" as const,
  lastEffectActor: null,
  humanGate: null,
  inputOwner: "NONE" as const,
  lastDurableUpdateAt: time,
});

describe("desktop delegated workflow", () => {
  it("orchestrates the durable controller and ignores stale projections", async () => {
    const controller = {
      runOnce: vi.fn(async () => ({
        status: "RECEIPTED",
        actionId: "a",
        effectId: "e",
      })),
      takeover: vi.fn(),
      handBack: vi.fn(),
      reconcile: vi.fn(),
      cancelFutureAutomation: vi.fn(),
      takeoverOffline: vi.fn(),
    };
    const readCanonicalSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot("WORKING", "2026-08-13T12:01:00.000Z"))
      .mockResolvedValueOnce(snapshot("WORKING", "2026-08-13T11:59:00.000Z"));
    const workflow = new DesktopDelegatedWorkflow(
      snapshot(),
      controller as never,
      {
        createFixtureHost: vi.fn(),
        readCanonicalSnapshot,
        providerConnected: () => true,
      },
    );
    await expect(workflow.start()).resolves.toMatchObject({
      lastDurableUpdateAt: "2026-08-13T12:01:00.000Z",
    });
    await expect(workflow.start()).resolves.toMatchObject({
      lastDurableUpdateAt: "2026-08-13T12:01:00.000Z",
    });
    expect(controller.runOnce).toHaveBeenCalledTimes(2);
  });

  it("fences without a provider turn when ChatGPT is disconnected", async () => {
    const controller = { runOnce: vi.fn() };
    const workflow = new DesktopDelegatedWorkflow(
      snapshot(),
      controller as never,
      {
        createFixtureHost: vi.fn(),
        readCanonicalSnapshot: vi.fn(),
        providerConnected: () => false,
      },
    );
    await expect(workflow.start()).resolves.toMatchObject({
      state: "DISCONNECTED",
    });
    expect(controller.runOnce).not.toHaveBeenCalled();
  });
});
