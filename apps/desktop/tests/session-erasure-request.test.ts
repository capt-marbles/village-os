import { describe, expect, it } from "vitest";
import { RestartStagedSessionErasureCoordinator } from "../src/main/session-erasure.js";
import { SessionErasureRequestController } from "../src/main/session-erasure-request.js";
import { StepUpAuthorizer } from "../src/main/step-up-auth.js";

const binding = {
  principalId: "usr_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "bsn_01J00000000000000000000000",
  site: "LINKEDIN" as const,
  operation: "FORGET_SESSION" as const,
  currentState: "PRESENT" as const,
};

function setup(
  overrides: {
    verifyOwner?: boolean;
    confirm?: boolean;
    failStage?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const record = (name: string) => async () => void calls.push(name);
  const authorizer = new StepUpAuthorizer(() => 1_000);
  const controller = new SessionErasureRequestController({
    binding: () => binding,
    verifyOwner: async () => overrides.verifyOwner ?? true,
    confirm: async () => overrides.confirm ?? true,
    authorizer,
    coordinator: new RestartStagedSessionErasureCoordinator(authorizer, {
      revokeAutomation: record("revokeAutomation"),
      closeTarget: record("closeTarget"),
      clearBrowserStorage: record("clearBrowserStorage"),
      clearPermissions: record("clearPermissions"),
      revokeCredentialReferences: record("revokeCredentialReferences"),
      stageProfileRemoval: overrides.failStage
        ? async () => {
            throw new Error("disk full");
          }
        : record("stageProfileRemoval"),
    }),
    onStepUpRequired: () => calls.push("stepUpRequired"),
    onErasureStarted: () => calls.push("started"),
    onErasureStaged: () => calls.push("staged"),
    onErasureFailed: () => calls.push("failed"),
    restart: () => calls.push("restart"),
  });
  return { calls, controller };
}

describe("session erasure request controller", () => {
  it("preserves the profile when native confirmation is declined", async () => {
    const fixture = setup({ confirm: false });
    await expect(fixture.controller.request()).resolves.toBe("DECLINED");
    expect(fixture.calls).toEqual(["stepUpRequired"]);
  });

  it("fails closed before confirmation when owner presence is absent", async () => {
    const fixture = setup({ verifyOwner: false });
    await expect(fixture.controller.request()).resolves.toBe(
      "STEP_UP_REQUIRED",
    );
    expect(fixture.calls).toEqual(["stepUpRequired"]);
  });

  it("uses the production authorization path before staging and restart", async () => {
    const fixture = setup();
    await expect(fixture.controller.request()).resolves.toBe(
      "RESTART_REQUIRED",
    );
    expect(fixture.calls).toEqual([
      "stepUpRequired",
      "started",
      "revokeAutomation",
      "closeTarget",
      "clearBrowserStorage",
      "clearPermissions",
      "revokeCredentialReferences",
      "stageProfileRemoval",
      "staged",
      "restart",
    ]);
  });

  it("does not restart when staging fails", async () => {
    const fixture = setup({ failStage: true });
    await expect(fixture.controller.request()).resolves.toBe("PARTIAL_FAILURE");
    expect(fixture.calls).not.toContain("restart");
    expect(fixture.calls).toContain("failed");
  });
});
