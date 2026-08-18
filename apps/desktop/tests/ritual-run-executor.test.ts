import {
  createRitualRun,
  reduceRitualRun,
  type ApprovedRitualRevision,
} from "@village/contracts";
import { describe, expect, it, vi } from "vitest";
import { LocalRitualRunExecutor } from "../src/main/ritual-run-executor.js";

const synthesis = {
  synthesizeResearch: async (context: {
    sources: readonly { sourceNumber: number }[];
  }) => ({
    status: "report" as const,
    report: {
      headline: "Recent signals are ready for review",
      summary: "The supplied evidence supports a bounded brief.",
      findings: [{ claim: "One cited finding.", sourceNumbers: [1] }],
      uncertainties: [],
      availableSourceCount: context.sources.length,
    },
  }),
};

const approved: ApprovedRitualRevision = {
  schemaVersion: 1,
  ritualId: "rtl_01J00000000000000000000000",
  ritualRevision: 1,
  status: "APPROVED",
  approvedDraftId: "rtd_01J00000000000000000000000",
  approvedDraftRevision: 1,
  name: "Signals review",
  purpose: "Review recent signals and prepare a concise brief.",
  trigger: { kind: "ON_DEMAND", summary: "Whenever I ask" },
  steps: [
    {
      stepKey: "collect-signals",
      title: "Collect signals",
      description: "Collect bounded fixture signals for the proof.",
      actor: { kind: "STEWARD", role: "Steward" },
      approval: "NONE",
    },
  ],
  permissions: [],
  completion: "A reviewable brief is ready.",
  reviewPolicy: { ownerReview: "EVERY_RUN", learning: "PROPOSE_ONLY" },
  approvedAt: "2026-08-16T12:00:00.000Z",
};

