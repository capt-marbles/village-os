export type QuotaKind =
  "connections" | "commands" | "replays" | "notifications" | "retainedRecords";

export const authenticatedQuotaLimits = {
  connections: { device: 30, principal: 30 },
  commands: { device: 120, principal: 120 },
  replays: { device: 120, principal: 120 },
  notifications: { device: 60, principal: 60 },
  retainedRecords: { device: 1_000, principal: 1_000 },
} as const;

export async function consumeAuthenticatedQuota(
  db: D1Database,
  principalId: string,
  deviceId: string,
  kind: QuotaKind,
  now: string,
) {
  const window = quotaWindow(now);
  const deviceColumn = quotaColumn(kind, "device");
  const principalColumn = quotaColumn(kind, "principal");
  const limits = authenticatedQuotaLimits[kind];
  const principal = await db
    .prepare(
      `INSERT INTO authenticated_principal_quota_usage
       (principal_id, window_started_at, ${principalColumn})
       VALUES (?, ?, 1)
       ON CONFLICT(principal_id, window_started_at) DO UPDATE SET
         ${principalColumn} = ${principalColumn} + 1
       WHERE ${principalColumn} < ?
       RETURNING ${principalColumn} AS usage`,
    )
    .bind(principalId, window, limits.principal)
    .first<{ usage: number }>();
  if (!principal) return backpressure(now);
  let device: { usage: number } | null;
  try {
    device = await db
      .prepare(
        `INSERT INTO authenticated_quota_usage
         (principal_id, device_id, window_started_at, ${deviceColumn})
         VALUES (?, ?, ?, 1)
         ON CONFLICT(principal_id, device_id, window_started_at) DO UPDATE SET
           ${deviceColumn} = ${deviceColumn} + 1
         WHERE ${deviceColumn} < ?
         RETURNING ${deviceColumn} AS usage`,
      )
      .bind(principalId, deviceId, window, limits.device)
      .first<{ usage: number }>();
  } catch (error) {
    await releasePrincipalQuota(db, principalId, window, principalColumn);
    throw error;
  }
  if (!device) {
    await releasePrincipalQuota(db, principalId, window, principalColumn);
    return backpressure(now);
  }
  return {
    ok: true as const,
    usage: { device: device.usage, principal: principal.usage },
    limit: limits,
  };
}

async function releasePrincipalQuota(
  db: D1Database,
  principalId: string,
  window: string,
  column: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE authenticated_principal_quota_usage
       SET ${column} = ${column} - 1
       WHERE principal_id = ? AND window_started_at = ? AND ${column} > 0`,
    )
    .bind(principalId, window)
    .run();
}

function quotaColumn(kind: QuotaKind, scope: "device" | "principal") {
  return kind === "retainedRecords"
    ? scope === "device"
      ? "retained_events"
      : "retained_records"
    : kind;
}

function quotaWindow(now: string) {
  // Preserve the minute key format used by the existing coordinator tables so
  // an upgrade cannot create a second budget for the same minute.
  return now.slice(0, 16);
}

function backpressure(now: string) {
  const date = new Date(now);
  const retryAt = new Date(date);
  retryAt.setUTCMinutes(retryAt.getUTCMinutes() + 1, 0, 0);
  return {
    ok: false as const,
    code: "AUTHENTICATED_QUOTA_EXCEEDED" as const,
    retryAt: retryAt.toISOString(),
    retryAfterMs: retryAt.getTime() - date.getTime(),
  };
}
