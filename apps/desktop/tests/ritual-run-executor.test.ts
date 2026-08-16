import {
  createRitualRun,
  reduceRitualRun,
  type ApprovedRitualRevision,
} from "@village/contracts";
import { describe, expect, it } from "vitest";
import { DeterministicRitualRunExecutor } from "../src/main/ritual-run-executor.js";

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

describe("DeterministicRitualRunExecutor", () => {
  it("completes only the current fixture step without effects", async () => {
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
      new DeterministicRitualRunExecutor().completeCurrentStep({
        approved,
        run,
      }),
    ).resolves.toEqual({
      stepKey: "collect-signals",
      externalEffects: [],
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
    const executor = new DeterministicRitualRunExecutor();
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
});
