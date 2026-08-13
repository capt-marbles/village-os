import {
  jobEventSchema,
  jobSchema,
  type Job,
  type JobEvent,
  type JobState,
} from "@village/contracts";

type LedgerError =
  | "INVALID_EVENT"
  | "VERSION_CONFLICT"
  | "NON_MONOTONIC_SEQUENCE"
  | "IDENTITY_MISMATCH"
  | "ILLEGAL_EVENT";

export type LedgerResult =
  { ok: true; job: Job } | { ok: false; code: LedgerError };

const terminalStates = new Set<JobState>(["SUCCEEDED", "FAILED", "CANCELED"]);

export function applyJobEvent(
  current: Job | null,
  candidate: unknown,
  expectedVersion?: number,
): LedgerResult {
  const parsed = jobEventSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "INVALID_EVENT" };
  const event = parsed.data;

  if (current === null) {
    if (expectedVersion !== undefined && expectedVersion !== 0)
      return { ok: false, code: "VERSION_CONFLICT" };
    if (event.type !== "JOB_CREATED" || event.sequence !== 1)
      return { ok: false, code: "ILLEGAL_EVENT" };
    return {
      ok: true,
      job: {
        principalId: event.principalId,
        jobId: event.jobId,
        browserSessionId: null,
        state: "QUEUED",
        version: 1,
        lastEventSequence: 1,
        activeHumanGateId: null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      },
    };
  }

  const job = jobSchema.parse(current);
  if (expectedVersion !== undefined && expectedVersion !== job.version)
    return { ok: false, code: "VERSION_CONFLICT" };
  if (event.principalId !== job.principalId || event.jobId !== job.jobId)
    return { ok: false, code: "IDENTITY_MISMATCH" };
  if (event.sequence !== job.lastEventSequence + 1)
    return { ok: false, code: "NON_MONOTONIC_SEQUENCE" };
  if (terminalStates.has(job.state))
    return { ok: false, code: "ILLEGAL_EVENT" };

  let state: JobState;
  let browserSessionId = job.browserSessionId;
  let activeHumanGateId = job.activeHumanGateId;
  switch (event.type) {
    case "JOB_CREATED":
      return { ok: false, code: "ILLEGAL_EVENT" };
    case "BROWSER_HOST_UNAVAILABLE":
      if (
        job.state !== "QUEUED" &&
        job.state !== "RUNNING_AGENT" &&
        job.state !== "WAITING_FOR_SECRET" &&
        job.state !== "WAITING_FOR_USER" &&
        job.state !== "RUNNING_USER" &&
        job.state !== "VERIFYING"
      ) {
        return { ok: false, code: "ILLEGAL_EVENT" };
      }
      state =
        job.state === "WAITING_FOR_USER" || job.state === "RUNNING_USER"
          ? "WAITING_FOR_USER"
          : "WAITING_FOR_BROWSER";
      if (state === "WAITING_FOR_BROWSER") activeHumanGateId = null;
      break;
    case "BROWSER_HOST_AVAILABLE":
      if (job.state !== "QUEUED" && job.state !== "WAITING_FOR_BROWSER")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "RUNNING_AGENT";
      browserSessionId = event.payload.browserSessionId;
      break;
    case "HUMAN_GATE_RAISED":
      if (job.state !== "RUNNING_AGENT")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state =
        event.payload.reason === "CREDENTIAL"
          ? "WAITING_FOR_SECRET"
          : "WAITING_FOR_USER";
      activeHumanGateId = event.payload.humanGateId;
      break;
    case "USER_CONTROL_ACKNOWLEDGED":
      if (
        job.state !== "WAITING_FOR_SECRET" &&
        job.state !== "WAITING_FOR_USER"
      )
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "RUNNING_USER";
      break;
    case "SECRET_BROKER_ACCEPTED":
      if (job.state !== "WAITING_FOR_SECRET")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "RUNNING_AGENT";
      activeHumanGateId = null;
      break;
    case "SECRET_BROKER_DECLINED":
      if (job.state !== "WAITING_FOR_SECRET")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "WAITING_FOR_USER";
      break;
    case "AGENT_CONTROL_RECONCILED":
      if (job.state !== "RUNNING_USER")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "VERIFYING";
      activeHumanGateId = null;
      break;
    case "VERIFICATION_STARTED":
      if (job.state !== "RUNNING_AGENT" && job.state !== "RUNNING_USER")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "VERIFYING";
      activeHumanGateId = null;
      break;
    case "VERIFICATION_RECONCILED":
      if (job.state !== "VERIFYING")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "RUNNING_AGENT";
      break;
    case "VERIFICATION_UNKNOWN":
      if (job.state !== "VERIFYING")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "WAITING_FOR_USER";
      activeHumanGateId = event.payload.humanGateId;
      break;
    case "JOB_SUCCEEDED":
      if (job.state !== "VERIFYING")
        return { ok: false, code: "ILLEGAL_EVENT" };
      state = "SUCCEEDED";
      break;
    case "JOB_FAILED":
      state = "FAILED";
      activeHumanGateId = null;
      break;
    case "JOB_CANCELED":
      state = "CANCELED";
      activeHumanGateId = null;
      break;
  }

  const next = jobSchema.safeParse({
    ...job,
    state,
    browserSessionId,
    activeHumanGateId,
    version: job.version + 1,
    lastEventSequence: event.sequence,
    updatedAt: event.occurredAt,
  });
  return next.success
    ? { ok: true, job: next.data }
    : { ok: false, code: "ILLEGAL_EVENT" };
}

export function replayJobEvents(events: readonly JobEvent[]): LedgerResult {
  let current: Job | null = null;
  for (const event of events) {
    const result = applyJobEvent(current, event);
    if (!result.ok) return result;
    current = result.job;
  }
  return current
    ? { ok: true, job: current }
    : { ok: false, code: "ILLEGAL_EVENT" };
}
