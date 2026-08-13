import { jobIdSchema, principalIdSchema } from "@village/contracts";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function villageId(prefix: "job" | "evt", now: number): string {
  let time = now;
  let suffix = "";
  for (let index = 0; index < 10; index += 1) {
    suffix = alphabet[time % 32] + suffix;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (const byte of random) suffix += alphabet[byte & 31];
  return `${prefix}_${suffix}`;
}

type JobRow = {
  principal_id: string;
  job_id: string;
  browser_session_id: string | null;
  state: string;
  version: number;
  last_event_sequence: number;
  active_human_gate_id: string | null;
  created_at: string;
  updated_at: string;
};

function presentJob(row: JobRow) {
  return {
    principalId: row.principal_id,
    jobId: row.job_id,
    browserSessionId: row.browser_session_id,
    state: row.state,
    version: row.version,
    lastEventSequence: row.last_event_sequence,
    activeHumanGateId: row.active_human_gate_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createJob(
  db: D1Database,
  principalCandidate: unknown,
  now: string,
) {
  const principal = principalIdSchema.safeParse(principalCandidate);
  if (!principal.success)
    return { ok: false as const, code: "INVALID_PRINCIPAL" };
  const jobId = jobIdSchema.parse(villageId("job", Date.parse(now)));
  const eventId = villageId("evt", Date.parse(now));
  await db.batch([
    db
      .prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
         VALUES (?, ?, 'QUEUED', 1, 1, ?, ?)`,
      )
      .bind(principal.data, jobId, now, now),
    db
      .prepare(
        `INSERT INTO job_events
         (principal_id, job_id, event_id, sequence, event_type, payload_json, occurred_at)
         VALUES (?, ?, ?, 1, 'JOB_CREATED', '{}', ?)`,
      )
      .bind(principal.data, jobId, eventId, now),
    db
      .prepare(
        `INSERT INTO projection_outbox
         (principal_id, job_id, event_sequence, projection_type, payload_json, created_at)
         VALUES (?, ?, 1, 'JOB', ?, ?)`,
      )
      .bind(
        principal.data,
        jobId,
        JSON.stringify({ state: "QUEUED", version: 1 }),
        now,
      ),
  ]);
  return { ok: true as const, jobId };
}

export async function getJob(
  db: D1Database,
  principalCandidate: unknown,
  jobCandidate: unknown,
) {
  const principal = principalIdSchema.safeParse(principalCandidate);
  const job = jobIdSchema.safeParse(jobCandidate);
  if (!principal.success || !job.success)
    return { ok: false as const, code: "INVALID_JOB_IDENTITY" };
  const row = await db
    .prepare(
      `SELECT principal_id, job_id, browser_session_id, state, version,
              last_event_sequence, active_human_gate_id, created_at, updated_at
       FROM jobs WHERE principal_id = ? AND job_id = ?`,
    )
    .bind(principal.data, job.data)
    .first<JobRow>();
  return row
    ? { ok: true as const, job: presentJob(row) }
    : { ok: false as const, code: "JOB_NOT_FOUND" };
}

export async function listJobs(db: D1Database, principalCandidate: unknown) {
  const principal = principalIdSchema.safeParse(principalCandidate);
  if (!principal.success)
    return { ok: false as const, code: "INVALID_PRINCIPAL" };
  const rows = await db
    .prepare(
      `SELECT principal_id, job_id, browser_session_id, state, version,
              last_event_sequence, active_human_gate_id, created_at, updated_at
       FROM jobs WHERE principal_id = ? ORDER BY updated_at DESC, job_id DESC LIMIT 100`,
    )
    .bind(principal.data)
    .all<JobRow>();
  return { ok: true as const, jobs: rows.results.map(presentJob) };
}
