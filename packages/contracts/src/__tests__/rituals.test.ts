import { describe, expect, it } from "vitest";
import {
  approveRitualDraft,
  approveRitualLearningProposal,
  RitualApprovalError,
  ritualApprovalRequestSchema,
  ritualDraftSchema,
  ritualLearningApprovalRequestSchema,
  ritualLearningContextSchema,
  ritualLearningProposalSchema,
  ritualStewardContextSchema,
  ritualStewardProposalSchema,
  ritualTestRunRequestSchema,
  ritualTestRunResultSchema,
  createRitualRun,
  createRitualRunReceipt,
  reduceRitualRun,
  validateRitualRunReceipt,
  ritualRunReceiptSchema,
  ritualRunRequestSchema,
  ritualRunSchema,
  ritualScheduleSchema,
  ritualScheduleUpdateRequestSchema,
  createRitualTestReceipt,
  validateRitualStewardResult,
  validateRitualLearningResult,
  validateRitualTestRunResult,
} from "../index.js";

const draft = {
  schemaVersion: 1 as const,
  draftId: "rtd_01J00000000000000000000000",
  revision: 3,
  status: "DRAFT" as const,
  name: "Weekday pipeline review",
  purpose: "Review new opportunities and prepare a focused follow-up list.",
  trigger: {
    kind: "SCHEDULED" as const,
    summary: "Every weekday at 8:30 AM America/Chicago",
  },
  steps: [
    {
      stepKey: "gather-opportunities",
      title: "Gather current opportunities",
      description: "Collect the records changed since the previous Run.",
      actor: { kind: "STEWARD" as const, role: "Steward" },
      approval: "NONE" as const,
    },
    {
      stepKey: "review-shortlist",
      title: "Review the proposed shortlist",
      description: "Ask the owner before any external follow-up.",
      actor: { kind: "VILLAGER" as const, role: "Reviewer" },
      approval: "OWNER_REQUIRED" as const,
    },
  ],
  permissions: ["Read the connected opportunity source"],
  completion: "A reviewed shortlist is ready with evidence for every item.",
  research: {
    provider: "EXA" as const,
    query: "recent public signals about the shortlisted opportunities",
    maxResults: 4,
    lookbackDays: 30,
  },
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  updatedAt: "2026-08-15T15:00:00.000Z",
};

