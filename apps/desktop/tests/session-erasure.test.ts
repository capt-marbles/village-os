import { describe, expect, it, vi } from "vitest";
import {
  SessionErasureCoordinator,
  type SessionErasureBinding,
  type SessionErasureOperations,
} from "../src/main/session-erasure.js";
import { StepUpAuthorizer } from "../src/main/step-up-auth.js";

const binding: SessionErasureBinding = {
  principalId: "usr_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "bsn_01J00000000000000000000000",
  site: "LINKEDIN",
  operation: "FORGET_SESSION",
  currentState: "PRESENT",
};

function operations(): SessionErasureOperations & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => async () => void calls.push(name);
  return {
    calls,
    revokeAutomation: record("revokeAutomation"),
    closeTarget: record("closeTarget"),
    clearBrowserStorage: record("clearBrowserStorage"),
    clearPermissions: record("clearPermissions"),
    clearActionJournal: record("clearActionJournal"),
    clearTemporaryData: record("clearTemporaryData"),
    clearDownloads: record("clearDownloads"),
    revokeCredentialReferences: record("revokeCredentialReferences"),
    removeProfile: record("removeProfile"),
    verifyAbsent: async () => {
      calls.push("verifyAbsent");
      return true;
    },
  };
}

describe("step-up authenticated session erasure", () => {
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

  it("requires a short-lived, single-use exact binding before any destructive call", async () => {
    let now = 1_000;
    const authorizer = new StepUpAuthorizer(() => now);
    const cleanup = operations();
    const erasure = new SessionErasureCoordinator(authorizer, cleanup);

    await expect(erasure.erase("missing", binding)).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_UNKNOWN",
    });
    expect(cleanup.calls).toEqual([]);

    const token = authorizer.mint(binding, 5_000).token;
    await expect(
      erasure.erase(token, { ...binding, site: "OWNED_FIXTURE" }),
    ).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_BINDING_MISMATCH",
    });
    expect(cleanup.calls).toEqual([]);

    const valid = authorizer.mint(binding, 5_000).token;
    await expect(erasure.erase(valid, binding)).resolves.toEqual({
      status: "COMPLETE",
    });
    expect(cleanup.calls).toEqual([
      "revokeAutomation",
      "closeTarget",
      "clearBrowserStorage",
      "clearPermissions",
      "clearActionJournal",
      "clearTemporaryData",
      "clearDownloads",
      "revokeCredentialReferences",
      "removeProfile",
      "verifyAbsent",
    ]);
    await expect(erasure.erase(valid, binding)).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_REPLAYED",
    });

    const expired = authorizer.mint(binding, 1_000).token;
    now = 2_000;
    await expect(erasure.erase(expired, binding)).resolves.toEqual({
      status: "REJECTED",
      code: "STEP_UP_EXPIRED",
    });
  });

  it("fences automation first and reports retriable partial failure without touching another profile", async () => {
    const authorizer = new StepUpAuthorizer(() => 1_000);
    const cleanup = operations();
    cleanup.clearTemporaryData = vi.fn(async () => {
      cleanup.calls.push("clearTemporaryData");
      throw new Error("disk busy");
    });
    const erasure = new SessionErasureCoordinator(authorizer, cleanup);

    const result = await erasure.erase(
      authorizer.mint(binding, 5_000).token,
      binding,
    );
    expect(result).toEqual({
      status: "PARTIAL_FAILURE",
      failedStep: "clearTemporaryData",
      retriable: true,
    });
    expect(cleanup.calls).toEqual([
      "revokeAutomation",
      "closeTarget",
      "clearBrowserStorage",
      "clearPermissions",
      "clearActionJournal",
      "clearTemporaryData",
    ]);
  });

  it("serializes duplicate erasure attempts and fails if absence cannot be verified after cleanup", async () => {
    const authorizer = new StepUpAuthorizer(() => 1_000);
    const cleanup = operations();
    cleanup.verifyAbsent = async () => false;
    const erasure = new SessionErasureCoordinator(authorizer, cleanup);
    const first = authorizer.mint(binding, 5_000).token;
    const second = authorizer.mint(binding, 5_000).token;

    await expect(erasure.erase(first, binding)).resolves.toEqual({
      status: "PARTIAL_FAILURE",
      failedStep: "verifyAbsent",
      retriable: true,
    });
    cleanup.verifyAbsent = async () => true;
    await expect(erasure.erase(second, binding)).resolves.toEqual({
      status: "COMPLETE",
    });
  });
});
