import {
  createRitualRun,
  reduceRitualRun,
  type RitualRun,
} from "@village/contracts";
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

const automaticApproved = {
  ...approved,
  steps: [{ ...approved.steps[0]!, approval: "NONE" as const }],
};

function unusedRunPersistence() {
  return {
    findRunWithApprovedRevision: vi.fn(async () => null),
    findNonterminalRun: vi.fn(async () => null),
    saveRun: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
  };
}

function unavailableProvider() {
  return {
    draft: vi.fn(async () => {
      throw new Error("not used");
    }),
    testRun: vi.fn(async () => {
      throw new Error("not used");
    }),
    learn: vi.fn(async () => {
      throw new Error("not used");
    }),
    close: vi.fn(async () => undefined),
  };
}

function createQueuedRun(
  ritual = approved,
  runId = "rrn_01J00000000000000000000001",
): RitualRun {
  return createRitualRun({
    approved: ritual,
    request: {
      schemaVersion: 1,
      ritualId: ritual.ritualId,
      ritualRevision: ritual.ritualRevision,
    },
    runId,
    createdAt: "2026-08-16T12:00:00.000Z",
  });
}

function createRunningRun(
  ritual = approved,
  runId = "rrn_01J00000000000000000000001",
): RitualRun {
  return reduceRitualRun(createQueuedRun(ritual, runId), ritual, {
    type: "START",
    occurredAt: "2026-08-16T12:00:01.000Z",
  });
}

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
      latestSnapshot: vi.fn(async () => ({
        approved: null,
        receipt: null,
        run: null,
        runReceipt: null,
      })),
      find: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
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
      run: null,
      runReceipt: null,
    });
    await expect(controller.loadLatestState()).resolves.toEqual({
      approved,
      receipt: null,
      run: null,
      runReceipt: null,
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
      latestSnapshot: vi.fn(async () => ({
        approved,
        receipt: null,
        run: null,
        runReceipt: null,
      })),
      find: vi.fn(async () => approved),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
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
      latestSnapshot: vi.fn(async () => ({
        approved,
        receipt: null,
        run: null,
        runReceipt: null,
      })),
      find: vi.fn(async () => approved),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
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

  it("persists, gates, resumes, and receipts a manual fixture Run", async () => {
    const provider = {
      draft: vi.fn(async () => {
        throw new Error("not used");
      }),
      testRun: vi.fn(async () => {
        throw new Error("not used");
      }),
      close: vi.fn(async () => undefined),
    };
    let currentRun: RitualRun | null = null;
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved,
        receipt: null,
        run: currentRun,
        runReceipt: null,
      })),
      find: vi.fn(async () => approved),
      findReceipt: vi.fn(async () => null),
      findLearningProposal: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      saveLearningProposal: vi.fn(async () => undefined),
      findRunWithApprovedRevision: vi.fn(async () =>
        currentRun ? { run: currentRun, approved } : null,
      ),
      findNonterminalRun: vi.fn(async () => null),
      saveRun: vi.fn(async (run) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async (run) => {
        currentRun = run;
      }),
    };
    let tick = 0;
    const controller = new RitualBuilderController(provider, repository, {
      createId: (prefix) =>
        prefix === "rrn"
          ? "rrn_01J00000000000000000000001"
          : "rcp_01J00000000000000000000001",
      now: () => `2026-08-16T12:00:0${tick++}.000Z`,
    });

    const waiting = await controller.startRun({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
    });
    expect(waiting).toMatchObject({
      status: "run",
      run: {
        status: "WAITING_FOR_OWNER",
        currentStepKey: "prepare-review",
      },
    });
    expect(repository.saveRun).toHaveBeenCalledTimes(2);

    const completed = await controller.approveRunStep({
      schemaVersion: 1,
      runId: "rrn_01J00000000000000000000001",
      stepKey: "prepare-review",
    });
    expect(completed).toMatchObject({
      status: "receipt",
      run: { status: "NEEDS_REVIEW", currentStepKey: null },
      receipt: {
        mode: "RUN",
        executionProvider: "DETERMINISTIC_FIXTURE",
        externalEffects: [],
      },
    });
    expect(repository.completeRun).toHaveBeenCalledOnce();
    expect(provider.testRun).not.toHaveBeenCalled();
  });

  it("records EXECUTOR_FAILED when the fixture executor throws", async () => {
    let currentRun: RitualRun | null = null;
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved: automaticApproved,
        receipt: null,
        run: currentRun,
        runReceipt: null,
      })),
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => null),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: () => "rrn_01J00000000000000000000002",
        now: () => "2026-08-16T12:01:00.000Z",
        runExecutor: {
          completeCurrentStep: async () => {
            throw new Error("fixture failed");
          },
        },
      },
    );

    await expect(
      controller.startRun({
        schemaVersion: 1,
        ritualId: automaticApproved.ritualId,
        ritualRevision: automaticApproved.ritualRevision,
      }),
    ).resolves.toMatchObject({
      status: "run",
      run: { status: "FAILED", failureCode: "EXECUTOR_FAILED" },
    });
    expect(currentRun).toMatchObject({
      status: "FAILED",
      failureCode: "EXECUTOR_FAILED",
    });
  });

  it("records POLICY_DENIED when a fixture reports external effects", async () => {
    let currentRun: RitualRun | null = null;
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved: automaticApproved,
        receipt: null,
        run: currentRun,
        runReceipt: null,
      })),
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => null),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: () => "rrn_01J00000000000000000000003",
        now: () => "2026-08-16T12:02:00.000Z",
        runExecutor: {
          completeCurrentStep: async () => ({
            stepKey: "prepare-review",
            externalEffects: ["unexpected effect"] as unknown as readonly [],
          }),
        },
      },
    );

    await expect(
      controller.startRun({
        schemaVersion: 1,
        ritualId: automaticApproved.ritualId,
        ritualRevision: automaticApproved.ritualRevision,
      }),
    ).resolves.toMatchObject({
      status: "run",
      run: { status: "FAILED", failureCode: "POLICY_DENIED" },
    });
    expect(currentRun).toMatchObject({
      status: "FAILED",
      failureCode: "POLICY_DENIED",
    });
  });

  it("fails from the immediately durable checkpoint when checkpoint persistence rejects", async () => {
    const twoStepRitual = {
      ...automaticApproved,
      steps: [
        automaticApproved.steps[0]!,
        {
          stepKey: "summarize-review",
          title: "Summarize the review",
          description: "Prepare the bounded review summary.",
          actor: { kind: "STEWARD" as const, role: "Steward" },
          approval: "NONE" as const,
        },
      ],
    };
    let currentRun: RitualRun | null = null;
    let writes = 0;
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved: twoStepRitual,
        receipt: null,
        run: currentRun,
        runReceipt: null,
      })),
      find: vi.fn(async () => twoStepRitual),
      findNonterminalRun: vi.fn(async () => null),
      saveRun: vi.fn(async (run: RitualRun) => {
        writes += 1;
        if (writes === 3) throw new Error("CHECKPOINT_WRITE_FAILED");
        currentRun = run;
      }),
      completeRun: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: () => "rrn_01J00000000000000000000004",
        now: () => "2026-08-16T12:03:00.000Z",
      },
    );

    await expect(
      controller.startRun({
        schemaVersion: 1,
        ritualId: twoStepRitual.ritualId,
        ritualRevision: twoStepRitual.ritualRevision,
      }),
    ).resolves.toMatchObject({
      status: "run",
      run: {
        status: "FAILED",
        failureCode: "EXECUTOR_FAILED",
        steps: [
          { stepKey: "prepare-review", status: "FAILED" },
          { stepKey: "summarize-review", status: "CANCELED" },
        ],
      },
    });
    expect(currentRun).toMatchObject({
      revision: 3,
      status: "FAILED",
      steps: [
        { stepKey: "prepare-review", status: "FAILED" },
        { stepKey: "summarize-review", status: "CANCELED" },
      ],
    });
  });

  it("marks persisted queued and running Runs interrupted on load", async () => {
    const queued = createQueuedRun();
    const running = createRunningRun(automaticApproved);
    const saveRun = vi.fn(async () => undefined);
    const repository = {
      latestSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          approved,
          receipt: null,
          run: queued,
          runReceipt: null,
        })
        .mockResolvedValueOnce({
          approved: automaticApproved,
          receipt: null,
          run: running,
          runReceipt: null,
        }),
      saveRun,
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: () => "rrn_01J00000000000000000000005",
        now: () => "2026-08-16T12:04:00.000Z",
      },
    );

    await expect(controller.loadLatestState()).resolves.toMatchObject({
      run: { status: "FAILED", failureCode: "INTERRUPTED" },
    });
    await expect(controller.loadLatestState()).resolves.toMatchObject({
      run: { status: "FAILED", failureCode: "INTERRUPTED" },
    });
    expect(saveRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: queued.runId,
        status: "FAILED",
        failureCode: "INTERRUPTED",
      }),
    );
    expect(saveRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: running.runId,
        status: "FAILED",
        failureCode: "INTERRUPTED",
      }),
    );
  });

  it("returns an existing nonterminal Run instead of minting another", async () => {
    const existing = createRunningRun(automaticApproved);
    const repository = {
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => existing),
      saveRun: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: vi.fn(() => "rrn_01J00000000000000000000006"),
        now: () => "2026-08-16T12:05:00.000Z",
      },
    );

    await expect(
      controller.startRun({
        schemaVersion: 1,
        ritualId: automaticApproved.ritualId,
        ritualRevision: automaticApproved.ritualRevision,
      }),
    ).resolves.toEqual({ status: "run", run: existing });
    expect(repository.saveRun).not.toHaveBeenCalled();
  });

  it("recovers a rejected terminal write without replaying the completed fixture", async () => {
    let currentRun: RitualRun | null = null;
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved: automaticApproved,
        receipt: null,
        run: currentRun,
        runReceipt: null,
      })),
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => null),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async () => {
        throw new Error("ATOMIC_TERMINAL_WRITE_FAILED");
      }),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: (prefix) =>
          prefix === "rrn"
            ? "rrn_01J00000000000000000000007"
            : "rcp_01J00000000000000000000007",
        now: () => "2026-08-16T12:06:00.000Z",
      },
    );

    await expect(
      controller.startRun({
        schemaVersion: 1,
        ritualId: automaticApproved.ritualId,
        ritualRevision: automaticApproved.ritualRevision,
      }),
    ).rejects.toThrow("ATOMIC_TERMINAL_WRITE_FAILED");
    expect(currentRun).toMatchObject({
      status: "RUNNING",
      currentStepKey: null,
      steps: [{ status: "COMPLETED" }],
    });

    await expect(controller.loadLatestState()).resolves.toMatchObject({
      run: {
        status: "FAILED",
        failureCode: "INTERRUPTED",
        currentStepKey: null,
      },
      runReceipt: null,
    });
    expect(repository.completeRun).toHaveBeenCalledOnce();
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
      latestSnapshot: vi.fn(async () => ({
        approved,
        receipt,
        run: null,
        runReceipt: null,
      })),
      find: vi.fn(async () => approved),
      findReceipt: vi.fn(async () => receipt),
      findLearningProposal: vi.fn(async () => proposal),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      saveLearningProposal: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
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
