import {
  createRitualRun,
  reduceRitualRun,
  type ApprovedRitualRevision,
} from "@village/contracts";
import { describe, expect, it, vi } from "vitest";
import { LocalRitualRunExecutor } from "../src/main/ritual-run-executor.js";

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

    await expect(
      new LocalRitualRunExecutor({
        research: { search },
        now: () => "2026-08-16T12:00:00.000Z",
      }).completeCurrentStep({ approved: researchApproved, run }),
    ).resolves.toMatchObject({
      status: "completed",
      stepKey: "collect-signals",
      research: { provider: "EXA", requestId: "exa-run-1" },
      externalEffects: [],
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
      externalEffects: [],
    });
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
    const executor = new LocalRitualRunExecutor({ research: { search } });

    const first = await executor.completeCurrentStep({
      approved: researchApproved,
      run,
    });
    expect(first.status).toBe("completed");
    if (first.status !== "completed") throw new Error("expected completion");
    expect(first.research?.sources).toHaveLength(5);
    expect(first.research?.sources[0]?.title).toHaveLength(160);
    expect(first.research?.sources[0]?.author).toHaveLength(100);
    expect(first.research?.sources[0]?.highlights).toEqual(["h".repeat(500)]);
    run = reduceRitualRun(run, researchApproved, {
      type: "COMPLETE_STEP",
      stepKey: first.stepKey,
      research: first.research ?? undefined,
      occurredAt: "2026-08-16T12:00:03.000Z",
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
