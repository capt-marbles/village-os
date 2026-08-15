import { describe, expect, it, vi } from "vitest";
import { RitualBuilderController } from "../src/main/ritual-builder-controller.js";

const draftId = "rtd_01J00000000000000000000000";
const approved = {
  schemaVersion: 1 as const,
  ritualId: "rtl_01J00000000000000000000000",
  ritualRevision: 1 as const,
  status: "APPROVED" as const,
  approvedDraftId: draftId,
  approvedDraftRevision: 3,
  name: "Pipeline review",
  purpose: "Prepare my pipeline review.",
  trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
  steps: [
    {
      stepKey: "prepare-review",
      title: "Prepare the review",
      description: "Gather bounded records for the review.",
      actor: { kind: "STEWARD" as const, role: "Steward" },
      approval: "OWNER_REQUIRED" as const,
    },
  ],
  permissions: ["Read only connected records"],
  completion: "A reviewable result is ready.",
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  approvedAt: "2026-08-15T16:03:00.000Z",
};

describe("RitualBuilderController", () => {
  it("passes a strict drafting request to the Steward and persists only approved Rituals", async () => {
    const provider = {
      draft: vi.fn(async (context) => ({
        status: "proposal" as const,
        draftId: context.draftId,
        requestRevision: context.requestRevision,
        stewardMessage: "I shaped a focused draft.",
        name: "Pipeline review",
        purpose: context.ownerPurpose,
        steps: [
          {
            stepKey: "prepare-review",
            title: "Prepare the review",
            description: "Gather bounded records for the review.",
            actor: { kind: "STEWARD" as const, role: "Steward" },
            approval: "OWNER_REQUIRED" as const,
          },
        ],
        permissions: ["Read only connected records"],
        completion: "A reviewable result is ready.",
      })),
      close: vi.fn(async () => undefined),
      testRun: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const repository = {
      latestSnapshot: vi.fn(async () => ({ approved: null, receipt: null })),
      find: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(provider, repository);

    await expect(
      controller.draft({
        schemaVersion: 1,
        draftId,
        requestRevision: 1,
        ownerPurpose: "Prepare my pipeline review.",
        ignored: "must be rejected",
      }),
    ).rejects.toThrow();
    const result = await controller.draft({
      schemaVersion: 1,
      draftId,
      requestRevision: 1,
      ownerPurpose: "Prepare my pipeline review.",
    });
    expect(result.status).toBe("proposal");
    expect(provider.draft).toHaveBeenCalledOnce();
    expect(repository.save).not.toHaveBeenCalled();
    await expect(controller.approve(approved)).resolves.toEqual(approved);
    expect(repository.save).toHaveBeenCalledWith(approved);
    await expect(
      controller.approve({ ...approved, extra: true }),
    ).rejects.toThrow();
    repository.latestSnapshot.mockResolvedValue({
      approved,
      receipt: null,
    });
    await expect(controller.loadLatestState()).resolves.toEqual({
      approved,
      receipt: null,
    });
    await controller.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it("runs the exact approved Ritual against a sample and persists only a bounded Receipt", async () => {
    const provider = {
      draft: vi.fn(async () => {
        throw new Error("not used");
      }),
      testRun: vi.fn(async (context) => ({
        status: "result" as const,
        runId: context.runId,
        ritualId: context.ritual.ritualId,
        ritualRevision: context.ritual.ritualRevision,
        summary: "Customer A is the highest-priority response.",
        evidence: ["The supplied deadline is Friday."],
        uncertainties: ["Commercial impact was not supplied."],
      })),
      close: vi.fn(async () => undefined),
    };
    const repository = {
      latestSnapshot: vi.fn(async () => ({ approved, receipt: null })),
      find: vi.fn(async () => approved),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(provider, repository, {
      createId: (prefix) =>
        prefix === "rrn"
          ? "rrn_01J00000000000000000000000"
          : "rcp_01J00000000000000000000000",
      now: () => "2026-08-15T18:03:00.000Z",
    });
    const sample = "Customer A needs an answer before Friday.";

    const result = await controller.testRun({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      sample,
    });

    expect(result).toMatchObject({
      status: "receipt",
      receipt: {
        outcome: "NEEDS_REVIEW",
        sampleCharacterCount: sample.length,
        externalEffects: [],
      },
    });
    expect(provider.testRun).toHaveBeenCalledWith(
      expect.objectContaining({ ritual: approved, sample }),
    );
    expect(repository.saveReceipt).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(repository.saveReceipt.mock.calls[0]?.[0]),
    ).not.toContain(sample);

    await expect(
      controller.testRun({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: 2,
        sample,
      }),
    ).rejects.toThrow("STALE_RITUAL_TEST_RUN");
    expect(provider.testRun).toHaveBeenCalledOnce();
  });

  it("does not persist a Receipt when the provider cannot finish safely", async () => {
    const provider = {
      draft: vi.fn(async () => {
        throw new Error("not used");
      }),
      testRun: vi.fn(async (context) => ({
        status: "waiting" as const,
        runId: context.runId,
        ritualId: context.ritual.ritualId,
        ritualRevision: context.ritual.ritualRevision,
        reason: "MALFORMED_PROVIDER_OUTPUT" as const,
      })),
      close: vi.fn(async () => undefined),
    };
    const repository = {
      latestSnapshot: vi.fn(async () => ({ approved, receipt: null })),
      find: vi.fn(async () => approved),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(provider, repository, {
      createId: () => "rrn_01J00000000000000000000000",
      now: () => "2026-08-15T18:03:00.000Z",
    });

    await expect(
      controller.testRun({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: 1,
        sample: "Representative sample",
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    expect(repository.saveReceipt).not.toHaveBeenCalled();
  });

  it("persists a Receipt-bound learning proposal and approves only its current revision", async () => {
    const receipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000000",
      runId: "rrn_01J00000000000000000000000",
      ritualId: approved.ritualId,
      ritualRevision: 1,
      mode: "TEST" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "The result was useful but too long.",
      evidence: ["The correct item was ranked first."],
      uncertainties: ["The preferred output length was unknown."],
      sampleDigest: "a".repeat(64),
      sampleCharacterCount: 42,
      externalEffects: [] as const,
      recordedAt: "2026-08-15T18:03:00.000Z",
    };
    const proposal = {
      status: "proposal" as const,
      proposalId: "rlp_01J00000000000000000000000",
      ritualId: approved.ritualId,
      fromRevision: 1,
      receiptId: receipt.receiptId,
      ownerFeedback: "Keep future results to three concise bullets.",
      stewardMessage: "I propose a more concise result.",
      rationale: "The owner asked for a shorter review.",
      proposedDefinition: {
        name: approved.name,
        purpose: approved.purpose,
        trigger: approved.trigger,
        steps: approved.steps,
        permissions: approved.permissions,
        completion: "Three concise bullets are ready for review.",
        reviewPolicy: approved.reviewPolicy,
      },
    };
    const provider = {
      draft: vi.fn(async () => {
        throw new Error("not used");
      }),
      testRun: vi.fn(async () => {
        throw new Error("not used");
      }),
      learn: vi.fn(async () => proposal),
      close: vi.fn(async () => undefined),
    };
    const repository = {
      latestSnapshot: vi.fn(async () => ({ approved, receipt })),
      find: vi.fn(async () => approved),
      findReceipt: vi.fn(async () => receipt),
      findLearningProposal: vi.fn(async () => proposal),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      saveLearningProposal: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(provider, repository, {
      createId: () => "rlp_01J00000000000000000000000",
      now: () => "2026-08-15T18:04:00.000Z",
    });

    await expect(
      controller.proposeLearning({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: 1,
        receiptId: receipt.receiptId,
        feedback: "Keep future results to three concise bullets.",
      }),
    ).resolves.toEqual(proposal);
    expect(repository.saveLearningProposal).toHaveBeenCalledWith(proposal);

    await expect(
      controller.approveLearning({
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        ritualId: approved.ritualId,
        expectedFromRevision: 1,
        approvedAt: "2026-08-15T18:04:00.000Z",
      }),
    ).resolves.toMatchObject({ ritualRevision: 2 });
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        ritualId: approved.ritualId,
        ritualRevision: 2,
        learningProposalId: proposal.proposalId,
      }),
    );

    repository.find.mockResolvedValue({
      ...approved,
      ritualRevision: 2,
      learningProposalId: proposal.proposalId,
      basedOnReceiptId: receipt.receiptId,
    });
    await expect(
      controller.approveLearning({
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        ritualId: approved.ritualId,
        expectedFromRevision: 1,
        approvedAt: "2026-08-15T18:04:00.000Z",
      }),
    ).rejects.toThrow("STALE_RITUAL_LEARNING_PROPOSAL");
  });
});
