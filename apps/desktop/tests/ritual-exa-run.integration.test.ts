import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedRitualRevision } from "@village/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RitualBuilderController } from "../src/main/ritual-builder-controller.js";
import { RitualRepository } from "../src/main/ritual-repository.js";
import { LocalRitualRunExecutor } from "../src/main/ritual-run-executor.js";
import { ExaSearchProvider } from "../src/research/exa-search-provider.js";

const approved: ApprovedRitualRevision = {
  schemaVersion: 1,
  ritualId: "rtl_01J00000000000000000000010",
  ritualRevision: 1,
  status: "APPROVED",
  approvedDraftId: "rtd_01J00000000000000000000010",
  approvedDraftRevision: 1,
  name: "Recent agent signals",
  purpose: "Prepare a reviewable brief of recent agent announcements.",
  trigger: { kind: "ON_DEMAND", summary: "Whenever I ask" },
  steps: [
    {
      stepKey: "collect-signals",
      title: "Collect recent signals",
      description: "Search the approved public-web resource.",
      actor: { kind: "STEWARD", role: "Steward" },
      approval: "NONE",
    },
  ],
  permissions: ["Read bounded public-web evidence with Exa"],
  completion: "A source-linked brief is ready for review.",
  reviewPolicy: { ownerReview: "EVERY_RUN", learning: "PROPOSE_ONLY" },
  research: {
    provider: "EXA",
    query: "important AI agent announcements",
    maxResults: 3,
    lookbackDays: 30,
  },
  approvedAt: "2026-08-16T12:00:00.000Z",
};

describe("approved Ritual Exa execution", () => {
  it("runs the exact approved query through Exa and restores its source Receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-ritual-exa-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: approved.research?.query,
        numResults: 3,
        startPublishedDate: "2026-07-17T12:00:00.000Z",
      });
      return Response.json({
        requestId: "exa-integrated-run",
        results: [
          {
            title: "Agent launch",
            url: "https://example.com/agent-launch?tracking=removed",
            publishedDate: "2026-08-15",
            author: "Example author",
            highlights: ["A bounded public excerpt."],
          },
        ],
      });
    });
    const provider = new ExaSearchProvider({
      credentials: {
        withApiKey: async (use) =>
          use(new TextEncoder().encode("exa-test-secret")),
      },
      fetch,
    });
    const controller = new RitualBuilderController(
      {
        draft: async () => {
          throw new Error("not used");
        },
        testRun: async () => {
          throw new Error("not used");
        },
        learn: async () => {
          throw new Error("not used");
        },
        close: async () => undefined,
      },
      repository,
      {
        createId: (prefix) =>
          prefix === "rrn"
            ? "rrn_01J00000000000000000000010"
            : "rcp_01J00000000000000000000010",
        now: () => "2026-08-16T12:00:00.000Z",
        runExecutor: new LocalRitualRunExecutor({
          research: provider,
          now: () => "2026-08-16T12:00:00.000Z",
        }),
      },
    );

    await expect(
      controller.startRun({
        schemaVersion: 1,
        ritualId: approved.ritualId,
        ritualRevision: approved.ritualRevision,
      }),
    ).resolves.toMatchObject({
      status: "receipt",
      run: { status: "NEEDS_REVIEW" },
      receipt: {
        executionProvider: "LOCAL_RITUAL_V1",
        stepEvidence: [
          {
            research: {
              provider: "EXA",
              requestId: "exa-integrated-run",
              sources: [
                {
                  title: "Agent launch",
                  url: "https://example.com/agent-launch",
                  taint: "UNTRUSTED_WEB",
                },
              ],
            },
          },
        ],
      },
    });
    await expect(repository.latestSnapshot()).resolves.toMatchObject({
      run: { status: "NEEDS_REVIEW" },
      runReceipt: { receiptId: "rcp_01J00000000000000000000010" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries the same durable waiting Run after restart and persists sanitized evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-ritual-exa-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "rituals.json");
    const repository = new RitualRepository(path);
    await repository.save(approved);
    const steward = {
      draft: async () => {
        throw new Error("not used");
      },
      testRun: async () => {
        throw new Error("not used");
      },
      learn: async () => {
        throw new Error("not used");
      },
      close: async () => undefined,
    };
    const request = {
      schemaVersion: 1 as const,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
    };
    const waiting = new RitualBuilderController(steward, repository, {
      createId: (prefix) =>
        prefix === "rrn"
          ? "rrn_01J00000000000000000000011"
          : "rcp_01J00000000000000000000011",
      now: () => "2026-08-16T12:00:00.000Z",
      runExecutor: new LocalRitualRunExecutor({
        research: {
          search: async () => ({
            status: "waiting",
            provider: "EXA",
            reason: "AUTHENTICATION_REQUIRED",
          }),
        },
      }),
    });

    await expect(waiting.startRun(request)).resolves.toMatchObject({
      status: "run",
      run: {
        runId: "rrn_01J00000000000000000000011",
        status: "WAITING_FOR_RESOURCE",
      },
    });

    const search = vi.fn(async () => ({
      status: "result" as const,
      provider: "EXA" as const,
      requestId: "exa-after-restart",
      sources: Array.from({ length: 6 }, (_, index) => ({
        title: `Source ${index} ${"t".repeat(200)}`,
        url: `https://example.com/${index}`,
        publishedAt: null,
        author: null,
        highlights: ["h".repeat(700), "discarded"],
        taint: "UNTRUSTED_WEB" as const,
      })),
    }));
    const restarted = new RitualBuilderController(
      steward,
      new RitualRepository(path),
      {
        createId: (prefix) =>
          prefix === "rrn"
            ? "rrn_01J00000000000000000000012"
            : "rcp_01J00000000000000000000012",
        now: () => "2026-08-16T12:01:00.000Z",
        runExecutor: new LocalRitualRunExecutor({ research: { search } }),
      },
    );

    await expect(restarted.startRun(request)).resolves.toMatchObject({
      status: "receipt",
      run: {
        runId: "rrn_01J00000000000000000000011",
        status: "NEEDS_REVIEW",
      },
      receipt: {
        stepEvidence: [
          {
            research: {
              requestId: "exa-after-restart",
            },
          },
        ],
      },
    });
    const restored = await new RitualRepository(path).latestSnapshot();
    expect(restored.run?.runId).toBe("rrn_01J00000000000000000000011");
    expect(restored.run?.steps[0]?.research?.sources).toHaveLength(5);
    expect(restored.run?.steps[0]?.research?.sources[0]?.highlights).toEqual([
      "h".repeat(500),
    ]);
    expect(search).toHaveBeenCalledOnce();
  });
});
