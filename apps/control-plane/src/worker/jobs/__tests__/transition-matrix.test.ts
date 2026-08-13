import { describe, expect, it } from "vitest";
import type { Job, JobEvent, JobState } from "@village/contracts";
import { applyJobEvent } from "../ledger.js";

const principalId = "prn_01J00000000000000000000000" as const;
const jobId = "job_01J00000000000000000000000" as const;
const browserSessionId = "brs_01J00000000000000000000000" as const;
const baseEvent = {
  eventId: "evt_01J00000000000000000000002",
  principalId,
  jobId,
  sequence: 2,
  occurredAt: "2026-08-12T18:00:01.000Z",
} as const;

const events = {
  BROWSER_HOST_UNAVAILABLE: {
    ...baseEvent,
    type: "BROWSER_HOST_UNAVAILABLE",
    payload: {},
  },
  BROWSER_HOST_AVAILABLE: {
    ...baseEvent,
    type: "BROWSER_HOST_AVAILABLE",
    payload: { browserSessionId },
  },
  HUMAN_GATE_RAISED: {
    ...baseEvent,
    type: "HUMAN_GATE_RAISED",
    payload: {
      humanGateId: "hgt_01J00000000000000000000000",
      reason: "TWO_FACTOR",
    },
  },
  USER_CONTROL_ACKNOWLEDGED: {
    ...baseEvent,
    type: "USER_CONTROL_ACKNOWLEDGED",
    payload: {},
  },
  AGENT_CONTROL_RECONCILED: {
    ...baseEvent,
    type: "AGENT_CONTROL_RECONCILED",
    payload: {},
  },
  VERIFICATION_STARTED: {
    ...baseEvent,
    type: "VERIFICATION_STARTED",
    payload: {},
  },
  JOB_SUCCEEDED: { ...baseEvent, type: "JOB_SUCCEEDED", payload: {} },
  JOB_FAILED: {
    ...baseEvent,
    type: "JOB_FAILED",
    payload: { code: "TEST_FAILURE" },
  },
  JOB_CANCELED: { ...baseEvent, type: "JOB_CANCELED", payload: {} },
} satisfies Record<string, JobEvent>;

const allowed: Record<JobState, ReadonlySet<keyof typeof events>> = {
  QUEUED: new Set([
    "BROWSER_HOST_UNAVAILABLE",
    "BROWSER_HOST_AVAILABLE",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  WAITING_FOR_BROWSER: new Set([
    "BROWSER_HOST_AVAILABLE",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  RUNNING_AGENT: new Set([
    "BROWSER_HOST_UNAVAILABLE",
    "HUMAN_GATE_RAISED",
    "VERIFICATION_STARTED",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  WAITING_FOR_SECRET: new Set([
    "BROWSER_HOST_UNAVAILABLE",
    "USER_CONTROL_ACKNOWLEDGED",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  WAITING_FOR_USER: new Set([
    "BROWSER_HOST_UNAVAILABLE",
    "USER_CONTROL_ACKNOWLEDGED",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  RUNNING_USER: new Set([
    "BROWSER_HOST_UNAVAILABLE",
    "AGENT_CONTROL_RECONCILED",
    "VERIFICATION_STARTED",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  VERIFYING: new Set([
    "BROWSER_HOST_UNAVAILABLE",
    "JOB_SUCCEEDED",
    "JOB_FAILED",
    "JOB_CANCELED",
  ]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELED: new Set(),
};

function job(state: JobState): Job {
  return {
    principalId,
    jobId,
    browserSessionId:
      state === "QUEUED" || state === "WAITING_FOR_BROWSER"
        ? null
        : browserSessionId,
    state,
    version: 1,
    lastEventSequence: 1,
    activeHumanGateId:
      state === "WAITING_FOR_SECRET" ||
      state === "WAITING_FOR_USER" ||
      state === "RUNNING_USER"
        ? "hgt_01J00000000000000000000000"
        : null,
    createdAt: "2026-08-12T18:00:00.000Z",
    updatedAt: "2026-08-12T18:00:00.000Z",
  };
}

describe("job transition matrix", () => {
  it("defines every event as allowed or rejected for every indexed job state", () => {
    for (const state of Object.keys(allowed) as JobState[]) {
      for (const [eventType, event] of Object.entries(events) as [
        keyof typeof events,
        JobEvent,
      ][]) {
        const result = applyJobEvent(job(state), event, 1);
        expect(result.ok, `${state} + ${eventType}`).toBe(
          allowed[state].has(eventType),
        );
        if (!allowed[state].has(eventType)) {
          expect(result).toEqual({ ok: false, code: "ILLEGAL_EVENT" });
        }
      }
    }
  });
});
