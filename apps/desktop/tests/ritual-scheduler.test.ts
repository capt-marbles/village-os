import type {
  RitualRunControllerResult,
  RitualSchedule,
} from "@village/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RitualScheduler,
  nextRitualOccurrence,
} from "../src/main/ritual-scheduler.js";

const schedule: RitualSchedule = {
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
};

const runResult = {
  status: "run",
  run: {
    schemaVersion: 1,
    runId: "rrn_01J00000000000000000000020",
  },
} as unknown as RitualRunControllerResult;

describe("RitualScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("calculates daily and weekday occurrences in the owner's timezone", () => {
    expect(nextRitualOccurrence(schedule, "2026-08-16T22:00:00.000Z")).toBe(
      "2026-08-17T11:00:00.000Z",
    );
    expect(
      nextRitualOccurrence(
        { ...schedule, cadence: "WEEKDAYS" },
        "2026-08-21T12:00:00.000Z",
      ),
    ).toBe("2026-08-24T11:00:00.000Z");
    expect(
      nextRitualOccurrence(
        {
          ...schedule,
          localTime: "02:30",
          timeZone: "America/Chicago",
        },
        "2026-03-08T06:00:00.000Z",
      ),
    ).toBe("2026-03-09T07:30:00.000Z");
  });

  it("claims a due occurrence before starting its preallocated Run", async () => {
    const claimed = {
      ...schedule,
      nextRunAt: "2026-08-18T11:00:00.000Z",
      pendingOccurrence: {
        runId: "rrn_01J00000000000000000000020" as const,
        dueAt: schedule.nextRunAt,
      },
    };
    const repository = {
      listSchedules: vi.fn(async () => [schedule]),
      claimScheduleOccurrence: vi.fn(async () => claimed),
      acknowledgeScheduleOccurrence: vi.fn(async () => undefined),
    };
    const controller = {
      startScheduledRun: vi.fn(async () => runResult),
    };
    const scheduler = new RitualScheduler(repository, controller, {
      now: () => "2026-08-17T11:00:01.000Z",
      createRunId: () => "rrn_01J00000000000000000000020",
    });

    await scheduler.tick();

    expect(repository.claimScheduleOccurrence).toHaveBeenCalledWith({
      ritualId: schedule.ritualId,
      ritualRevision: 1,
      expectedDueAt: schedule.nextRunAt,
      runId: "rrn_01J00000000000000000000020",
      nextRunAt: "2026-08-18T11:00:00.000Z",
      claimedAt: "2026-08-17T11:00:01.000Z",
    });
    expect(controller.startScheduledRun).toHaveBeenCalledWith({
      schemaVersion: 1,
      ritualId: schedule.ritualId,
      ritualRevision: 1,
      runId: "rrn_01J00000000000000000000020",
      dueAt: schedule.nextRunAt,
    });
    expect(repository.acknowledgeScheduleOccurrence).toHaveBeenCalledWith(
      "rrn_01J00000000000000000000020",
      "2026-08-17T11:00:01.000Z",
    );
  });

  it("replays the same pending occurrence after restart and retains it on failure", async () => {
    const pending = {
      ...schedule,
      pendingOccurrence: {
        runId: "rrn_01J00000000000000000000020" as const,
        dueAt: schedule.nextRunAt,
      },
    };
    const repository = {
      listSchedules: vi.fn(async () => [pending]),
      claimScheduleOccurrence: vi.fn(),
      acknowledgeScheduleOccurrence: vi.fn(async () => undefined),
    };
    const controller = {
      startScheduledRun: vi.fn(async () => {
        throw new Error("EXECUTOR_UNAVAILABLE");
      }),
    };
    const scheduler = new RitualScheduler(repository, controller, {
      now: () => "2026-08-17T11:01:00.000Z",
      createRunId: () => "rrn_01J00000000000000000000021",
    });

    await expect(scheduler.tick()).rejects.toThrow("EXECUTOR_UNAVAILABLE");
    expect(repository.claimScheduleOccurrence).not.toHaveBeenCalled();
    expect(controller.startScheduledRun).toHaveBeenCalledWith({
      schemaVersion: 1,
      ritualId: schedule.ritualId,
      ritualRevision: 1,
      runId: pending.pendingOccurrence.runId,
      dueAt: pending.pendingOccurrence.dueAt,
    });
    expect(repository.acknowledgeScheduleOccurrence).not.toHaveBeenCalled();
  });

  it("sleeps until the next occurrence instead of polling the store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-16T10:00:00.000Z");
    const repository = {
      listSchedules: vi.fn(async () => [schedule]),
      claimScheduleOccurrence: vi.fn(),
      acknowledgeScheduleOccurrence: vi.fn(),
    };
    const scheduler = new RitualScheduler(repository, {
      startScheduledRun: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.listSchedules).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.listSchedules).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("backs off repeated transient failures", async () => {
    vi.useFakeTimers();
    const repository = {
      listSchedules: vi.fn(async () => {
        throw new Error("TEMPORARY_READ_FAILURE");
      }),
      claimScheduleOccurrence: vi.fn(),
      acknowledgeScheduleOccurrence: vi.fn(),
    };
    const scheduler = new RitualScheduler(repository, {
      startScheduledRun: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.listSchedules).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.listSchedules).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.listSchedules).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.listSchedules).toHaveBeenCalledTimes(3);
    await scheduler.close();
  });

  it("does not start a Run when another tick wins the durable claim", async () => {
    const repository = {
      listSchedules: vi.fn(async () => [schedule]),
      claimScheduleOccurrence: vi.fn(async () => null),
      acknowledgeScheduleOccurrence: vi.fn(),
    };
    const controller = { startScheduledRun: vi.fn() };
    const scheduler = new RitualScheduler(repository, controller, {
      now: () => "2026-08-17T11:00:01.000Z",
    });

    await scheduler.tick();

    expect(controller.startScheduledRun).not.toHaveBeenCalled();
    expect(repository.acknowledgeScheduleOccurrence).not.toHaveBeenCalled();
  });

  it("continues other due schedules when one pending occurrence fails", async () => {
    const pending = {
      ...schedule,
      pendingOccurrence: {
        runId: "rrn_01J00000000000000000000020" as const,
        dueAt: schedule.nextRunAt,
      },
    };
    const second = {
      ...schedule,
      ritualId: "rtl_01J00000000000000000000001" as const,
      nextRunAt: "2026-08-17T11:00:01.000Z",
    };
    const claimedSecond = {
      ...second,
      pendingOccurrence: {
        runId: "rrn_01J00000000000000000000021" as const,
        dueAt: second.nextRunAt,
      },
    };
    const repository = {
      listSchedules: vi.fn(async () => [pending, second]),
      claimScheduleOccurrence: vi.fn(async () => claimedSecond),
      acknowledgeScheduleOccurrence: vi.fn(async () => undefined),
    };
    const controller = {
      startScheduledRun: vi
        .fn()
        .mockRejectedValueOnce(new Error("TEMPORARY_FAILURE"))
        .mockResolvedValueOnce(runResult),
    };
    const scheduler = new RitualScheduler(repository, controller, {
      now: () => "2026-08-17T11:00:02.000Z",
      createRunId: () => "rrn_01J00000000000000000000021",
    });

    await expect(scheduler.tick()).rejects.toThrow("TEMPORARY_FAILURE");

    expect(controller.startScheduledRun).toHaveBeenCalledTimes(2);
    expect(repository.acknowledgeScheduleOccurrence).toHaveBeenCalledWith(
      claimedSecond.pendingOccurrence.runId,
      "2026-08-17T11:00:02.000Z",
    );
  });
});
