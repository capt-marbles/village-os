export type CloudRecordClass =
  | "PROJECTIONS"
  | "EVENTS"
  | "CHECKPOINTS"
  | "RECEIPTS"
  | "WORKFLOW_EFFECTS"
  | "WORKFLOW_ACTORS"
  | "CANCELLATIONS"
  | "CONTINUITY_GRANTS"
  | "CONTINUITY_RECIPIENT_KEYS";

export type RecordRetentionPolicy = {
  scope: "PRINCIPAL";
  encryptionAtRest: "CLOUDFLARE_MANAGED";
  retentionDays: number;
  export: "AVAILABLE";
  deletion: "CASCADE_ON_PRINCIPAL_DELETE";
  backup: "EXPIRES_WITH_BACKUP_RETENTION";
  verification: "TOMBSTONE_AND_ABSENCE_CHECK";
};

const defaultRecordPolicy: RecordRetentionPolicy = {
  scope: "PRINCIPAL",
  encryptionAtRest: "CLOUDFLARE_MANAGED",
  retentionDays: 30,
  export: "AVAILABLE",
  deletion: "CASCADE_ON_PRINCIPAL_DELETE",
  backup: "EXPIRES_WITH_BACKUP_RETENTION",
  verification: "TOMBSTONE_AND_ABSENCE_CHECK",
};

/** Typed convenience for owner-exported 30-day history classes.
 * The exhaustive, CI-audited authority is cloud-record-lifecycle.yaml.
 */
export const recordRetentionPolicies: Readonly<
  Record<CloudRecordClass, RecordRetentionPolicy>
> = {
  PROJECTIONS: defaultRecordPolicy,
  EVENTS: defaultRecordPolicy,
  CHECKPOINTS: defaultRecordPolicy,
  RECEIPTS: defaultRecordPolicy,
  WORKFLOW_EFFECTS: defaultRecordPolicy,
  WORKFLOW_ACTORS: defaultRecordPolicy,
  CANCELLATIONS: defaultRecordPolicy,
  CONTINUITY_GRANTS: defaultRecordPolicy,
  CONTINUITY_RECIPIENT_KEYS: defaultRecordPolicy,
};

