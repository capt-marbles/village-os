import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RitualBuilderController } from "../src/main/ritual-builder-controller.js";
import { RitualRepository } from "../src/main/ritual-repository.js";
import { RitualScheduler } from "../src/main/ritual-scheduler.js";

const approved = {
  schemaVersion: 1 as const,
  ritualId: "rtl_01J00000000000000000000000",
  ritualRevision: 1,
  status: "APPROVED" as const,
  approvedDraftId: "rtd_01J00000000000000000000000",
  approvedDraftRevision: 1,
  name: "Morning review",
  purpose: "Prepare a bounded morning review.",
  trigger: { kind: "SCHEDULED" as const, summary: "Every day at 6:00 AM" },
  steps: [
    {
      stepKey: "prepare-review",
      title: "Prepare the review",
      description: "Prepare the approved bounded review.",
      actor: { kind: "STEWARD" as const, role: "Steward" },
      approval: "OWNER_REQUIRED" as const,
    },
  ],
  permissions: ["Read only approved sources"],
  completion: "A reviewable result is ready.",
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  approvedAt: "2026-08-16T20:00:00.000Z",
};

function provider() {
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

describe("scheduled Ritual integration", () => {
  it("recovers a crash after Run persistence without creating another Run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-scheduler-"));
    const repository = new RitualRepository(join(directory, "rituals.json"));
    await repository.save(approved);
    await repository.saveSchedule({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: 1,
      state: "ENABLED",
      cadence: "DAILY",
      localTime: "06:00",
      timeZone: "America/Chicago",
      nextRunAt: "2026-08-17T11:00:00.000Z",
      pendingOccurrence: null,
      lastTriggeredAt: null,
      updatedAt: "2026-08-16T20:00:00.000Z",
    });
    const controller = new RitualBuilderController(provider(), repository, {
      now: () => "2026-08-17T11:00:01.000Z",
    });
    const firstScheduler = new RitualScheduler(
      {
        listSchedules: () => repository.listSchedules(),
        claimScheduleOccurrence: (candidate) =>
          repository.claimScheduleOccurrence(candidate),
        acknowledgeScheduleOccurrence: async () => {
          throw new Error("PROCESS_STOPPED_BEFORE_ACK");
        },
      },
      controller,
      {
        now: () => "2026-08-17T11:00:01.000Z",
        createRunId: () => "rrn_01J00000000000000000000020",
      },
    );

    await expect(firstScheduler.tick()).rejects.toThrow(
      "PROCESS_STOPPED_BEFORE_ACK",
    );
    expect(await repository.listInbox()).toHaveLength(1);
    expect(
      (await repository.listSchedules())[0]?.pendingOccurrence?.runId,
    ).toBe("rrn_01J00000000000000000000020");

    const restartedController = new RitualBuilderController(
      provider(),
      new RitualRepository(join(directory, "rituals.json")),
      { now: () => "2026-08-17T11:01:00.000Z" },
    );
    const restartedRepository = new RitualRepository(
      join(directory, "rituals.json"),
    );
    const restartedScheduler = new RitualScheduler(
      restartedRepository,
      restartedController,
      { now: () => "2026-08-17T11:01:00.000Z" },
    );
    await restartedScheduler.tick();
    await restartedScheduler.tick();

    expect(await restartedRepository.listInbox()).toHaveLength(1);
    expect(
      (await restartedRepository.listSchedules())[0]?.pendingOccurrence,
    ).toBeNull();
    await controller.close();
    await restartedController.close();
  });
});
