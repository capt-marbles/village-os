import { describe, expect, it, vi } from "vitest";
import {
  RestartStagedSessionErasureCoordinator,
  type RestartStagedSessionErasureOperations,
  type SessionErasureBinding,
} from "../src/main/session-erasure.js";
import {
  StepUpAuthorizer,
  verifyMacOsOwnerPresence,
} from "../src/main/step-up-auth.js";

const binding: SessionErasureBinding = {
  principalId: "usr_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "bsn_01J00000000000000000000000",
  site: "LINKEDIN",
  operation: "FORGET_SESSION",
  currentState: "PRESENT",
};

function operations(): RestartStagedSessionErasureOperations & {
  calls: string[];
} {
  const calls: string[] = [];
  const record = (name: string) => async () => void calls.push(name);
  return {
    calls,
    revokeAutomation: record("revokeAutomation"),
    closeTarget: record("closeTarget"),
    clearBrowserStorage: record("clearBrowserStorage"),
    clearPermissions: record("clearPermissions"),
    revokeCredentialReferences: record("revokeCredentialReferences"),
    stageProfileRemoval: record("stageProfileRemoval"),
  };
}

describe("step-up authenticated session erasure", () => {
  it("uses a fixed macOS authorization request without receiving the OS password", async () => {
    const calls: Array<{ file: string; arguments_: readonly string[] }> = [];
    await expect(
      verifyMacOsOwnerPresence("darwin", async (file, arguments_) => {
        calls.push({ file, arguments_ });
        return 0;
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      {
        file: "/usr/bin/osascript",
        arguments_: [
          "-e",
          'do shell script "/usr/bin/true" with administrator privileges with prompt "Village needs permission to forget this local browser session."',
        ],
      },
    ]);
  });

  it("fails closed when system authorization is unavailable, denied, or interrupted", async () => {
    await expect(
      verifyMacOsOwnerPresence("linux", async () => 0),
    ).resolves.toBe(false);
    await expect(
      verifyMacOsOwnerPresence("darwin", async () => 1),
    ).resolves.toBe(false);
    await expect(
      verifyMacOsOwnerPresence("darwin", async () => {
        throw new Error("authorization canceled");
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["principalId", "usr_01J00000000000000000000001"],
    ["deviceId", "dev_01J00000000000000000000001"],
    ["browserSessionId", "bsn_01J00000000000000000000001"],
    ["site", "OWNED_FIXTURE"],
    ["operation", "NOT_FORGET_SESSION"],
    ["currentState", "ERASURE_FAILED"],
  ] as const)("rejects a wrong %s step-up binding", (key, value) => {
    const authorizer = new StepUpAuthorizer(() => 1_000);
    const token = authorizer.mint(binding, 5_000).token;
    expect(
      authorizer.consume(token, { ...binding, [key]: value } as typeof binding),
    ).toEqual({ ok: false, code: "STEP_UP_BINDING_MISMATCH" });
  });

  it("rejects missing, expired, replayed, and concurrent authorization", async () => {
    let now = 1_000;
    const authorizer = new StepUpAuthorizer(() => now);
    const cleanup = operations();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    cleanup.clearBrowserStorage = async () => {
      cleanup.calls.push("clearBrowserStorage");
      await blocked;
    };
    const coordinator = new RestartStagedSessionErasureCoordinator(
      authorizer,
      cleanup,
    );
    await expect(coordinator.erase("missing", binding)).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_UNKNOWN",
    });
    const expired = authorizer.mint(binding, 1_000).token;
    now = 2_000;
    await expect(coordinator.erase(expired, binding)).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_EXPIRED",
    });
    const token = authorizer.mint(binding, 5_000).token;
    const first = coordinator.erase(token, binding);
    await vi.waitFor(() =>
      expect(cleanup.calls).toContain("clearBrowserStorage"),
    );
    await expect(
      coordinator.erase(authorizer.mint(binding, 5_000).token, binding),
    ).resolves.toEqual({ status: "REJECTED", code: "ERASURE_ALREADY_RUNNING" });
    release();
    await expect(first).resolves.toEqual({ status: "RESTART_REQUIRED" });
    await expect(coordinator.erase(token, binding)).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_REPLAYED",
    });
  });

  it("fences, clears, revokes, and stages in order", async () => {
    const authorizer = new StepUpAuthorizer(() => 1_000);
    const cleanup = operations();
    const coordinator = new RestartStagedSessionErasureCoordinator(
      authorizer,
      cleanup,
    );
    await expect(
      coordinator.erase(authorizer.mint(binding, 5_000).token, binding),
    ).resolves.toEqual({ status: "RESTART_REQUIRED" });
    expect(cleanup.calls).toEqual([
      "revokeAutomation",
      "closeTarget",
      "clearBrowserStorage",
      "clearPermissions",
      "revokeCredentialReferences",
      "stageProfileRemoval",
    ]);
  });

  it("reports a retriable partial failure and accepts a fresh retry", async () => {
    const authorizer = new StepUpAuthorizer(() => 1_000);
    const cleanup = operations();
    cleanup.stageProfileRemoval = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const coordinator = new RestartStagedSessionErasureCoordinator(
      authorizer,
      cleanup,
    );
    await expect(
      coordinator.erase(authorizer.mint(binding, 5_000).token, binding),
    ).resolves.toEqual({
      status: "PARTIAL_FAILURE",
      failedStep: "stageProfileRemoval",
      retriable: true,
    });
    await expect(
      coordinator.erase(authorizer.mint(binding, 5_000).token, binding),
    ).resolves.toEqual({ status: "RESTART_REQUIRED" });
  });
});
