import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { consumeAuthenticatedQuota } from "../quotas.js";

const principalId = "prn_01J00000000000000000000003";
const deviceId = "dev_01J00000000000000000000003";
const now = "2026-08-12T18:00:00.000Z";

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare("DELETE FROM authenticated_quota_usage"),
    env.VILLAGE_DB.prepare("DELETE FROM authenticated_principal_quota_usage"),
  ]);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principalId, now),
    env.VILLAGE_DB.prepare(
      `INSERT OR IGNORE INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    ).bind(principalId, deviceId, now),
  ]);
});

describe("authenticated protocol quotas", () => {
  it("applies connection and command backpressure per device window", async () => {
    for (let count = 1; count <= 30; count += 1) {
      expect(
        await consumeAuthenticatedQuota(
          env.VILLAGE_DB,
          principalId,
          deviceId,
          "connections",
          now,
        ),
      ).toMatchObject({
        ok: true,
        usage: { device: count, principal: count },
        limit: { device: 30, principal: 30 },
      });
    }
    expect(
      await consumeAuthenticatedQuota(
        env.VILLAGE_DB,
        principalId,
        deviceId,
        "connections",
        now,
      ),
    ).toMatchObject({
      ok: false,
      code: "AUTHENTICATED_QUOTA_EXCEEDED",
      retryAfterMs: expect.any(Number),
      retryAt: "2026-08-12T18:01:00.000Z",
    });

    for (let count = 1; count <= 120; count += 1) {
      expect(
        await consumeAuthenticatedQuota(
          env.VILLAGE_DB,
          principalId,
          deviceId,
          "commands",
          now,
        ),
      ).toMatchObject({
        ok: true,
        usage: { device: count, principal: count },
        limit: { device: 120, principal: 120 },
      });
    }
    expect(
      await consumeAuthenticatedQuota(
        env.VILLAGE_DB,
        principalId,
        deviceId,
        "commands",
        now,
      ),
    ).toMatchObject({ ok: false, code: "AUTHENTICATED_QUOTA_EXCEEDED" });
  });

  it("enforces a shared principal budget across devices and bounds replay, notification, and retained-record classes", async () => {
    const secondDeviceId = "dev_01J00000000000000000000004";
    await env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    )
      .bind(principalId, secondDeviceId, now)
      .run();
    await env.VILLAGE_DB.prepare(
      `INSERT INTO authenticated_principal_quota_usage
       (principal_id, window_started_at, connections, commands, replays, notifications, retained_records)
       VALUES (?, ?, 30, 0, 0, 0, 0)`,
    )
      .bind(principalId, "2026-08-12T18:00")
      .run();

    await expect(
      consumeAuthenticatedQuota(
        env.VILLAGE_DB,
        principalId,
        secondDeviceId,
        "connections",
        now,
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "AUTHENTICATED_QUOTA_EXCEEDED",
      retryAt: "2026-08-12T18:01:00.000Z",
    });
    await expect(
      env.VILLAGE_DB.prepare(
        `SELECT connections FROM authenticated_quota_usage
         WHERE principal_id = ? AND device_id = ? AND window_started_at = ?`,
      )
        .bind(principalId, secondDeviceId, "2026-08-12T18:00")
        .first<{ connections: number }>(),
    ).resolves.toBeNull();

    for (const kind of [
      "replays",
      "notifications",
      "retainedRecords",
    ] as const) {
      await expect(
        consumeAuthenticatedQuota(
          env.VILLAGE_DB,
          principalId,
          deviceId,
          kind,
          now,
        ),
      ).resolves.toMatchObject({
        ok: true,
        usage: { device: 1, principal: 1 },
      });
    }
  });

  it("continues the persisted pre-upgrade minute budget", async () => {
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        `INSERT INTO authenticated_quota_usage
         (principal_id, device_id, window_started_at, commands)
         VALUES (?, ?, ?, 120)`,
      ).bind(principalId, deviceId, "2026-08-12T18:00"),
      env.VILLAGE_DB.prepare(
        `INSERT INTO authenticated_principal_quota_usage
         (principal_id, window_started_at, commands)
         VALUES (?, ?, 119)`,
      ).bind(principalId, "2026-08-12T18:00"),
    ]);

    await expect(
      consumeAuthenticatedQuota(
        env.VILLAGE_DB,
        principalId,
        deviceId,
        "commands",
        "2026-08-12T18:00:59.999Z",
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: "AUTHENTICATED_QUOTA_EXCEEDED",
    });
    await expect(
      env.VILLAGE_DB.prepare(
        `SELECT commands FROM authenticated_principal_quota_usage
         WHERE principal_id = ? AND window_started_at = ?`,
      )
        .bind(principalId, "2026-08-12T18:00")
        .first<{ commands: number }>(),
    ).resolves.toEqual({ commands: 119 });
  });
});
