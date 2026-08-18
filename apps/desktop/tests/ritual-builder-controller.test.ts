import {
  createRitualRun,
  reduceRitualRun,
  type RitualRun,
  type RitualSchedule,
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
    decideLearning: vi.fn(async () => undefined),
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
    followUp: vi.fn(async () => {
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
  it("answers a follow-up from the selected Ritual and sanitized latest Receipt", async () => {
    const runReceipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000009",
      runId: "rrn_01J00000000000000000000009",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      mode: "RUN" as const,
      executionProvider: "LOCAL_RITUAL_V1" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "The pipeline review is ready.",
      stepEvidence: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          actor: approved.steps[0]!.actor,
          research: null,
          report: null,
        },
      ],
      uncertainties: ["The final owner priority is unknown."],
      externalEffects: [] as const,
      startedAt: "2026-08-17T12:00:00.000Z",
      recordedAt: "2026-08-17T12:01:00.000Z",
    };
    const snapshot = {
      approved,
      receipt: null,
      run: null,
      runReceipt,
      learningReview: null,
      auditTimeline: [],
    };
    const repository = {
      snapshotFor: vi.fn(async () => snapshot),
      latestReceiptFor: vi.fn(async () => runReceipt),
      ...unusedRunPersistence(),
    };
    const provider = {
      ...unavailableProvider(),
      followUp: vi.fn(async (context) => ({
        status: "answer" as const,
        requestId: context.requestId,
        ritualId: context.ritualId,
        ritualRevision: context.ritualRevision,
        answer: "Review the unknown final priority before the next Run.",
      })),
    };
    const controller = new RitualBuilderController(
      provider,
      repository as never,
    );

    await expect(
      controller.followUp({
        schemaVersion: 1,
        requestId: "rfu_01J00000000000000000000000",
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
        question: "What needs my attention?",
      }),
    ).resolves.toMatchObject({ status: "answer" });
    expect(provider.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ritual: expect.objectContaining({ name: approved.name }),
        evidence: expect.objectContaining({
          mode: "RUN",
          summary: runReceipt.summary,
        }),
      }),
    );
    await expect(
      controller.followUp({
        schemaVersion: 1,
        requestId: "rfu_01J00000000000000000000001",
        ritualId: approved.ritualId,
        ritualRevision: 2,
        question: "Can this use the prior revision?",
      }),
    ).rejects.toThrow("STALE_RITUAL_REVISION");
    expect(provider.followUp).toHaveBeenCalledOnce();
    expect(repository.latestReceiptFor).toHaveBeenCalledWith(
      approved.ritualId,
      approved.ritualRevision,
    );
  });

  it("uses the newest Receipt and removes URLs from its follow-up evidence", async () => {
    const olderRunReceipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000008",
      runId: "rrn_01J00000000000000000000008",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      mode: "RUN" as const,
      executionProvider: "LOCAL_RITUAL_V1" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "The older Run is ready.",
      stepEvidence: [],
      uncertainties: [],
      externalEffects: [] as const,
      startedAt: "2026-08-17T11:00:00.000Z",
      recordedAt: "2026-08-17T16:00:00.000Z",
    };
    const newerTestReceipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000009",
      runId: "rrn_01J00000000000000000000009",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      mode: "TEST" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "Review https://example.com/private before the next Run.",
      evidence: ["The private source at www.example.com supports review."],
      uncertainties: ["The source https://example.com may have changed."],
      sampleDigest: "a".repeat(64),
      sampleCharacterCount: 42,
      externalEffects: [] as const,
      recordedAt: "2026-08-17T12:00:00.000-05:00",
    };
    const repository = {
      snapshotFor: vi.fn(async () => ({
        approved,
        receipt: newerTestReceipt,
        run: null,
        runReceipt: olderRunReceipt,
        learningReview: null,
        auditTimeline: [],
      })),
      latestReceiptFor: vi.fn(async () => newerTestReceipt),
      ...unusedRunPersistence(),
    };
    const provider = {
      ...unavailableProvider(),
      followUp: vi.fn(async (context) => ({
        status: "answer" as const,
        requestId: context.requestId,
        ritualId: context.ritualId,
        ritualRevision: context.ritualRevision,
        answer: "Review the newest Test Receipt.",
      })),
    };
    const controller = new RitualBuilderController(
      provider,
      repository as never,
    );

    await controller.followUp({
      schemaVersion: 1,
      requestId: "rfu_01J00000000000000000000002",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      question: "What changed most recently?",
    });

    const context = provider.followUp.mock.calls[0]![0];
    expect(context.evidence).toMatchObject({ mode: "TEST" });
    expect(JSON.stringify(context.evidence)).not.toMatch(/https?:\/\/|www\./i);
  });

  it("answers for an approved Ritual when no Receipt exists", async () => {
    const repository = {
      snapshotFor: vi.fn(async () => ({
        approved,
        receipt: null,
        run: null,
        runReceipt: null,
        learningReview: null,
        auditTimeline: [],
      })),
      latestReceiptFor: vi.fn(async () => null),
      ...unusedRunPersistence(),
    };
    const provider = {
      ...unavailableProvider(),
      followUp: vi.fn(async (context) => ({
        status: "answer" as const,
        requestId: context.requestId,
        ritualId: context.ritualId,
        ritualRevision: context.ritualRevision,
        answer: "This Ritual has not produced a Receipt yet.",
      })),
    };
    const controller = new RitualBuilderController(
      provider,
      repository as never,
    );

    await expect(
      controller.followUp({
        schemaVersion: 1,
        requestId: "rfu_01J00000000000000000000004",
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
        question: "What evidence do we have?",
      }),
    ).resolves.toMatchObject({ status: "answer" });
    expect(provider.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ evidence: null }),
    );
  });

  it("rejects a delayed follow-up after the Ritual revision changes", async () => {
    let currentApproved = approved;
    let resolveProvider!: (value: {
      status: "answer";
      requestId: string;
      ritualId: string;
      ritualRevision: number;
      answer: string;
    }) => void;
    const repository = {
      snapshotFor: vi.fn(async () => ({
        approved: currentApproved,
        receipt: null,
        run: null,
        runReceipt: null,
        learningReview: null,
        auditTimeline: [],
      })),
      latestReceiptFor: vi.fn(async () => null),
      ...unusedRunPersistence(),
    };
    const provider = {
      ...unavailableProvider(),
      followUp: vi.fn(
        async () =>
          new Promise<{
            status: "answer";
            requestId: string;
            ritualId: string;
            ritualRevision: number;
            answer: string;
          }>((resolve) => {
            resolveProvider = resolve;
          }),
      ),
    };
    const controller = new RitualBuilderController(
      provider,
      repository as never,
    );
    const pending = controller.followUp({
      schemaVersion: 1,
      requestId: "rfu_01J00000000000000000000003",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      question: "Is this still current?",
    });
    await vi.waitFor(() => expect(provider.followUp).toHaveBeenCalledOnce());
    currentApproved = { ...approved, ritualRevision: 2 } as typeof approved;
    resolveProvider({
      status: "answer",
      requestId: "rfu_01J00000000000000000000003",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      answer: "This answer belongs to revision 1.",
    });

    await expect(pending).resolves.toMatchObject({
      status: "waiting",
      reason: "STALE_STEWARD_RESULT",
    });
    expect(repository.snapshotFor).toHaveBeenCalledTimes(2);
  });

  it("lists Rituals and opens one exact persisted snapshot", async () => {
    const snapshot = {
      approved,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
    };
    const catalog = [
      {
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
        name: approved.name,
        approvedAt: approved.approvedAt,
      },
    ];
    const workspace = {
      ...snapshot,
      schedule: null,
      inbox: [],
    };
    const repository = {
      latestSnapshot: vi.fn(async () => snapshot),
      snapshotFor: vi.fn(async (ritualId: string) =>
        ritualId === approved.ritualId ? snapshot : null,
      ),
      catalog: vi.fn(async () => catalog),
      initialWorkspaceSnapshot: vi.fn(async () => ({
        ...workspace,
        rituals: catalog,
      })),
      workspaceSnapshotFor: vi.fn(async (ritualId: string) =>
        ritualId === approved.ritualId ? workspace : null,
      ),
      automationSnapshotFor: vi.fn(async () => ({
        approved,
        schedule: null,
        inbox: [],
      })),
      listSchedules: vi.fn(async () => []),
      ...unusedRunPersistence(),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository as never,
    );

    await expect(controller.listRituals()).resolves.toEqual(catalog);
    await expect(controller.loadInitialWorkspaceState()).resolves.toEqual({
      ...workspace,
      rituals: catalog,
    });
    await expect(
      controller.loadRitualWorkspaceState(approved.ritualId),
    ).resolves.toEqual(workspace);
    await expect(
      controller.loadRitualWorkspaceState("rtl_01J00000000000000000000001"),
    ).rejects.toThrow("RITUAL_NOT_FOUND");
  });

  it("restores an exact prior revision through repository-owned history", async () => {
    const learned = {
      ...approved,
      ritualRevision: 2,
      learningProposalId: "rlp_01J00000000000000000000000",
      basedOnReceiptId: "rcp_01J00000000000000000000000",
      completion: "Three concise bullets are ready for review.",
      approvedAt: "2026-08-16T16:03:00.000Z",
    };
    const snapshot = {
      approved: learned,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
    };
    const repository = {
      latestSnapshot: vi.fn(async () => snapshot),
      find: vi.fn(async () => learned),
      findRevision: vi.fn(async () => approved),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      { now: () => "2026-08-17T16:03:00.000Z" },
    );

    await expect(
      controller.restoreRevision({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        expectedCurrentRevision: 2,
        restoreFromRevision: 1,
        restoredAt: "2026-08-17T15:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      ritualRevision: 3,
      restoredFromRevision: 1,
      completion: approved.completion,
      approvedAt: "2026-08-17T16:03:00.000Z",
    });
    expect(repository.save).toHaveBeenCalledOnce();
  });

  it("refuses restore while a Run or learning Review still needs attention", async () => {
    const learned = {
      ...approved,
      ritualRevision: 2,
      learningProposalId: "rlp_01J00000000000000000000000",
      basedOnReceiptId: "rcp_01J00000000000000000000000",
      approvedAt: "2026-08-16T16:03:00.000Z",
    };
    const baseSnapshot = {
      approved: learned,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
    };
    const repository = {
      latestSnapshot: vi.fn(async () => baseSnapshot),
      find: vi.fn(async () => learned),
      findRevision: vi.fn(async () => approved),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
    };
    repository.findNonterminalRun.mockResolvedValueOnce(
      createQueuedRun(learned),
    );
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
    );
    const request = {
      schemaVersion: 1 as const,
      ritualId: approved.ritualId,
      expectedCurrentRevision: 2,
      restoreFromRevision: 1,
      restoredAt: "2026-08-17T16:03:00.000Z",
    };

    await expect(controller.restoreRevision(request)).rejects.toThrow(
      "RITUAL_RESTORE_RUN_ACTIVE",
    );
    repository.findNonterminalRun.mockResolvedValueOnce(null);
    repository.latestSnapshot.mockResolvedValueOnce({
      ...baseSnapshot,
      learningReview: {
        kind: "TEST" as const,
        proposal: {
          status: "proposal" as const,
          proposalId: "rlp_01J00000000000000000000001",
          ritualId: learned.ritualId,
          fromRevision: 2,
          receiptId: "rcp_01J00000000000000000000001",
          ownerFeedback: "Return to the previous scope.",
          stewardMessage: "Review this change first.",
          rationale: "Owner feedback requested it.",
          proposedDefinition: {
            name: learned.name,
            purpose: learned.purpose,
            trigger: learned.trigger,
            steps: learned.steps,
            permissions: learned.permissions,
            completion: learned.completion,
            reviewPolicy: learned.reviewPolicy,
          },
        },
        receipt: {
          schemaVersion: 1 as const,
          receiptId: "rcp_01J00000000000000000000001",
          runId: "rrn_01J00000000000000000000001",
          ritualId: learned.ritualId,
          ritualRevision: 2,
          mode: "TEST" as const,
          outcome: "NEEDS_REVIEW" as const,
          summary: "Reviewable result.",
          evidence: ["One bounded fact."],
          uncertainties: [],
          sampleDigest: "a".repeat(64),
          sampleCharacterCount: 32,
          externalEffects: [] as const,
          recordedAt: "2026-08-17T15:00:00.000Z",
        },
      },
    });
    await expect(controller.restoreRevision(request)).rejects.toThrow(
      "RITUAL_RESTORE_LEARNING_PENDING",
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

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
        learningReview: null,
        auditTimeline: [],
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
      learningReview: null,
      auditTimeline: [],
    });
    await expect(controller.loadLatestState()).resolves.toEqual({
      approved,
      receipt: null,
      run: null,
      runReceipt: null,
      learningReview: null,
      auditTimeline: [],
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
      findNonterminalRun: vi.fn(async () => currentRun),
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
        executionProvider: "LOCAL_RITUAL_V1",
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

  it("starts a scheduled occurrence with its durable Run id and replays it idempotently", async () => {
    let currentRun: RitualRun | null = null;
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved,
        receipt: null,
        run: currentRun,
        runReceipt: null,
      })),
      find: vi.fn(async () => approved),
      findRunWithApprovedRevision: vi.fn(async () =>
        currentRun ? { run: currentRun, approved } : null,
      ),
      findNonterminalRun: vi.fn(async () => currentRun),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      { now: () => "2026-08-17T11:00:01.000Z" },
    );
    const request = {
      schemaVersion: 1 as const,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      runId: "rrn_01J00000000000000000000020",
      dueAt: "2026-08-17T11:00:00.000Z",
    };

    const first = await controller.startScheduledRun(request);
    const replay = await controller.startScheduledRun(request);
    const nextOccurrence = await controller.startScheduledRun({
      ...request,
      runId: "rrn_01J00000000000000000000021",
      dueAt: "2026-08-18T11:00:00.000Z",
    });

    expect(first).toMatchObject({
      status: "run",
      run: { runId: request.runId, status: "WAITING_FOR_OWNER" },
    });
    expect(replay).toEqual(first);
    expect(nextOccurrence).toEqual(first);
    expect(repository.saveRun).toHaveBeenCalledTimes(2);
  });

  it("does not mark a pending scheduled Run interrupted when the inbox opens", async () => {
    const run = createRunningRun(
      automaticApproved,
      "rrn_01J00000000000000000000022",
    );
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved: automaticApproved,
        receipt: null,
        run,
        runReceipt: null,
      })),
      listSchedules: vi.fn(async () => [
        {
          schemaVersion: 1 as const,
          ritualId: automaticApproved.ritualId,
          ritualRevision: automaticApproved.ritualRevision,
          state: "ENABLED" as const,
          cadence: "DAILY" as const,
          localTime: "06:00",
          timeZone: "America/Chicago",
          nextRunAt: "2026-08-18T11:00:00.000Z",
          pendingOccurrence: {
            runId: run.runId,
            dueAt: "2026-08-17T11:00:00.000Z",
          },
          lastTriggeredAt: null,
          updatedAt: "2026-08-17T11:00:00.000Z",
        },
      ]),
      saveRun: vi.fn(),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
    );

    await expect(controller.loadLatestState()).resolves.toMatchObject({ run });
    expect(repository.saveRun).not.toHaveBeenCalled();
  });

  it("configures and authoritatively pauses a schedule while waking the scheduler", async () => {
    let storedSchedule: RitualSchedule | null = null;
    const repository = {
      find: vi.fn(async () => approved),
      listSchedules: vi.fn(async () =>
        storedSchedule ? [storedSchedule] : [],
      ),
      saveSchedule: vi.fn(async (schedule: RitualSchedule) => {
        storedSchedule = schedule;
      }),
    };
    const onScheduleChanged = vi.fn();
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        now: () => "2026-08-16T22:00:00.000Z",
        onScheduleChanged,
      },
    );

    await controller.configureSchedule({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      cadence: "DAILY",
      localTime: "06:00",
      timeZone: "America/Chicago",
    });
    storedSchedule = {
      ...storedSchedule,
      pendingOccurrence: {
        runId: "rrn_01J00000000000000000000023",
        dueAt: storedSchedule.nextRunAt,
      },
    };

    await expect(
      controller.pauseSchedule({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      }),
    ).resolves.toMatchObject({ state: "PAUSED", pendingOccurrence: null });
    expect(onScheduleChanged).toHaveBeenCalledTimes(2);
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
            status: "completed" as const,
            stepKey: "prepare-review",
            research: null,
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
      listSchedules: vi.fn(async () => []),
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

  it("persists an Exa wait and resumes the exact Run after owner recovery", async () => {
    const researchApproved = {
      ...automaticApproved,
      research: {
        provider: "EXA" as const,
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 30,
      },
    };
    let currentRun: RitualRun | null = null;
    const repository = {
      find: vi.fn(async () => researchApproved),
      findNonterminalRun: vi.fn(async () => currentRun),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
    };
    const completeCurrentStep = vi
      .fn()
      .mockResolvedValueOnce({
        status: "waiting",
        stepKey: "prepare-review",
        reason: "AUTHENTICATION_REQUIRED",
        externalEffects: [],
      })
      .mockResolvedValueOnce({
        status: "completed",
        stepKey: "prepare-review",
        research: {
          provider: "EXA",
          requestId: "exa-run-1",
          sources: [],
        },
        externalEffects: [],
      });
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: (prefix) =>
          prefix === "rrn"
            ? "rrn_01J00000000000000000000008"
            : "rcp_01J00000000000000000000008",
        now: () => "2026-08-16T12:07:00.000Z",
        runExecutor: { completeCurrentStep },
      },
    );
    const request = {
      schemaVersion: 1 as const,
      ritualId: researchApproved.ritualId,
      ritualRevision: researchApproved.ritualRevision,
    };

    await expect(controller.startRun(request)).resolves.toMatchObject({
      status: "run",
      run: {
        status: "WAITING_FOR_RESOURCE",
        waitingReason: "AUTHENTICATION_REQUIRED",
      },
    });
    await expect(controller.startRun(request)).resolves.toMatchObject({
      status: "receipt",
      run: { status: "NEEDS_REVIEW" },
      receipt: {
        stepEvidence: [
          {
            research: { provider: "EXA", requestId: "exa-run-1" },
          },
        ],
      },
    });
    expect(completeCurrentStep).toHaveBeenCalledTimes(2);
    expect(repository.completeRun).toHaveBeenCalledOnce();
  });

  it("durably cancels a deferred research retry and ignores its late completion", async () => {
    const researchApproved = {
      ...automaticApproved,
      research: {
        provider: "EXA" as const,
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 30,
      },
    };
    let currentRun = createRunningRun(
      researchApproved,
      "rrn_01J00000000000000000000009",
    );
    currentRun = reduceRitualRun(currentRun, researchApproved, {
      type: "WAIT_FOR_RESOURCE",
      reason: "AUTHENTICATION_REQUIRED",
      occurredAt: "2026-08-16T13:00:02.000Z",
    });
    const repository = {
      find: vi.fn(async () => researchApproved),
      findNonterminalRun: vi.fn(async () => currentRun),
      findRunWithApprovedRevision: vi.fn(async () => ({
        run: currentRun,
        approved: researchApproved,
      })),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
    };
    let resolveExecution!: (value: {
      status: "completed";
      stepKey: string;
      research: null;
      externalEffects: readonly [];
    }) => void;
    const execution = new Promise<{
      status: "completed";
      stepKey: string;
      research: null;
      externalEffects: readonly [];
    }>((resolve) => {
      resolveExecution = resolve;
    });
    const completeCurrentStep = vi.fn(() => execution);
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        now: () => "2026-08-16T13:00:03.000Z",
        runExecutor: { completeCurrentStep },
      },
    );
    const start = controller.startRun({
      schemaVersion: 1,
      ritualId: researchApproved.ritualId,
      ritualRevision: researchApproved.ritualRevision,
    });
    await vi.waitFor(() => expect(completeCurrentStep).toHaveBeenCalledOnce());

    await expect(
      controller.cancelRun({ schemaVersion: 1, runId: currentRun.runId }),
    ).resolves.toMatchObject({ status: "run", run: { status: "CANCELED" } });
    await expect(start).resolves.toMatchObject({
      status: "run",
      run: { status: "CANCELED" },
    });

    resolveExecution({
      status: "completed",
      stepKey: "prepare-review",
      research: null,
      externalEffects: [],
    });
    await Promise.resolve();
    expect(currentRun).toMatchObject({ status: "CANCELED" });
    expect(repository.completeRun).not.toHaveBeenCalled();
  });

  it("honors cancellation queued before retry activation without starting executor work", async () => {
    const researchApproved = {
      ...automaticApproved,
      research: {
        provider: "EXA" as const,
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 30,
      },
    };
    let currentRun = createRunningRun(
      researchApproved,
      "rrn_01J00000000000000000000010",
    );
    currentRun = reduceRitualRun(currentRun, researchApproved, {
      type: "WAIT_FOR_RESOURCE",
      reason: "AUTHENTICATION_REQUIRED",
      occurredAt: "2026-08-16T13:01:00.000Z",
    });
    let releaseFind!: () => void;
    const findBlocked = new Promise<void>((resolve) => {
      releaseFind = resolve;
    });
    const repository = {
      find: vi.fn(async () => {
        await findBlocked;
        return researchApproved;
      }),
      findNonterminalRun: vi.fn(async () => currentRun),
      findRunWithApprovedRevision: vi.fn(async () => ({
        run: currentRun,
        approved: researchApproved,
      })),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async () => undefined),
    };
    const completeCurrentStep = vi.fn(async () => ({
      status: "completed" as const,
      stepKey: "prepare-review",
      research: null,
      externalEffects: [] as const,
    }));
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        now: () => "2026-08-16T13:01:01.000Z",
        runExecutor: { completeCurrentStep },
      },
    );

    const retry = controller.startRun({
      schemaVersion: 1,
      ritualId: researchApproved.ritualId,
      ritualRevision: researchApproved.ritualRevision,
    });
    await vi.waitFor(() => expect(repository.find).toHaveBeenCalledOnce());
    const cancel = controller.cancelRun({
      schemaVersion: 1,
      runId: currentRun.runId,
    });
    releaseFind();

    await expect(cancel).resolves.toMatchObject({
      status: "run",
      run: { status: "CANCELED" },
    });
    await expect(retry).resolves.toMatchObject({
      status: "run",
      run: { status: "CANCELED" },
    });
    expect(completeCurrentStep).not.toHaveBeenCalled();
    expect(repository.completeRun).not.toHaveBeenCalled();
  });

  it("lets cancellation win while terminal persistence is still pre-commit", async () => {
    let currentRun: RitualRun | null = null;
    let terminalSignal: AbortSignal | undefined;
    let terminalWriteStarted!: () => void;
    const terminalStarted = new Promise<void>((resolve) => {
      terminalWriteStarted = resolve;
    });
    const repository = {
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => null),
      findRunWithApprovedRevision: vi.fn(async () =>
        currentRun ? { run: currentRun, approved: automaticApproved } : null,
      ),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(
        async (
          _run: RitualRun,
          _receipt: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          terminalSignal = options?.signal;
          terminalWriteStarted();
          await new Promise<void>((resolve, reject) => {
            const cancel = () => reject(new Error("RITUAL_RUN_CANCELED"));
            options?.signal?.addEventListener("abort", cancel, { once: true });
          });
        },
      ),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: (prefix) =>
          prefix === "rrn"
            ? "rrn_01J00000000000000000000011"
            : "rcp_01J00000000000000000000011",
        now: () => "2026-08-16T13:02:00.000Z",
      },
    );
    const start = controller.startRun({
      schemaVersion: 1,
      ritualId: automaticApproved.ritualId,
      ritualRevision: automaticApproved.ritualRevision,
    });
    await terminalStarted;

    const cancel = controller.cancelRun({
      schemaVersion: 1,
      runId: "rrn_01J00000000000000000000011",
    });

    await expect(cancel).resolves.toMatchObject({
      status: "run",
      run: { status: "CANCELED" },
    });
    await expect(start).resolves.toMatchObject({
      status: "run",
      run: { status: "CANCELED" },
    });
    expect(terminalSignal?.aborted).toBe(true);
    expect(currentRun).toMatchObject({ status: "CANCELED" });
  });

  it("returns the committed receipt when cancellation arrives after the terminal commit point", async () => {
    let currentRun: RitualRun | null = null;
    let releaseTerminalWrite!: () => void;
    const terminalRelease = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let terminalCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      terminalCommitted = resolve;
    });
    const repository = {
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => null),
      findRunWithApprovedRevision: vi.fn(async () =>
        currentRun ? { run: currentRun, approved: automaticApproved } : null,
      ),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async (run: RitualRun) => {
        // This assignment models the repository's documented atomic commit
        // point. An abort after it cannot safely be rewritten as CANCELED.
        currentRun = run;
        terminalCommitted();
        await terminalRelease;
      }),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
      {
        createId: (prefix) =>
          prefix === "rrn"
            ? "rrn_01J00000000000000000000013"
            : "rcp_01J00000000000000000000013",
        now: () => "2026-08-16T13:02:30.000Z",
      },
    );
    const start = controller.startRun({
      schemaVersion: 1,
      ritualId: automaticApproved.ritualId,
      ritualRevision: automaticApproved.ritualRevision,
    });
    await committed;
    const cancel = controller.cancelRun({
      schemaVersion: 1,
      runId: "rrn_01J00000000000000000000013",
    });
    releaseTerminalWrite();

    await expect(start).resolves.toMatchObject({
      status: "receipt",
      run: { status: "NEEDS_REVIEW" },
    });
    await expect(cancel).resolves.toMatchObject({
      status: "receipt",
      run: { status: "NEEDS_REVIEW" },
    });
    expect(repository.saveRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELED" }),
    );
  });

  it("aborts and durably cancels active work before closing the provider", async () => {
    let currentRun: RitualRun | null = null;
    let observedSignal: AbortSignal | undefined;
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const repository = {
      find: vi.fn(async () => automaticApproved),
      findNonterminalRun: vi.fn(async () => null),
      findRunWithApprovedRevision: vi.fn(async () =>
        currentRun ? { run: currentRun, approved: automaticApproved } : null,
      ),
      saveRun: vi.fn(async (run: RitualRun) => {
        currentRun = run;
      }),
      completeRun: vi.fn(async () => undefined),
    };
    const provider = unavailableProvider();
    const completeCurrentStep = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) => {
        observedSignal = signal;
        executionStarted();
        return new Promise<never>(() => undefined);
      },
    );
    const controller = new RitualBuilderController(provider, repository, {
      createId: () => "rrn_01J00000000000000000000012",
      now: () => "2026-08-16T13:03:00.000Z",
      runExecutor: { completeCurrentStep },
    });
    const start = controller.startRun({
      schemaVersion: 1,
      ritualId: automaticApproved.ritualId,
      ritualRevision: automaticApproved.ritualRevision,
    });
    await started;

    await controller.close();

    await expect(start).resolves.toMatchObject({
      status: "run",
      run: { status: "CANCELED" },
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(currentRun).toMatchObject({ status: "CANCELED" });
    expect(repository.completeRun).not.toHaveBeenCalled();
    expect(provider.close).toHaveBeenCalledOnce();
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
      listSchedules: vi.fn(async () => []),
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

  it("binds a learning rejection to the exact current proposal", async () => {
    const proposal = {
      status: "proposal" as const,
      proposalId: "rlp_01J00000000000000000000000",
      ritualId: approved.ritualId,
      fromRevision: approved.ritualRevision,
      receiptId: "rcp_01J00000000000000000000000",
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
    const repository = {
      ...unusedRunPersistence(),
      latestSnapshot: vi.fn(),
      decideLearning: vi.fn(async () => undefined),
    };
    const controller = new RitualBuilderController(
      unavailableProvider(),
      repository,
    );

    await controller.decideLearning({
      schemaVersion: 1,
      proposalId: proposal.proposalId,
      ritualId: approved.ritualId,
      expectedFromRevision: approved.ritualRevision,
      decision: "REJECTED",
    });
    expect(repository.decideLearning).toHaveBeenCalledWith({
      schemaVersion: 1,
      proposalId: proposal.proposalId,
      ritualId: approved.ritualId,
      expectedFromRevision: approved.ritualRevision,
      decision: "REJECTED",
    });

    await expect(
      controller.decideLearning({
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        ritualId: approved.ritualId,
        expectedFromRevision: 1,
        decision: "REJECTED",
        extra: true,
      }),
    ).rejects.toThrow();
    expect(repository.decideLearning).toHaveBeenCalledOnce();
  });

  it("locates and validates exact Run Receipt evidence before learning", async () => {
    const runReceipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000009",
      runId: "rrn_01J00000000000000000000009",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      mode: "RUN" as const,
      executionProvider: "LOCAL_RITUAL_V1" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "The completed Run needs an owner review.",
      stepEvidence: [
        {
          stepKey: approved.steps[0]!.stepKey,
          title: approved.steps[0]!.title,
          actor: approved.steps[0]!.actor,
          research: null,
        },
      ],
      uncertainties: [
        "No external provider was invoked; this Receipt proves orchestration only.",
      ],
      externalEffects: [] as const,
      startedAt: "2026-08-16T12:00:01.000Z",
      recordedAt: "2026-08-16T12:00:04.000Z",
    };
    const provider = {
      ...unavailableProvider(),
      learn: vi.fn(async (context) => ({
        status: "proposal" as const,
        proposalId: context.proposalId,
        ritualId: context.ritual.ritualId,
        fromRevision: context.ritual.ritualRevision,
        receiptId: context.receipt.receiptId,
        ownerFeedback: context.ownerFeedback,
        stewardMessage: "I propose a more concise result.",
        rationale: "The completed Run and owner feedback support this change.",
        proposedDefinition: {
          name: context.ritual.name,
          purpose: context.ritual.purpose,
          trigger: context.ritual.trigger,
          steps: context.ritual.steps,
          permissions: context.ritual.permissions,
          completion: "A concise reviewable result is ready.",
          reviewPolicy: context.ritual.reviewPolicy,
        },
      })),
    };
    const repository = {
      latestSnapshot: vi.fn(async () => ({
        approved,
        receipt: null,
        run: null,
        runReceipt,
      })),
      find: vi.fn(async () => approved),
      findReceipt: vi.fn(async () => runReceipt),
      findLearningProposal: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      saveReceipt: vi.fn(async () => undefined),
      saveLearningProposal: vi.fn(async () => undefined),
      ...unusedRunPersistence(),
    };
    const controller = new RitualBuilderController(provider, repository, {
      createId: () => "rlp_01J00000000000000000000009",
      now: () => "2026-08-16T12:05:00.000Z",
    });

    await expect(
      controller.proposeLearning({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
        receiptId: runReceipt.receiptId,
        feedback: "Keep the evidence but make the next result more concise.",
      }),
    ).resolves.toMatchObject({
      status: "proposal",
      receiptId: runReceipt.receiptId,
    });
    expect(provider.learn).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({ mode: "RUN" }),
      }),
    );
    expect(repository.saveLearningProposal).toHaveBeenCalledOnce();

    repository.findReceipt.mockResolvedValueOnce({
      ...runReceipt,
      ritualRevision: approved.ritualRevision + 1,
    });
    await expect(
      controller.proposeLearning({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
        receiptId: runReceipt.receiptId,
        feedback: "Keep the evidence but make the next result more concise.",
      }),
    ).rejects.toThrow("STALE_RITUAL_LEARNING_PROPOSAL");
    expect(provider.learn).toHaveBeenCalledOnce();
  });
});