describe("Ritual contracts", () => {
  it("binds an executable local schedule to one approved Ritual revision", () => {
    const schedule = ritualScheduleSchema.parse({
      schemaVersion: 1,
      ritualId: "rtl_01J00000000000000000000000",
      ritualRevision: 1,
      state: "ENABLED",
      cadence: "DAILY",
      localTime: "06:00",
      timeZone: "America/Chicago",
      nextRunAt: "2026-08-17T11:00:00.000Z",
      pendingOccurrence: null,
      lastTriggeredAt: null,
      updatedAt: "2026-08-16T22:00:00.000Z",
    });

    expect(schedule.localTime).toBe("06:00");
    expect(
      ritualScheduleUpdateRequestSchema.safeParse({
        schemaVersion: 1,
        ritualId: schedule.ritualId,
        ritualRevision: 1,
        cadence: "WEEKDAYS",
        localTime: "24:00",
        timeZone: "America/Chicago",
      }).success,
    ).toBe(false);
    expect(
      ritualScheduleSchema.safeParse({
        ...schedule,
        pendingOccurrence: {
          runId: "rrn_01J00000000000000000000001",
          dueAt: schedule.nextRunAt,
        },
      }).success,
    ).toBe(true);
  });

  it("keeps the Steward drafting boundary bounded and rejects stale proposals", () => {
    const context = ritualStewardContextSchema.parse({
      schemaVersion: 1,
      draftId: draft.draftId,
      requestRevision: 1,
      ownerPurpose: "Review my sales pipeline and prepare the next follow-ups.",
    });
    const proposal = ritualStewardProposalSchema.parse({
      status: "proposal",
      draftId: draft.draftId,
      requestRevision: 1,
      stewardMessage: "I have shaped a focused draft for you to review.",
      name: "Pipeline follow-up review",
      purpose: context.ownerPurpose,
      steps: draft.steps,
      permissions: draft.permissions,
      completion: draft.completion,
    });

    expect(validateRitualStewardResult(context, proposal)).toEqual(proposal);
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        requestRevision: 2,
      }),
    ).toMatchObject({ status: "waiting", reason: "STALE_STEWARD_RESULT" });
    expect(
      ritualStewardContextSchema.safeParse({
        ...context,
        rawPageContent: "must never cross the provider boundary",
      }).success,
    ).toBe(false);
  });

  it("requires an exact Exa resource for the 30-day signal starter", () => {
    const context = ritualStewardContextSchema.parse({
      schemaVersion: 1,
      draftId: draft.draftId,
      requestRevision: 1,
      ownerPurpose:
        "Prepare a grounded brief on the most important public-web developments about AI coding agents from the last 30 days.",
      starter: {
        kind: "LAST_30_DAYS",
        topic: "AI coding agents",
      },
    });
    const proposal = {
      status: "proposal" as const,
      draftId: draft.draftId,
      requestRevision: 1,
      stewardMessage: "I shaped a bounded 30-day signal brief.",
      name: "AI coding agent signals",
      purpose: context.ownerPurpose,
      steps: draft.steps,
      permissions: ["Read bounded public-web evidence"],
      completion: "A grounded 30-day signal brief is ready for review.",
      research: {
        provider: "EXA" as const,
        query: context.starter!.topic,
        maxResults: 5,
        lookbackDays: 30,
      },
    };

    expect(validateRitualStewardResult(context, proposal)).toEqual(proposal);
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        research: { ...proposal.research, lookbackDays: 7 },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        research: { ...proposal.research, query: "broader technology news" },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        research: { ...proposal.research, maxResults: 4 },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        research: {
          ...proposal.research,
          includeDomains: ["example.com"],
        },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        research: undefined,
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("accepts one strict, versioned draft without execution authority", () => {
    expect(ritualDraftSchema.parse(draft)).toEqual(draft);
    expect(
      ritualDraftSchema.safeParse({
        ...draft,
        rawPrompt: "silently send every message",
      }).success,
    ).toBe(false);
    expect(
      ritualDraftSchema.safeParse({
        ...draft,
        reviewPolicy: { ownerReview: "NEVER", learning: "AUTONOMOUS" },
      }).success,
    ).toBe(false);
  });

  it("approves only the exact displayed draft revision", () => {
    const request = ritualApprovalRequestSchema.parse({
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: 3,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });

    expect(approveRitualDraft(draft, request)).toMatchObject({
      status: "APPROVED",
      ritualId: request.ritualId,
      ritualRevision: 1,
      approvedDraftId: draft.draftId,
      approvedDraftRevision: 3,
    });
    expect(
      ritualApprovalRequestSchema.safeParse({
        ...request,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    try {
      approveRitualDraft(draft, { ...request, expectedRevision: 2 });
      throw new Error("expected stale approval to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RitualApprovalError);
      expect((error as RitualApprovalError).code).toBe("STALE_RITUAL_DRAFT");
    }
    try {
      approveRitualDraft(draft, {
        ...request,
        draftId: "rtd_01J00000000000000000000001",
      });
      throw new Error("expected mismatched draft to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RitualApprovalError);
      expect((error as RitualApprovalError).code).toBe(
        "RITUAL_DRAFT_ID_MISMATCH",
      );
    }
  });

  it("binds a sample-only Test Run Receipt to the exact approved Ritual", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const request = ritualTestRunRequestSchema.parse({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      sample: "Customer A needs an answer before Friday.",
    });
    const result = ritualTestRunResultSchema.parse({
      status: "result",
      runId: "rrn_01J00000000000000000000000",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      summary: "Customer A is the highest-priority response.",
      evidence: ["The supplied deadline is Friday."],
      uncertainties: ["The commercial impact was not supplied."],
    });
    if (result.status !== "result") throw new Error("expected test result");

    const receipt = createRitualTestReceipt({
      approved,
      request,
      result,
      receiptId: "rcp_01J00000000000000000000000",
      sampleDigest: "a".repeat(64),
      recordedAt: "2026-08-15T15:02:00.000Z",
    });

    expect(receipt).toMatchObject({
      mode: "TEST",
      outcome: "NEEDS_REVIEW",
      externalEffects: [],
      sampleCharacterCount: request.sample.length,
    });
    expect(JSON.stringify(receipt)).not.toContain(request.sample);
    expect(
      ritualTestRunRequestSchema.safeParse({
        ...request,
        rawCredentials: "must not cross the boundary",
      }).success,
    ).toBe(false);
    expect(() =>
      createRitualTestReceipt({
        approved,
        request,
        result: { ...result, ritualRevision: 2 },
        receiptId: "rcp_01J00000000000000000000000",
        sampleDigest: "a".repeat(64),
        recordedAt: "2026-08-15T15:02:00.000Z",
      }),
    ).toThrow("STALE_RITUAL_TEST_RUN");

    expect(
      ritualTestRunResultSchema.safeParse({
        ...result,
        evidence: [],
        uncertainties: [],
      }).success,
    ).toBe(false);

    expect(
      validateRitualTestRunResult(
        {
          schemaVersion: 1,
          runId: result.runId,
          ritual: approved,
          sample: request.sample,
        },
        {
          ...result,
          summary: `Highest priority: ${request.sample}`,
        },
      ),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });

    const shortSample = "Deadline is Friday";
    expect(
      validateRitualTestRunResult(
        {
          schemaVersion: 1,
          runId: result.runId,
          ritual: approved,
          sample: shortSample,
        },
        {
          ...result,
          summary: `Highest priority: ${shortSample}`,
        },
      ),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("runs only an exact approved revision through a strict durable lifecycle", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const request = ritualRunRequestSchema.parse({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
    });
    let run = createRitualRun({
      approved,
      request,
      runId: "rrn_01J00000000000000000000001",
      createdAt: "2026-08-16T12:00:00.000Z",
    });
    expect(run).toMatchObject({
      status: "QUEUED",
      executionProvider: "LOCAL_RITUAL_V1",
      permissions: approved.permissions,
      externalEffects: [],
    });
    expect(run.steps.map((step) => step.status)).toEqual([
      "PENDING",
      "PENDING",
    ]);

    run = reduceRitualRun(run, approved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:01.000Z",
    });
    expect(run).toMatchObject({
      status: "RUNNING",
      currentStepKey: draft.steps[0]?.stepKey,
    });
    run = reduceRitualRun(run, approved, {
      type: "WAIT_FOR_RESOURCE",
      reason: "AUTHENTICATION_REQUIRED",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    expect(run).toMatchObject({
      status: "WAITING_FOR_RESOURCE",
      waitingReason: "AUTHENTICATION_REQUIRED",
      currentStepKey: draft.steps[0]?.stepKey,
    });
    run = reduceRitualRun(run, approved, {
      type: "RETRY_RESOURCE",
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_STEP",
      stepKey: draft.steps[0]!.stepKey,
      research: {
        provider: "EXA",
        requestId: "exa-run-1",
        sources: [
          {
            title: "Public signal",
            url: "https://example.com/signal",
            publishedAt: "2026-08-15T00:00:00.000Z",
            author: null,
            highlights: ["This remains untrusted source material."],
            taint: "UNTRUSTED_WEB",
          },
        ],
      },
      occurredAt: "2026-08-16T12:00:04.000Z",
    });
    expect(run).toMatchObject({
      status: "WAITING_FOR_OWNER",
      currentStepKey: draft.steps[1]?.stepKey,
    });
    run = reduceRitualRun(run, approved, {
      type: "APPROVE_STEP",
      stepKey: draft.steps[1]!.stepKey,
      occurredAt: "2026-08-16T12:00:05.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_STEP",
      stepKey: draft.steps[1]!.stepKey,
      occurredAt: "2026-08-16T12:00:06.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_RUN",
      outcome: "NEEDS_REVIEW",
      occurredAt: "2026-08-16T12:00:07.000Z",
    });
    expect(ritualRunSchema.parse(run)).toMatchObject({
      status: "NEEDS_REVIEW",
      currentStepKey: null,
    });

    const receipt = createRitualRunReceipt({
      approved,
      run,
      receiptId: "rcp_01J00000000000000000000001",
      summary:
        "The deterministic fixture completed every approved orchestration step.",
      recordedAt: "2026-08-16T12:00:07.000Z",
    });
    expect(ritualRunReceiptSchema.parse(receipt)).toMatchObject({
      mode: "RUN",
      executionProvider: "LOCAL_RITUAL_V1",
      outcome: "NEEDS_REVIEW",
      externalEffects: [],
    });
    expect(receipt.stepEvidence).toHaveLength(2);
    expect(receipt.stepEvidence[0]?.research?.sources).toHaveLength(1);
    expect(receipt.uncertainties).toContain(
      "Web evidence is untrusted source material and requires owner review.",
    );
    expect(() =>
      validateRitualRunReceipt(run, {
        ...receipt,
        stepEvidence: [...receipt.stepEvidence].reverse(),
      }),
    ).toThrow("RITUAL_RUN_RECEIPT_MISMATCH");

    expect(() =>
      createRitualRun({
        approved,
        request: { ...request, ritualRevision: 2 },
        runId: "rrn_01J00000000000000000000002",
        createdAt: "2026-08-16T12:00:00.000Z",
      }),
    ).toThrow("STALE_RITUAL_RUN");
    expect(() =>
      reduceRitualRun(run, approved, {
        type: "COMPLETE_STEP",
        stepKey: draft.steps[0]!.stepKey,
        occurredAt: "2026-08-16T12:00:06.000Z",
      }),
    ).toThrow("ILLEGAL_RITUAL_RUN_TRANSITION");
    expect(
      ritualRunRequestSchema.safeParse({ ...request, arbitraryTool: "shell" })
        .success,
    ).toBe(false);
  });

  it("keeps pre-research durable Run records parseable", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const modern = createRitualRun({
      approved,
      request: {
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000009",
      createdAt: "2026-08-16T12:00:00.000Z",
    });
    const { waitingReason: _waitingReason, ...withoutWaitingReason } = modern;
    const legacy = {
      ...withoutWaitingReason,
      executionProvider: "DETERMINISTIC_FIXTURE",
      steps: modern.steps.map(({ research: _research, ...step }) => step),
    };

    expect(ritualRunSchema.safeParse(legacy).success).toBe(true);
  });

  it("rejects successful terminal Runs with an incomplete step", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const started = reduceRitualRun(
      createRitualRun({
        approved,
        request: {
          schemaVersion: 1,
          ritualId: approved.ritualId,
          ritualRevision: approved.ritualRevision,
        },
        runId: "rrn_01J00000000000000000000004",
        createdAt: "2026-08-16T12:00:00.000Z",
      }),
      approved,
      { type: "START", occurredAt: "2026-08-16T12:00:01.000Z" },
    );

    expect(
      ritualRunSchema.safeParse({
        ...started,
        revision: started.revision + 1,
        status: "NEEDS_REVIEW",
        currentStepKey: null,
        steps: started.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                status: "COMPLETED",
                completedAt: "2026-08-16T12:00:02.000Z",
              }
            : step,
        ),
        updatedAt: "2026-08-16T12:00:02.000Z",
        completedAt: "2026-08-16T12:00:02.000Z",
      }).success,
    ).toBe(false);
  });

  it("cancels a pending or active Run without executing another step", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const queued = createRitualRun({
      approved,
      request: {
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000003",
      createdAt: "2026-08-16T12:00:00.000Z",
    });
    const canceled = reduceRitualRun(queued, approved, {
      type: "CANCEL",
      occurredAt: "2026-08-16T12:00:01.000Z",
    });
    expect(canceled).toMatchObject({
      status: "CANCELED",
      completedAt: "2026-08-16T12:00:01.000Z",
    });
    expect(canceled.steps.every((step) => step.status === "CANCELED")).toBe(
      true,
    );
  });

  it("turns owner feedback into an exact, reviewable Ritual revision", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const receipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000000",
      runId: "rrn_01J00000000000000000000000",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      mode: "TEST" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "The deadline was identified, but the explanation was too long.",
      evidence: ["The supplied deadline determined the priority."],
      uncertainties: ["The desired response length was not specified."],
      sampleDigest: "a".repeat(64),
      sampleCharacterCount: 42,
      externalEffects: [] as const,
      recordedAt: "2026-08-15T15:02:00.000Z",
    };
    const context = ritualLearningContextSchema.parse({
      schemaVersion: 1,
      proposalId: "rlp_01J00000000000000000000000",
      ritual: approved,
      receipt,
      ownerFeedback: "Keep the result to three concise bullets next time.",
    });
    const proposal = ritualLearningProposalSchema.parse({
      status: "proposal",
      proposalId: context.proposalId,
      ritualId: approved.ritualId,
      fromRevision: 1,
      receiptId: receipt.receiptId,
      ownerFeedback: context.ownerFeedback,
      stewardMessage: "I propose tightening the expected result.",
      rationale: "The owner asked for a shorter, more scannable result.",
      proposedDefinition: {
        name: approved.name,
        purpose: approved.purpose,
        trigger: approved.trigger,
        steps: approved.steps,
        permissions: approved.permissions,
        completion: "Three concise priority bullets are ready for review.",
        reviewPolicy: approved.reviewPolicy,
        research: approved.research,
      },
    });

    expect(validateRitualLearningResult(context, proposal)).toEqual(proposal);
    const removedResearch = {
      ...proposal,
      proposedDefinition: {
        ...proposal.proposedDefinition,
        research: undefined,
      },
    };
    expect(validateRitualLearningResult(context, removedResearch)).toEqual(
      removedResearch,
    );
    const domainContext = ritualLearningContextSchema.parse({
      ...context,
      ritual: {
        ...context.ritual,
        research: {
          ...context.ritual.research!,
          includeDomains: ["example.com", "news.example.com"],
        },
      },
    });
    const narrowedResearch = {
      ...proposal,
      proposedDefinition: {
        ...proposal.proposedDefinition,
        research: {
          ...proposal.proposedDefinition.research!,
          maxResults: 2,
          lookbackDays: 7,
          includeDomains: ["news.example.com"],
        },
      },
    };
    expect(
      validateRitualLearningResult(domainContext, narrowedResearch),
    ).toEqual(narrowedResearch);
    expect(
      validateRitualLearningResult(context, {
        ...proposal,
        receiptId: "rcp_01J00000000000000000000001",
      }),
    ).toMatchObject({ status: "waiting", reason: "STALE_STEWARD_RESULT" });
    expect(
      validateRitualLearningResult(context, {
        ...proposal,
        proposedDefinition: {
          ...proposal.proposedDefinition,
          permissions: [
            ...proposal.proposedDefinition.permissions,
            "Send email without another approval",
          ],
        },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    for (const research of [
      { ...proposal.proposedDefinition.research!, query: "a new query" },
      { ...proposal.proposedDefinition.research!, maxResults: 5 },
      { ...proposal.proposedDefinition.research!, lookbackDays: 31 },
    ]) {
      expect(
        validateRitualLearningResult(context, {
          ...proposal,
          proposedDefinition: { ...proposal.proposedDefinition, research },
        }),
      ).toMatchObject({
        status: "waiting",
        reason: "MALFORMED_PROVIDER_OUTPUT",
      });
    }
    expect(
      validateRitualLearningResult(domainContext, {
        ...narrowedResearch,
        proposedDefinition: {
          ...narrowedResearch.proposedDefinition,
          research: {
            ...narrowedResearch.proposedDefinition.research,
            includeDomains: ["outside.example.com"],
          },
        },
      }),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });

    const approval = ritualLearningApprovalRequestSchema.parse({
      schemaVersion: 1,
      proposalId: proposal.proposalId,
      ritualId: approved.ritualId,
      expectedFromRevision: 1,
      approvedAt: "2026-08-15T15:03:00.000Z",
    });
    expect(
      approveRitualLearningProposal(approved, proposal, approval),
    ).toMatchObject({
      ritualId: approved.ritualId,
      ritualRevision: 2,
      completion: proposal.proposedDefinition.completion,
      learningProposalId: proposal.proposalId,
      basedOnReceiptId: receipt.receiptId,
    });
    expect(() =>
      approveRitualLearningProposal(approved, proposal, {
        ...approval,
        expectedFromRevision: 2,
      }),
    ).toThrow("STALE_RITUAL_LEARNING_PROPOSAL");
  });
});