describe("LocalRitualRunExecutor", () => {
  it("completes only the current approved step without effects", async () => {
    let run = createRitualRun({
      approved,
      request: {
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000000",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });

    await expect(
      new LocalRitualRunExecutor().completeCurrentStep({
        approved,
        run,
      }),
    ).resolves.toEqual({
      status: "completed",
      stepKey: "collect-signals",
      externalEffects: [],
      research: null,
    });
  });

  it("rejects stale, gated, or non-running work", async () => {
    const queued = createRitualRun({
      approved,
      request: {
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000001",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    const executor = new LocalRitualRunExecutor();
    await expect(
      executor.completeCurrentStep({ approved, run: queued }),
    ).rejects.toThrow("RITUAL_RUN_NOT_EXECUTABLE");
    await expect(
      executor.completeCurrentStep({
        approved: {
          ...approved,
          ritualId: "rtl_01J00000000000000000000001",
        },
        run: reduceRitualRun(queued, approved, {
          type: "START",
          occurredAt: "2026-08-16T12:00:02.000Z",
        }),
      }),
    ).rejects.toThrow("STALE_RITUAL_RUN");
  });

  it("executes the exact approved Exa resource and returns bounded evidence", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      research: {
        provider: "EXA",
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 30,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000002",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const search = vi.fn(async () => ({
      status: "result" as const,
      provider: "EXA" as const,
      requestId: "exa-run-1",
      sources: [
        {
          title: "Agent announcement",
          url: "https://example.com/announcement",
          publishedAt: "2026-08-15T00:00:00.000Z",
          author: null,
          highlights: ["Untrusted public evidence."],
          taint: "UNTRUSTED_WEB" as const,
        },
      ],
    }));

    const executor = new LocalRitualRunExecutor({
      research: { search },
      synthesis,
      now: () => "2026-08-16T12:00:00.000Z",
    });
    const checkpoint = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    expect(checkpoint).toMatchObject({
      status: "checkpointed",
      stepKey: "collect-signals",
      research: { provider: "EXA", requestId: "exa-run-1" },
      externalEffects: [],
    });
    if (checkpoint.status !== "checkpointed")
      throw new Error("expected checkpoint");
    run = reduceRitualRun(run, researchApproved, {
      type: "CHECKPOINT_RESEARCH",
      stepKey: checkpoint.stepKey,
      research: checkpoint.research,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    await expect(
      executor.completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toMatchObject({
      status: "completed",
      report: { availableSourceCount: 1 },
    });
    expect(search).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        query: researchApproved.research?.query,
        maxResults: 3,
        publishedAfter: "2026-07-17T12:00:00.000Z",
      },
      {},
    );
  });

  it("waits without completing the step when Exa needs owner recovery", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      research: {
        provider: "EXA",
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 7,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000003",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });

    await expect(
      new LocalRitualRunExecutor({
        research: {
          search: async () => ({
            status: "waiting",
            provider: "EXA",
            reason: "AUTHENTICATION_REQUIRED",
          }),
        },
      }).completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toEqual({
      status: "waiting",
      stepKey: "collect-signals",
      reason: "AUTHENTICATION_REQUIRED",
      source: "RESEARCH",
      externalEffects: [],
    });
  });

  it("creates a bounded metadata-only inbox priority report without mail effects", async () => {
    const gmailApproved: ApprovedRitualRevision = {
      ...approved,
      name: "Inbox priority review",
      gmailReview: {
        provider: "GMAIL",
        scope: "https://www.googleapis.com/auth/gmail.metadata",
        maxMessages: 25,
        lookbackDays: 3,
        unreadOnly: true,
      },
    };
    let run = createRitualRun({
      approved: gmailApproved,
      request: {
        schemaVersion: 1,
        ritualId: gmailApproved.ritualId,
        ritualRevision: gmailApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000007",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, gmailApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const review = vi.fn(async () => ({
      status: "result" as const,
      provider: "GMAIL" as const,
      messages: [
        {
          messageNumber: 1,
          from: "Customer <customer@example.com>",
          subject: "Urgent: approval needed at www. ",
          receivedAt: "2026-08-16T11:30:00.000Z",
          unread: true,
          labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
          taint: "UNTRUSTED_GMAIL_METADATA" as const,
        },
        {
          messageNumber: 2,
          from: "Newsletter <noreply@example.com>",
          subject: "Weekly digest",
          receivedAt: "2026-08-16T10:00:00.000Z",
          unread: true,
          labelIds: ["INBOX", "UNREAD"],
          taint: "UNTRUSTED_GMAIL_METADATA" as const,
        },
      ],
    }));

    await expect(
      new LocalRitualRunExecutor({ gmail: { review } }).completeCurrentStep({
        approved: gmailApproved,
        run,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      stepKey: "collect-signals",
      externalEffects: [],
      research: null,
      mailReport: {
        metadataOnly: true,
        reviewedMessageCount: 2,
        priorities: [
          {
            messageNumber: 1,
            from: "Customer <customer@example.com>",
            subject: "Urgent: approval needed at [link removed]",
            priority: "HIGH",
          },
        ],
      },
    });
    expect(review).toHaveBeenCalledWith(
      { schemaVersion: 1, ...gmailApproved.gmailReview },
      {},
    );
  });

  it("waits for Gmail authentication without completing or mutating mail", async () => {
    const gmailApproved: ApprovedRitualRevision = {
      ...approved,
      gmailReview: {
        provider: "GMAIL",
        scope: "https://www.googleapis.com/auth/gmail.metadata",
        maxMessages: 25,
        lookbackDays: 3,
        unreadOnly: true,
      },
    };
    let run = createRitualRun({
      approved: gmailApproved,
      request: {
        schemaVersion: 1,
        ritualId: gmailApproved.ritualId,
        ritualRevision: gmailApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000008",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, gmailApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });

    await expect(
      new LocalRitualRunExecutor({
        gmail: {
          review: async () => ({
            status: "waiting",
            provider: "GMAIL",
            reason: "AUTHENTICATION_REQUIRED",
          }),
        },
      }).completeCurrentStep({ approved: gmailApproved, run }),
    ).resolves.toEqual({
      status: "waiting",
      stepKey: "collect-signals",
      reason: "AUTHENTICATION_REQUIRED",
      source: "GMAIL",
      externalEffects: [],
    });
  });

  it("retries synthesis from checkpointed evidence without repeating Exa", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      research: {
        provider: "EXA",
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 7,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000006",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const search = vi.fn(async () => ({
      status: "result" as const,
      provider: "EXA" as const,
      requestId: "exa-checkpointed",
      sources: [
        {
          title: "Checkpointed source",
          url: "https://example.com/checkpointed",
          publishedAt: null,
          author: null,
          highlights: ["Bounded evidence."],
          taint: "UNTRUSTED_WEB" as const,
        },
      ],
    }));
    const synthesizeResearch = vi
      .fn()
      .mockResolvedValueOnce({
        status: "waiting",
        reason: "PROVIDER_UNAVAILABLE",
      })
      .mockResolvedValueOnce({
        status: "report",
        report: {
          headline: "Checkpointed evidence was synthesized",
          summary: "The retry used the retained evidence.",
          findings: [{ claim: "One cited finding.", sourceNumbers: [1] }],
          uncertainties: [],
          availableSourceCount: 1,
        },
      });
    const executor = new LocalRitualRunExecutor({
      research: { search },
      synthesis: { synthesizeResearch },
    });

    const checkpoint = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    expect(checkpoint).toMatchObject({
      status: "checkpointed",
      research: { requestId: "exa-checkpointed" },
    });
    if (checkpoint.status !== "checkpointed")
      throw new Error("expected checkpoint");
    run = reduceRitualRun(run, researchApproved, {
      type: "CHECKPOINT_RESEARCH",
      stepKey: checkpoint.stepKey,
      research: checkpoint.research,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    const waiting = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    expect(waiting).toMatchObject({
      status: "waiting",
      reason: "PROVIDER_UNAVAILABLE",
      source: "STEWARD",
      research: { requestId: "exa-checkpointed" },
    });
    if (waiting.status !== "waiting") throw new Error("expected wait");
    run = reduceRitualRun(run, researchApproved, {
      type: "WAIT_FOR_RESOURCE",
      reason: waiting.reason,
      source: waiting.source,
      research: waiting.research,
      occurredAt: "2026-08-16T12:00:04.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "RETRY_RESOURCE",
      occurredAt: "2026-08-16T12:00:05.000Z",
    });

    await expect(
      executor.completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toMatchObject({
      status: "completed",
      report: { availableSourceCount: 1 },
    });
    expect(search).toHaveBeenCalledOnce();
    expect(synthesizeResearch).toHaveBeenCalledTimes(2);
  });

  it("does not create research work for an already-aborted Run", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      research: {
        provider: "EXA",
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 7,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000005",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const search = vi.fn(async () => ({
      status: "waiting" as const,
      provider: "EXA" as const,
      reason: "PROVIDER_UNAVAILABLE" as const,
    }));
    const cancellation = new AbortController();
    cancellation.abort();

    await expect(
      new LocalRitualRunExecutor({
        research: { search },
      }).completeCurrentStep({
        approved: researchApproved,
        run,
        signal: cancellation.signal,
      }),
    ).rejects.toThrow("RITUAL_RUN_CANCELED");
    expect(search).not.toHaveBeenCalled();
  });

  it("checkpoints a successful search before requiring the Steward", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      research: {
        provider: "EXA",
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 7,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000008",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const search = vi.fn(async () => ({
      status: "result" as const,
      provider: "EXA" as const,
      requestId: "exa-before-steward",
      sources: [
        {
          title: "Checkpointed source",
          url: "https://example.com/checkpointed",
          publishedAt: null,
          author: null,
          highlights: ["Bounded evidence."],
          taint: "UNTRUSTED_WEB" as const,
        },
      ],
    }));
    const executor = new LocalRitualRunExecutor({ research: { search } });
    const checkpoint = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    if (checkpoint.status !== "checkpointed")
      throw new Error("expected checkpoint");
    run = reduceRitualRun(run, researchApproved, {
      type: "CHECKPOINT_RESEARCH",
      stepKey: checkpoint.stepKey,
      research: checkpoint.research,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });

    await expect(
      executor.completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toMatchObject({
      status: "waiting",
      source: "STEWARD",
      reason: "PROVIDER_UNAVAILABLE",
      research: { requestId: "exa-before-steward" },
    });
    expect(search).toHaveBeenCalledOnce();
  });

  it("completes an empty Exa result without charging for a retry", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      research: {
        provider: "EXA",
        query: "very narrow recent topic",
        maxResults: 3,
        lookbackDays: 7,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000009",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const search = vi.fn(async () => ({
      status: "result" as const,
      provider: "EXA" as const,
      requestId: "exa-empty",
      sources: [],
    }));
    const executor = new LocalRitualRunExecutor({
      research: { search },
      synthesis,
    });
    const checkpoint = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    if (checkpoint.status !== "checkpointed")
      throw new Error("expected checkpoint");
    run = reduceRitualRun(run, researchApproved, {
      type: "CHECKPOINT_RESEARCH",
      stepKey: checkpoint.stepKey,
      research: checkpoint.research,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });

    await expect(
      executor.completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toMatchObject({
      status: "completed",
      research: { requestId: "exa-empty", sources: [] },
      report: null,
    });
    expect(search).toHaveBeenCalledOnce();
  });

  it("sanitizes persisted evidence and searches only once across two steps", async () => {
    const researchApproved: ApprovedRitualRevision = {
      ...approved,
      steps: [
        approved.steps[0]!,
        {
          ...approved.steps[0]!,
          stepKey: "summarize-signals",
          title: "Summarize signals",
        },
      ],
      research: {
        provider: "EXA",
        query: "important AI agent announcements",
        maxResults: 5,
        lookbackDays: 7,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000004",
      createdAt: "2026-08-16T12:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    const search = vi.fn(async () => ({
      status: "result" as const,
      provider: "EXA" as const,
      requestId: "exa-run-bounded",
      sources: Array.from({ length: 6 }, (_, index) => ({
        title: `Source ${index} ${"t".repeat(200)}`,
        url: `https://example.com/source-${index}`,
        publishedAt: null,
        author: `Author ${"a".repeat(120)}`,
        highlights: ["h".repeat(700), "discarded highlight"],
        taint: "UNTRUSTED_WEB" as const,
      })),
    }));
    const executor = new LocalRitualRunExecutor({
      research: { search },
      synthesis,
    });

    const first = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    expect(first.status).toBe("checkpointed");
    if (first.status !== "checkpointed") throw new Error("expected checkpoint");
    expect(first.research.sources).toHaveLength(5);
    expect(first.research.sources[0]?.title).toHaveLength(160);
    expect(first.research.sources[0]?.author).toHaveLength(100);
    expect(first.research.sources[0]?.highlights).toEqual(["h".repeat(500)]);
    run = reduceRitualRun(run, researchApproved, {
      type: "CHECKPOINT_RESEARCH",
      stepKey: first.stepKey,
      research: first.research,
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    const completed = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    if (completed.status !== "completed")
      throw new Error("expected completion");
    run = reduceRitualRun(run, researchApproved, {
      type: "COMPLETE_STEP",
      stepKey: completed.stepKey,
      research: completed.research ?? undefined,
      report: completed.report ?? undefined,
      occurredAt: "2026-08-16T12:00:04.000Z",
    });

    await expect(
      executor.completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toMatchObject({
      status: "completed",
      stepKey: "summarize-signals",
      research: null,
    });
    expect(search).toHaveBeenCalledOnce();
  });
});
