import { describe, expect, it, vi } from "vitest";
import type { CoordinatorSnapshot } from "../src/main/delegated-workflow-controller.js";
import { PairedProofCoordination } from "../src/main/paired-proof-coordination.js";

const initial: CoordinatorSnapshot = {
  authenticated: true,
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000009",
  objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
  jobRevision: 2,
  logicalStep: "SET_DISPLAY_NAME",
  effectId: "efx_01J00000000000000000000008",
  leaseEpoch: 3,
  cursor: 7,
  connection: "ONLINE",
  controller: "AGENT",
  automationBlocked: false,
  canceled: false,
  completedEffects: [],
  actionPhase: "ACCEPTED",
  outstandingAction: null,
};

describe("paired packaged-proof coordination", () => {
  it("does not adopt workflow state from another job", async () => {
    const paired = new PairedProofCoordination(initial, {
      synchronize: vi.fn(),
      acceptAction: vi.fn(),
      recordReceipt: vi.fn(),
      claimFreshLease: vi.fn(),
    });
    const fence = paired.createAutomationFence({
      synchronize: vi.fn(async () => ({
        ok: true as const,
        cursor: 20,
        jobId: "job_01J00000000000000000000009",
        controller: "AGENT" as const,
        connection: "ONLINE" as const,
        leaseEpoch: 4,
        automationBlocked: false,
        canceled: false,
        workflow: {
          objective: initial.objective,
          jobRevision: 9,
          logicalStep: "FINALIZE_SETUP" as const,
          effectId: "efx_01J00000000000000000000009",
          completedEffects: [],
          actionPhase: "ACCEPTED" as const,
          outstandingAction: null,
        },
      })),
    });

    await fence.synchronize(initial);

    expect(paired.snapshot()).toEqual(initial);
  });

  it("keeps a durable receipt when projection refresh is unavailable", async () => {
    const coordinator = {
      synchronize: vi.fn(async () => {
        throw new Error("WORKFLOW_BINDING_UNAVAILABLE");
      }),
      acceptAction: vi.fn(),
      recordReceipt: vi.fn(async () => ({ ok: true, cursor: 8 }) as const),
      claimFreshLease: vi.fn(),
    };
    const paired = new PairedProofCoordination(initial, coordinator);

    await paired.recordReceipt({ receipt: {}, checkpoint: {} });
    await expect(
      paired.refreshFor({
        status: "RECEIPTED",
        receipt: {},
        checkpoint: {},
      }),
    ).resolves.toMatchObject({
      cursor: 8,
      completedEffects: [
        { logicalStep: initial.logicalStep, effectId: initial.effectId },
      ],
    });
  });

  it("refreshes UI truth from the production coordinator after owner progress", async () => {
    const next: CoordinatorSnapshot = {
      ...initial,
      cursor: 10,
      logicalStep: "SELECT_ROLE",
      effectId: "efx_01J00000000000000000000009",
      leaseEpoch: 5,
      controller: "AGENT",
      completedEffects: [
        {
          logicalStep: "SET_DISPLAY_NAME",
          effectId: initial.effectId,
        },
      ],
    };
    const coordinator = {
      synchronize: vi.fn(async () => next),
      acceptAction: vi.fn(),
      recordReceipt: vi.fn(),
      recordOwnerProgress: vi.fn(
        async () => ({ ok: true, cursor: 9 }) as const,
      ),
      claimFreshLease: vi.fn(
        async () => ({ ok: true, leaseEpoch: 5, cursor: 10 }) as const,
      ),
      takeover: vi.fn(
        async () => ({ ok: true, leaseEpoch: 4, cursor: 8 }) as const,
      ),
    };
    const paired = new PairedProofCoordination(initial, coordinator);
    const automationFence = paired.createAutomationFence({
      synchronize: vi.fn(async () => ({
        ok: true as const,
        cursor: initial.cursor,
        jobId: initial.jobId,
        controller: initial.controller,
        connection: initial.connection,
        leaseEpoch: initial.leaseEpoch,
        automationBlocked: initial.automationBlocked,
        canceled: initial.canceled,
        workflow: {
          objective: initial.objective,
          jobRevision: initial.jobRevision,
          logicalStep: initial.logicalStep,
          effectId: initial.effectId,
          completedEffects: initial.completedEffects,
          actionPhase: initial.actionPhase,
          outstandingAction: initial.outstandingAction,
        },
      })),
    });
    await automationFence.synchronize(initial);
    await paired.synchronize(initial);
    expect(coordinator.synchronize).not.toHaveBeenCalled();

    await expect(
      paired.takeover({
        principalId: initial.principalId,
        deviceId: initial.deviceId,
        jobId: initial.jobId,
        browserSessionId: initial.browserSessionId,
        expectedLeaseEpoch: 3,
        cursor: 7,
      }),
    ).resolves.toMatchObject({ ok: true, leaseEpoch: 4, cursor: 8 });
    expect(
      paired.projection({
        status: "OWNER_CONTROL",
        outcome: "QUIESCED",
        coordinatorSynchronized: true,
      }),
    ).toMatchObject({ controller: "USER", inputOwner: "OWNER" });

    await paired.recordOwnerProgress({
      ...initial,
      leaseEpoch: 4,
      cursor: 8,
      actor: "OWNER",
      actionPhase: "RECEIPTED",
      occurredAt: "2026-08-14T12:00:00.000Z",
    });
    await paired.refresh();

    expect(coordinator.synchronize).toHaveBeenCalledTimes(1);
    expect(paired.snapshot()).toEqual(next);
    expect(paired.projection()).toMatchObject({
      logicalStep: "SELECT_ROLE",
      controller: "AGENT",
      lastEffectActor: "OWNER",
    });
  });
});
