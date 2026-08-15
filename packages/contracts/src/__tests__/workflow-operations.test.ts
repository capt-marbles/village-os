import { describe, expect, it } from "vitest";
import {
  canonicalWorkflowOperationRequestBytes,
  unsignedWorkflowOperationRequestSchema,
  workflowOperationRequestSchema,
  workflowOperationResponseSchema,
} from "../index.js";

const binding = {
  protocolVersion: 1 as const,
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
  connectionId: "connector-desktop",
  sequence: 8,
  issuedAt: "2026-08-14T12:00:00.000Z",
  expiresAt: "2026-08-14T12:00:30.000Z",
};

describe("workflow operation contracts", () => {
  it("signs the complete receipt and sanitized checkpoint binding", () => {
    const request = {
      ...binding,
      operation: "RECORD_RECEIPT" as const,
      receipt: {
        receiptId: "rcp_01J00000000000000000000000",
        principalId: binding.principalId,
        deviceId: binding.deviceId,
        jobId: binding.jobId,
        browserSessionId: binding.browserSessionId,
        actionId: "act_01J00000000000000000000000",
        stepId: "bsp_01J00000000000000000000000",
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
          version: 1 as const,
        },
        jobRevision: 2,
        logicalStep: "SET_DISPLAY_NAME" as const,
        effectId: "efx_01J00000000000000000000000",
        leaseEpoch: 2,
        outcome: "POSTCONDITION_SATISFIED" as const,
        predicateIds: ["setup-display-name-matches-v1"],
        recordedAt: "2026-08-14T12:00:01.000Z",
      },
      checkpoint: {
        checkpointId: "chk_01J00000000000000000000000",
        principalId: binding.principalId,
        deviceId: binding.deviceId,
        jobId: binding.jobId,
        browserSessionId: binding.browserSessionId,
        jobRevision: 2,
        eventSequence: 5,
        state: "RUNNING_AGENT" as const,
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
          version: 1 as const,
        },
        site: "OWNED_FIXTURE" as const,
        currentStep: "SET_DISPLAY_NAME" as const,
        currentEffectId: "efx_01J00000000000000000000000",
        completedEffects: [
          {
            logicalStep: "SET_DISPLAY_NAME" as const,
            effectId: "efx_01J00000000000000000000000",
          },
        ],
        outstandingAction: null,
        lastPredicateVersion: "setup-display-name-matches-v1",
        actionPhase: "RECEIPTED" as const,
        reconciliation: "NONE" as const,
        createdAt: "2026-08-14T12:00:01.000Z",
      },
      signature: "signature_value",
    };

    expect(workflowOperationRequestSchema.parse(request)).toEqual(request);
    const { signature: _, ...unsigned } = request;
    const canonical = new TextDecoder().decode(
      canonicalWorkflowOperationRequestBytes(unsigned),
    );
    expect(canonical).toContain(request.receipt.receiptId);
    expect(canonical).toContain(request.checkpoint.checkpointId);
    expect(canonical).not.toContain("rawPageText");
    expect(
      workflowOperationRequestSchema.safeParse({
        ...request,
        rawPageText: "hostile",
      }).success,
    ).toBe(false);
    expect(
      workflowOperationRequestSchema.safeParse({
        ...request,
        expiresAt: "2026-08-14T12:01:01.000Z",
      }).success,
    ).toBe(false);
  });

  it("strictly separates receipt and fresh-lease responses", () => {
    expect(
      workflowOperationResponseSchema.parse({
        ok: true,
        operation: "RECORD_RECEIPT",
        cursor: 5,
      }),
    ).toEqual({ ok: true, operation: "RECORD_RECEIPT", cursor: 5 });
    expect(
      workflowOperationResponseSchema.parse({
        ok: true,
        operation: "CLAIM_FRESH_LEASE",
        cursor: 8,
        leaseEpoch: 4,
      }),
    ).toEqual({
      ok: true,
      operation: "CLAIM_FRESH_LEASE",
      cursor: 8,
      leaseEpoch: 4,
    });
  });

  it("binds takeover and owner progress to the current cursor and lease", () => {
    const takeover = {
      ...binding,
      operation: "TAKEOVER" as const,
      expectedLeaseEpoch: 2,
      cursor: 7,
      signature: "signature_value",
    };
    const ownerProgress = {
      ...binding,
      sequence: 9,
      operation: "RECORD_OWNER_PROGRESS" as const,
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
        version: 1 as const,
      },
      jobRevision: 2,
      logicalStep: "SELECT_ROLE" as const,
      effectId: "efx_01J00000000000000000000001",
      actionPhase: "RECEIPTED" as const,
      leaseEpoch: 3,
      cursor: 8,
      actor: "OWNER" as const,
      occurredAt: "2026-08-14T12:00:02.000Z",
      signature: "signature_value",
    };

    expect(workflowOperationRequestSchema.parse(takeover)).toEqual(takeover);
    expect(workflowOperationRequestSchema.parse(ownerProgress)).toEqual(
      ownerProgress,
    );
    const { signature: _signature, ...unsignedOwnerProgress } = ownerProgress;
    expect(
      new TextDecoder().decode(
        canonicalWorkflowOperationRequestBytes(
          unsignedWorkflowOperationRequestSchema.parse(unsignedOwnerProgress),
        ),
      ),
    ).toContain(ownerProgress.effectId);
    expect(
      workflowOperationResponseSchema.parse({
        ok: true,
        operation: "TAKEOVER",
        cursor: 8,
        leaseEpoch: 3,
      }),
    ).toMatchObject({ operation: "TAKEOVER", leaseEpoch: 3 });
    expect(
      workflowOperationResponseSchema.parse({
        ok: true,
        operation: "RECORD_OWNER_PROGRESS",
        cursor: 9,
      }),
    ).toEqual({
      ok: true,
      operation: "RECORD_OWNER_PROGRESS",
      cursor: 9,
    });
  });
});
