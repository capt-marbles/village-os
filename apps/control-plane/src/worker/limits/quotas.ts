type QuotaKind = "connections" | "commands";

const quotaLimit = { connections: 30, commands: 120 } as const;

export async function consumeAuthenticatedQuota(
  db: D1Database,
  principalId: string,
  deviceId: string,
  kind: QuotaKind,
  now: string,
) {
  const window = now.slice(0, 16);
  const column = kind === "connections" ? "connections" : "commands";
  const result = await db
    .prepare(
      `INSERT INTO authenticated_quota_usage
       (principal_id, device_id, window_started_at, ${column})
       VALUES (?, ?, ?, 1)
       ON CONFLICT(principal_id, device_id, window_started_at) DO UPDATE SET
         ${column} = ${column} + 1
       WHERE ${column} < ?
       RETURNING ${column} AS usage`,
    )
    .bind(principalId, deviceId, window, quotaLimit[kind])
    .first<{ usage: number }>();
  return result
    ? { ok: true as const, usage: result.usage, limit: quotaLimit[kind] }
    : { ok: false as const, code: "AUTHENTICATED_QUOTA_EXCEEDED" };
}
