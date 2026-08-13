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
      ).toMatchObject({ ok: true, usage: count, limit: 30 });
    }
    expect(
      await consumeAuthenticatedQuota(
        env.VILLAGE_DB,
        principalId,
        deviceId,
        "connections",
        now,
      ),
    ).toEqual({ ok: false, code: "AUTHENTICATED_QUOTA_EXCEEDED" });

    for (let count = 1; count <= 120; count += 1) {
      expect(
        await consumeAuthenticatedQuota(
          env.VILLAGE_DB,
          principalId,
          deviceId,
          "commands",
          now,
        ),
      ).toMatchObject({ ok: true, usage: count, limit: 120 });
    }
    expect(
      await consumeAuthenticatedQuota(
        env.VILLAGE_DB,
        principalId,
        deviceId,
        "commands",
        now,
      ),
    ).toEqual({ ok: false, code: "AUTHENTICATED_QUOTA_EXCEEDED" });
  });
});
