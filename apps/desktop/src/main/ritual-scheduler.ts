import {
  ritualScheduledRunRequestSchema,
  type RitualRun,
  type RitualRunControllerResult,
  type RitualSchedule,
} from "@village/contracts";
import { createVillageId } from "./local-village-id.js";

export interface RitualSchedulePersistence {
  listSchedules(): Promise<readonly RitualSchedule[]>;
  claimScheduleOccurrence(candidate: {
    ritualId: RitualSchedule["ritualId"];
    ritualRevision: number;
    expectedDueAt: string;
    runId: RitualRun["runId"];
    nextRunAt: string;
    claimedAt: string;
  }): Promise<RitualSchedule | null>;
  acknowledgeScheduleOccurrence(
    runId: RitualRun["runId"],
    acknowledgedAt: string,
  ): Promise<void>;
}

export interface ScheduledRitualController {
  startScheduledRun(candidate: unknown): Promise<RitualRunControllerResult>;
}

interface RitualSchedulerDependencies {
  now(): string;
  createRunId(): RitualRun["runId"];
  retryMilliseconds: number;
  maximumSleepMilliseconds: number;
}

export class RitualScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;
  private failureCount = 0;
  private schedulingGeneration = 0;
  private readonly dependencies: RitualSchedulerDependencies;

  constructor(
    private readonly repository: RitualSchedulePersistence,
    private readonly controller: ScheduledRitualController,
    dependencies: Partial<RitualSchedulerDependencies> = {},
  ) {
    this.dependencies = {
      now: dependencies.now ?? (() => new Date().toISOString()),
      createRunId: dependencies.createRunId ?? (() => createVillageId("rrn")),
      retryMilliseconds: dependencies.retryMilliseconds ?? 30_000,
      maximumSleepMilliseconds:
        dependencies.maximumSleepMilliseconds ?? 6 * 60 * 60_000,
    };
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.wake();
  }

  wake(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.failureCount = 0;
    const generation = ++this.schedulingGeneration;
    void this.runAndScheduleNext(generation);
  }

  tick(): Promise<void> {
    const result = this.operationTail.then(
      () => this.tickExclusive(),
      () => this.tickExclusive(),
    );
    this.operationTail = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.operationTail;
  }

  private async runAndScheduleNext(generation: number): Promise<void> {
    let delay = this.dependencies.maximumSleepMilliseconds;
    try {
      await this.tick();
      this.failureCount = 0;
      const schedules = await this.repository.listSchedules();
      const now = Date.parse(this.dependencies.now());
      const next = schedules
        .filter((schedule) => schedule.state === "ENABLED")
        .map((schedule) => Date.parse(schedule.nextRunAt))
        .filter(Number.isFinite)
        .sort((left, right) => left - right)[0];
      if (next !== undefined) {
        delay = Math.max(
          0,
          Math.min(next - now, this.dependencies.maximumSleepMilliseconds),
        );
      }
    } catch {
      // A durable pending occurrence remains available for the next bounded
      // attempt. The UI surfaces the resulting Run or resource wait.
      this.failureCount += 1;
      delay = Math.min(
        this.dependencies.retryMilliseconds * 2 ** (this.failureCount - 1),
        this.dependencies.maximumSleepMilliseconds,
      );
    }
    if (this.closed || generation !== this.schedulingGeneration) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runAndScheduleNext(generation);
    }, delay);
  }

  private async tickExclusive(): Promise<void> {
    if (this.closed) return;
    const now = this.dependencies.now();
    const schedules = await this.repository.listSchedules();
    const pending = schedules.filter(
      (entry) => entry.state === "ENABLED" && entry.pendingOccurrence,
    );
    const due = schedules
      .filter(
        (entry) =>
          entry.state === "ENABLED" &&
          !entry.pendingOccurrence &&
          Date.parse(entry.nextRunAt) <= Date.parse(now),
      )
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
    let firstFailure: unknown;
    for (const schedule of [...pending, ...due]) {
      try {
        await this.processSchedule(schedule, now);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "STALE_RITUAL_SCHEDULED_RUN" &&
          schedule.pendingOccurrence
        ) {
          await this.repository.acknowledgeScheduleOccurrence(
            schedule.pendingOccurrence.runId,
            now,
          );
          continue;
        }
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
  }

  private async processSchedule(
    schedule: RitualSchedule,
    now: string,
  ): Promise<void> {
    let claimed = schedule;
    if (!schedule.pendingOccurrence) {
      const result = await this.repository.claimScheduleOccurrence({
        ritualId: schedule.ritualId,
        ritualRevision: schedule.ritualRevision,
        expectedDueAt: schedule.nextRunAt,
        runId: this.dependencies.createRunId(),
        nextRunAt: nextRitualOccurrence(schedule, now, schedule.nextRunAt),
        claimedAt: now,
      });
      if (!result) return;
      claimed = result;
    }
    if (!claimed.pendingOccurrence) return;

    const request = ritualScheduledRunRequestSchema.parse({
      schemaVersion: 1,
      ritualId: claimed.ritualId,
      ritualRevision: claimed.ritualRevision,
      runId: claimed.pendingOccurrence.runId,
      dueAt: claimed.pendingOccurrence.dueAt,
    });
    await this.controller.startScheduledRun(request);
    await this.repository.acknowledgeScheduleOccurrence(request.runId, now);
  }
}

export function nextRitualOccurrence(
  schedule: Pick<RitualSchedule, "cadence" | "localTime" | "timeZone">,
  after: string,
  excludeSameLocalDateAs?: string,
): string {
  const afterMilliseconds = Date.parse(after);
  if (!Number.isFinite(afterMilliseconds)) {
    throw new Error("RITUAL_SCHEDULE_TIME_INVALID");
  }
  const formatter = createFormatter(schedule.timeZone);
  const [targetHour, targetMinute] = schedule.localTime.split(":").map(Number);
  const excludedDate = excludeSameLocalDateAs
    ? localParts(formatter, Date.parse(excludeSameLocalDateAs)).date
    : null;
  let candidate = Math.floor(afterMilliseconds / 60_000) * 60_000 + 60_000;
  const limit = candidate + 9 * 24 * 60 * 60_000;
  for (; candidate <= limit; candidate += 60_000) {
    const parts = localParts(formatter, candidate);
    if (
      parts.date !== excludedDate &&
      parts.hour === targetHour &&
      parts.minute === targetMinute &&
      (schedule.cadence === "DAILY" ||
        (parts.weekday !== "Sat" && parts.weekday !== "Sun"))
    ) {
      return new Date(candidate).toISOString();
    }
  }
  throw new Error("RITUAL_SCHEDULE_OCCURRENCE_NOT_FOUND");
}

function createFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch (error) {
    throw new Error("RITUAL_SCHEDULE_TIME_ZONE_INVALID", { cause: error });
  }
}

function localParts(
  formatter: Intl.DateTimeFormat,
  instant: number,
): {
  date: string;
  weekday: string;
  hour: number;
  minute: number;
} {
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday ?? "",
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}
