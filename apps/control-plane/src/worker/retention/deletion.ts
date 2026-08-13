import { z } from "zod";
import { instantSchema, principalIdSchema } from "@village/contracts";

const deletionRequestSchema = z.strictObject({
  principalId: principalIdSchema,
  deletionRequestId: z.string().regex(/^del_[A-Za-z0-9]{26}$/),
  requestedAt: instantSchema,
});

const deletionCountQueries = [
  "SELECT COUNT(*) AS count FROM principals WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM devices WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM jobs WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM job_events WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM checkpoints WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM browser_sessions WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM browser_actions WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM action_receipts WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM human_gates WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM projection_outbox WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM browser_session_event_projections WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM protocol_replay_windows WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM pairing_challenges WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM authenticated_quota_usage WHERE principal_id = ?",
  "SELECT COUNT(*) AS count FROM authenticated_principal_quota_usage WHERE principal_id = ?",
] as const;

export async function exportPrincipalRecords(
  db: D1Database,
  principalCandidate: unknown,
) {
  const principal = principalIdSchema.parse(principalCandidate);
  const [projections, events, checkpoints, receipts] = await Promise.all([
    db
      .prepare(
        `SELECT browser_session_id AS browserSessionId, sequence, event_type AS eventType,
                occurred_at AS occurredAt
         FROM browser_session_event_projections
         WHERE principal_id = ? ORDER BY browser_session_id, sequence`,
      )
      .bind(principal)
      .all(),
    db
      .prepare(
        `SELECT job_id AS jobId, sequence, event_type AS eventType, occurred_at AS occurredAt
         FROM job_events WHERE principal_id = ? ORDER BY job_id, sequence`,
      )
      .bind(principal)
      .all(),
    db
      .prepare(
        `SELECT job_id AS jobId, checkpoint_id AS checkpointId, job_version AS jobVersion,
                event_sequence AS eventSequence, state, created_at AS createdAt
         FROM checkpoints WHERE principal_id = ? ORDER BY job_id, checkpoint_id`,
      )
      .bind(principal)
      .all(),
    db
      .prepare(
        `SELECT browser_session_id AS browserSessionId, receipt_id AS receiptId,
                job_id AS jobId, action_id AS actionId, outcome, recorded_at AS recordedAt
         FROM action_receipts WHERE principal_id = ?
         ORDER BY browser_session_id, receipt_id`,
      )
      .bind(principal)
      .all(),
  ]);
  return {
    principalId: principal,
    projections: projections.results,
    events: events.results,
    checkpoints: checkpoints.results,
    receipts: receipts.results,
  };
}

export async function planPrincipalDeletion(
  db: D1Database,
  candidate: unknown,
) {
  const request = deletionRequestSchema.safeParse(candidate);
  if (!request.success)
    return { ok: false as const, code: "INVALID_DELETION_REQUEST" };
  const principal = await db
    .prepare("SELECT 1 AS present FROM principals WHERE principal_id = ?")
    .bind(request.data.principalId)
    .first<{ present: number }>();
  if (!principal) return { ok: false as const, code: "PRINCIPAL_NOT_FOUND" };
  await db
    .prepare(
      `INSERT INTO principal_deletion_plans
       (principal_id, deletion_request_id, requested_at, status, completed_at)
       VALUES (?, ?, ?, 'PLANNED', NULL)
       ON CONFLICT(principal_id, deletion_request_id) DO NOTHING`,
    )
    .bind(
      request.data.principalId,
      request.data.deletionRequestId,
      request.data.requestedAt,
    )
    .run();
  return { ok: true as const, status: "PLANNED" as const };
}

export async function executePrincipalDeletion(
  db: D1Database,
  candidate: unknown,
) {
  const request = deletionRequestSchema.safeParse(candidate);
  if (!request.success)
    return { ok: false as const, code: "INVALID_DELETION_REQUEST" };
  const plan = await db
    .prepare(
      `SELECT status FROM principal_deletion_plans
       WHERE principal_id = ? AND deletion_request_id = ?`,
    )
    .bind(request.data.principalId, request.data.deletionRequestId)
    .first<{ status: "PLANNED" | "COMPLETED" | "VERIFICATION_FAILED" }>();
  if (!plan) return { ok: false as const, code: "DELETION_PLAN_NOT_FOUND" };
  if (plan.status !== "COMPLETED") {
    await db
      .prepare("DELETE FROM principals WHERE principal_id = ?")
      .bind(request.data.principalId)
      .run();
  }
  const verification = await verifyPrincipalDeletion(
    db,
    request.data.principalId,
  );
  await db
    .prepare(
      `UPDATE principal_deletion_plans
       SET status = ?, completed_at = ?
       WHERE principal_id = ? AND deletion_request_id = ?`,
    )
    .bind(
      verification.verified ? "COMPLETED" : "VERIFICATION_FAILED",
      verification.verified ? request.data.requestedAt : null,
      request.data.principalId,
      request.data.deletionRequestId,
    )
    .run();
  return verification.verified
    ? { ok: true as const, status: "COMPLETED" as const, verification }
    : {
        ok: false as const,
        code: "DELETION_VERIFICATION_FAILED",
        verification,
      };
}

export async function verifyPrincipalDeletion(
  db: D1Database,
  principalCandidate: unknown,
): Promise<{ verified: boolean; remainingRecords: number }> {
  const principal = principalIdSchema.parse(principalCandidate);
  const results = await db.batch(
    deletionCountQueries.map((query) => db.prepare(query).bind(principal)),
  );
  const counts = results.map(
    (result) =>
      (result.results[0] as { count?: number } | undefined)?.count ?? 0,
  );
  const remainingRecords = counts.reduce((total, count) => total + count, 0);
  return { verified: remainingRecords === 0, remainingRecords };
}