export async function executeRetentionBatch(
  db: D1Database,
  now: string,
  batchSize = 500,
): Promise<{ deleted: number; hasMore: boolean }> {
  const parsedNow = Date.parse(now);
  if (!Number.isFinite(parsedNow)) throw new Error("INVALID_RETENTION_TIME");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("INVALID_RETENTION_BATCH_SIZE");
  }
  const cutoff = new Date(
    parsedNow - defaultRecordPolicy.retentionDays * 86_400_000,
  ).toISOString();
  const terminalJobs = `EXISTS (
    SELECT 1 FROM jobs
    WHERE jobs.principal_id = target.principal_id
      AND jobs.job_id = target.job_id
      AND jobs.state IN ('SUCCEEDED', 'FAILED', 'CANCELED')
      AND jobs.updated_at < ?
  )`;
  const expiredPairings = await db
    .prepare(
      `UPDATE pairing_challenges SET state = 'EXPIRED'
       WHERE rowid IN (
         SELECT rowid FROM pairing_challenges
         WHERE state = 'PENDING_CONFIRMATION' AND expires_at <= ?
         ORDER BY expires_at LIMIT ?
       )`,
    )
    .bind(now, batchSize)
    .run();
  const statements = [
    db
      .prepare(
        `DELETE FROM pairing_challenges WHERE rowid IN (
           SELECT rowid FROM pairing_challenges
           WHERE state IN ('EXPIRED', 'REJECTED', 'CONSUMED') AND expires_at < ?
           ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM authenticated_quota_usage
         WHERE rowid IN (
           SELECT rowid FROM authenticated_quota_usage
           WHERE window_started_at < ? ORDER BY window_started_at LIMIT ?
         )`,
      )
      .bind(
        new Date(parsedNow - 86_400_000).toISOString().slice(0, 16),
        batchSize,
      ),
    db
      .prepare(
        `DELETE FROM authenticated_principal_quota_usage
         WHERE rowid IN (
           SELECT rowid FROM authenticated_principal_quota_usage
           WHERE window_started_at < ? ORDER BY window_started_at LIMIT ?
         )`,
      )
      .bind(
        new Date(parsedNow - 86_400_000).toISOString().slice(0, 16),
        batchSize,
      ),
    db
      .prepare(
        `DELETE FROM projection_outbox WHERE rowid IN (
           SELECT target.rowid FROM projection_outbox AS target
           WHERE target.projected_at IS NOT NULL
             AND target.created_at < ? AND ${terminalJobs}
           ORDER BY target.created_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM workflow_last_effect_actor WHERE rowid IN (
           SELECT target.rowid FROM workflow_last_effect_actor AS target
           WHERE target.occurred_at < ? AND ${terminalJobs}
           ORDER BY target.occurred_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM workflow_cancellations WHERE rowid IN (
           SELECT target.rowid FROM workflow_cancellations AS target
           WHERE target.accepted_at < ? AND ${terminalJobs}
           ORDER BY target.accepted_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM workflow_effect_projections WHERE rowid IN (
           SELECT target.rowid FROM workflow_effect_projections AS target
           WHERE target.updated_at < ? AND ${terminalJobs}
           ORDER BY target.updated_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM action_receipts WHERE rowid IN (
           SELECT target.rowid FROM action_receipts AS target
           WHERE target.recorded_at < ? AND ${terminalJobs}
           ORDER BY target.recorded_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM browser_session_event_projections WHERE rowid IN (
           SELECT target.rowid FROM browser_session_event_projections AS target
           JOIN browser_sessions AS session
             ON session.principal_id = target.principal_id
            AND session.browser_session_id = target.browser_session_id
           JOIN jobs
             ON jobs.principal_id = session.principal_id
            AND jobs.job_id = session.job_id
           WHERE target.occurred_at < ?
             AND jobs.state IN ('SUCCEEDED', 'FAILED', 'CANCELED')
             AND jobs.updated_at < ?
           ORDER BY target.occurred_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM checkpoints WHERE rowid IN (
           SELECT target.rowid FROM checkpoints AS target
           WHERE target.created_at < ? AND ${terminalJobs}
           ORDER BY target.created_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
    db
      .prepare(
        `DELETE FROM job_events WHERE rowid IN (
           SELECT target.rowid FROM job_events AS target
           WHERE target.occurred_at < ? AND ${terminalJobs}
           ORDER BY target.occurred_at LIMIT ?
         )`,
      )
      .bind(cutoff, cutoff, batchSize),
  ];
  const results = await db.batch(statements);
  const deleted = results.reduce(
    (total, result) => total + (result.meta.changes ?? 0),
    0,
  );
  return {
    deleted,
    hasMore:
      expiredPairings.meta.changes === batchSize ||
      results.some((result) => result.meta.changes === batchSize),
  };
}

export async function executeCloudRetentionBatch(
  environment: import("../../env.js").Environment,
  now: string,
  batchSize = 500,
): Promise<{ deleted: number; hasMore: boolean }> {
  const d1 = await executeRetentionBatch(
    environment.VILLAGE_DB,
    now,
    batchSize,
  );
  const cutoff = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
  const grants = await environment.VILLAGE_DB.prepare(
    `SELECT principal_id AS principalId, grant_id AS grantId
     FROM continuity_grants
     WHERE state IN ('REVOKED', 'DELETED', 'EXPIRED')
       AND COALESCE(deleted_at, revoked_at, expires_at) < ?
     ORDER BY COALESCE(deleted_at, revoked_at, expires_at) LIMIT ?`,
  )
    .bind(cutoff, batchSize)
    .all<{ principalId: string; grantId: string }>();
  let deletedGrants = 0;
  for (const grant of grants.results) {
    const mailbox = environment.SITE_SESSION_MAILBOX.getByName(
      `${grant.principalId}:${grant.grantId}`,
    );
    const destroyed = await mailbox.destroy(grant.principalId);
    if (!destroyed.ok && destroyed.code !== "MAILBOX_NOT_FOUND") continue;
    const deletion = await environment.VILLAGE_DB.prepare(
      `DELETE FROM continuity_grants
       WHERE principal_id = ? AND grant_id = ?
         AND state IN ('REVOKED', 'DELETED', 'EXPIRED')`,
    )
      .bind(grant.principalId, grant.grantId)
      .run();
    deletedGrants += deletion.meta.changes ?? 0;
  }
  return {
    deleted: d1.deleted + deletedGrants,
    hasMore: d1.hasMore || grants.results.length === batchSize,
  };
}
