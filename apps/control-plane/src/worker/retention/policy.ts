export type CloudRecordClass =
  "PROJECTIONS" | "EVENTS" | "CHECKPOINTS" | "RECEIPTS";

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

/** Declarative lifecycle contract for every cloud record exposed to an owner. */
export const recordRetentionPolicies: Readonly<
  Record<CloudRecordClass, RecordRetentionPolicy>
> = {
  PROJECTIONS: defaultRecordPolicy,
  EVENTS: defaultRecordPolicy,
  CHECKPOINTS: defaultRecordPolicy,
  RECEIPTS: defaultRecordPolicy,
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
  const statements = [
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
    hasMore: results.some((result) => result.meta.changes === batchSize),
  };
}
