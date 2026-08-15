import { describe, expect, it } from "vitest";
import {
  advanceActionPhase,
  browserControlStateSchema,
  resolveActionReconciliation,
  verificationResultSchema,
  setupCompletionEvidenceSchema,
  validateSetupCompletion,
  jobCompletionEvidenceSchema,
  jobEventSchema,
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

  it("accepts matching finalization evidence once and rejects stale identity", () => {
    const evidence = {
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        version: 1,
      },
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      jobRevision: 12,
      logicalStep: "FINALIZE_SETUP",
      effectId: "efx_01J00000000000000000000000",
      receiptId: "rcp_01J00000000000000000000000",
      leaseEpoch: 5,
      predicateVersion: "setup-complete-v1",
    } as const;
    expect(setupCompletionEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );
    expect(
      validateSetupCompletion(evidence, {
        jobId: evidence.jobId,
        browserSessionId: evidence.browserSessionId,
        jobRevision: evidence.jobRevision,
        logicalStep: evidence.logicalStep,
        effectId: evidence.effectId,
        leaseEpoch: evidence.leaseEpoch,
        receiptedEffectIds: [evidence.effectId],
        completionReceiptIds: [],
      }),
    ).toEqual({ ok: true });
    expect(
      validateSetupCompletion(evidence, {
        jobId: evidence.jobId,
        browserSessionId: evidence.browserSessionId,
        jobRevision: evidence.jobRevision + 1,
        logicalStep: evidence.logicalStep,
        effectId: evidence.effectId,
        leaseEpoch: evidence.leaseEpoch,
        receiptedEffectIds: [evidence.effectId],
        completionReceiptIds: [],
      }),
    ).toEqual({ ok: false, code: "STALE_WORKFLOW_BINDING" });
    expect(
      validateSetupCompletion(evidence, {
        jobId: evidence.jobId,
        browserSessionId: evidence.browserSessionId,
        jobRevision: evidence.jobRevision,
        logicalStep: evidence.logicalStep,
        effectId: evidence.effectId,
        leaseEpoch: evidence.leaseEpoch,
        receiptedEffectIds: [evidence.effectId],
        completionReceiptIds: [evidence.receiptId],
      }),
    ).toEqual({ ok: false, code: "DUPLICATE_COMPLETION" });
    expect(
      validateSetupCompletion(evidence, {
        jobId: evidence.jobId,
        browserSessionId: evidence.browserSessionId,
        jobRevision: evidence.jobRevision,
        logicalStep: evidence.logicalStep,
        effectId: evidence.effectId,
        leaseEpoch: evidence.leaseEpoch,
        receiptedEffectIds: [],
        completionReceiptIds: [],
      }),
    ).toEqual({ ok: false, code: "EFFECT_NOT_RECEIPTED" });
  });

  it("preserves authentication evidence beside strict setup completion", () => {
    expect(
      jobCompletionEvidenceSchema.safeParse({
        evidence: "PREDICATE_AUTHENTICATED",
        predicateVersion: "linkedin-auth-v1",
      }).success,
    ).toBe(true);
    expect(
      jobCompletionEvidenceSchema.safeParse({
        evidence: "OWNER_CONFIRMED",
        confirmationVersion: "owner-confirmation-v1",
      }).success,
    ).toBe(true);
    expect(
      jobCompletionEvidenceSchema.safeParse({
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
          version: 1,
        },
        evidence: "MODEL_SAID_COMPLETE",
      }).success,
    ).toBe(false);
    expect(
      jobEventSchema.safeParse({
        eventId: "evt_01J00000000000000000000000",
        principalId: "prn_01J00000000000000000000000",
        jobId: "job_01J00000000000000000000001",
        sequence: 1,
        occurredAt: "2026-08-12T18:00:00.000Z",
        type: "JOB_SUCCEEDED",
        payload: {
          objective: {
            kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
            version: 1,
          },
          jobId: "job_01J00000000000000000000000",
          browserSessionId: "brs_01J00000000000000000000000",
          jobRevision: 12,
          logicalStep: "FINALIZE_SETUP",
          effectId: "efx_01J00000000000000000000000",
          receiptId: "rcp_01J00000000000000000000000",
          leaseEpoch: 5,
          predicateVersion: "setup-complete-v1",
        },
      }).success,
    ).toBe(false);
  });
});
