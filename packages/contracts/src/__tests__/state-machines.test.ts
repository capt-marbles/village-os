import { describe, expect, it } from "vitest";
import {
  advanceActionPhase,
  browserControlStateSchema,
  resolveActionReconciliation,
  verificationResultSchema,
} from "../index.js";

describe("durable action phases", () => {
  it("requires ordered evidence and reconciles a lost acknowledgement", () => {
    expect(advanceActionPhase("ACCEPTED", "EFFECT_OBSERVED")).toEqual({
      ok: false,
      code: "ILLEGAL_ACTION_PHASE",
    });
    expect(advanceActionPhase("ACCEPTED", "ACKNOWLEDGEMENT_LOST")).toEqual({
      ok: true,
      phase: "RECONCILIATION_REQUIRED",
    });
    expect(advanceActionPhase("ACCEPTED", "DISPATCHED")).toEqual({
      ok: true,
      phase: "DISPATCHED",
    });
    expect(advanceActionPhase("DISPATCHED", "EFFECT_OBSERVED")).toEqual({
      ok: true,
      phase: "EFFECT_OBSERVED",
    });
    expect(advanceActionPhase("EFFECT_OBSERVED", "RECEIPT_RECORDED")).toEqual({
      ok: true,
      phase: "RECEIPTED",
    });
  });

  it("never confuses owner confirmation with predicate-confirmed authentication", () => {
    const automatic = verificationResultSchema.parse({
      status: "authenticated",
      predicateVersion: "fixture-v1",
    });
    const ownerConfirmed = verificationResultSchema.parse({
      status: "confirmed_by_user",
      predicateVersion: "fixture-v1",
    });
    expect(automatic.status).toBe("authenticated");
    expect(ownerConfirmed.status).toBe("confirmed_by_user");
    expect(ownerConfirmed).not.toEqual(automatic);
  });

  it("never retries an unknown non-idempotent effect", () => {
    expect(resolveActionReconciliation("NON_IDEMPOTENT", "UNKNOWN")).toBe(
      "WAITING_FOR_USER",
    );
    expect(resolveActionReconciliation("IDEMPOTENT", "NOT_SATISFIED")).toBe(
      "RETRY_ALLOWED",
    );
    expect(resolveActionReconciliation("NON_IDEMPOTENT", "SATISFIED")).toBe(
      "RECEIPTED",
    );
  });

  it("rejects semantically impossible controller and connection combinations", () => {
    const base = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      controller: "AGENT",
      connection: "ONLINE",
      leaseEpoch: 1,
      leaseExpiresAt: "2026-08-12T18:01:00.000Z",
      lastAcceptedSequence: 0,
      automationBlocked: false,
      takeover: "NONE",
      profile: "PRESENT",
    };
    expect(browserControlStateSchema.safeParse(base).success).toBe(true);
    expect(
      browserControlStateSchema.safeParse({ ...base, connection: "OFFLINE" })
        .success,
    ).toBe(false);
    expect(
      browserControlStateSchema.safeParse({
        ...base,
        controller: "USER",
        leaseExpiresAt: null,
        automationBlocked: false,
      }).success,
    ).toBe(false);
    expect(
      browserControlStateSchema.safeParse({
        ...base,
        controller: "USER",
        connection: "OFFLINE",
        leaseExpiresAt: null,
        automationBlocked: true,
        takeover: "OFFLINE_MARKED",
      }).success,
    ).toBe(true);
  });
});
