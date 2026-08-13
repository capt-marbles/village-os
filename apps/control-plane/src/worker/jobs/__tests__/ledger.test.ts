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

  it("replays distinct predicate and owner-confirmed authentication evidence", () => {
    const hostAvailable = {
      ...created,
      eventId: "evt_01J00000000000000000000003",
      sequence: 2,
      type: "BROWSER_HOST_AVAILABLE",
      payload: {
        browserSessionId: "brs_01J00000000000000000000000",
      },
    } as const;
    const verificationStarted = {
      ...created,
      eventId: "evt_01J00000000000000000000004",
      sequence: 3,
      type: "VERIFICATION_STARTED",
      payload: {},
    } as const;
    const automatic = {
      ...created,
      eventId: "evt_01J00000000000000000000005",
      sequence: 4,
      type: "JOB_SUCCEEDED",
      payload: {
        evidence: "PREDICATE_AUTHENTICATED",
        predicateVersion: "fixture-auth-v1",
      },
    } as const;
    const ownerConfirmed = {
      ...automatic,
      payload: {
        evidence: "OWNER_CONFIRMED",
        confirmationVersion: "owner-confirmation-v1",
      },
    } as const;

    expect(
      replayJobEvents([created, hostAvailable, verificationStarted, automatic]),
    ).toMatchObject({ ok: true, job: { state: "SUCCEEDED" } });
    expect(
      replayJobEvents([
        created,
        hostAvailable,
        verificationStarted,
        ownerConfirmed,
      ]),
    ).toMatchObject({ ok: true, job: { state: "SUCCEEDED" } });
    expect(automatic.payload).not.toEqual(ownerConfirmed.payload);
  });
});
