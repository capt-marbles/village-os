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
  const device = await db
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
  if (!device) return backpressure(now);
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
  return principal
    ? {
        ok: true as const,
        usage: { device: device.usage, principal: principal.usage },
        limit: limits,
      }
    : backpressure(now);
}

function quotaColumn(kind: QuotaKind, scope: "device" | "principal") {
  return kind === "retainedRecords"
    ? scope === "device"
      ? "retained_events"
      : "retained_records"
    : kind;
}

function quotaWindow(now: string) {
  const date = new Date(now);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
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
