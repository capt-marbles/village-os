import { describe, expect, it } from "vitest";
import { applyJobEvent, replayJobEvents } from "../ledger.js";

const created = {
  eventId: "evt_01J00000000000000000000000",
  principalId: "prn_01J00000000000000000000000",
  jobId: "job_01J00000000000000000000000",
  sequence: 1,
  occurredAt: "2026-08-12T18:00:00.000Z",
  type: "JOB_CREATED",
  payload: {},
} as const;

const hostUnavailable = {
  ...created,
  eventId: "evt_01J00000000000000000000001",
  sequence: 2,
  occurredAt: "2026-08-12T18:00:01.000Z",
  type: "BROWSER_HOST_UNAVAILABLE",
} as const;

describe("job ledger", () => {
  it("replays host absence into the same indexed waiting state and rejects a stale writer", () => {
    const replayed = replayJobEvents([created, hostUnavailable]);
    expect(replayed).toEqual({
      ok: true,
      job: {
        principalId: created.principalId,
        jobId: created.jobId,
        browserSessionId: null,
        state: "WAITING_FOR_BROWSER",
        version: 2,
        lastEventSequence: 2,
        activeHumanGateId: null,
        createdAt: created.occurredAt,
        updatedAt: hostUnavailable.occurredAt,
      },
    });
    if (!replayed.ok) throw new Error("replay unexpectedly failed");

    expect(applyJobEvent(replayed.job, hostUnavailable, 1)).toEqual({
      ok: false,
      code: "VERSION_CONFLICT",
    });
    expect(
      replayJobEvents([created, { ...hostUnavailable, sequence: 1 }]),
    ).toEqual({
      ok: false,
      code: "NON_MONOTONIC_SEQUENCE",
    });
  });
});
