import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPairing,
  confirmPairing,
  consumePairing,
  rejectPairing,
  revokeDevice,
  rotateDeviceCredential,
} from "../pairing.js";

const principalId = "prn_01J00000000000000000000000" as const;
const otherPrincipalId = "prn_01J00000000000000000000001" as const;
const deviceId = "dev_01J00000000000000000000000" as const;
const now = "2026-08-12T18:00:00.000Z";

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principalId, now),
    env.VILLAGE_DB.prepare(
      "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(otherPrincipalId, now),
  ]);
});

async function challenge() {
  return beginPairing(env.VILLAGE_DB, {
    principalId,
    deviceId,
    deviceDisplayName: "Andrew's Mac",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" },
    protection: "HARDWARE_NON_EXPORTABLE",
    now,
  });
}

describe("device pairing", () => {
  it("requires owner confirmation and consumes the high-entropy secret once", async () => {
    const begun = await challenge();
    if (!begun.ok) throw new Error(begun.code);
    expect(begun.secret).toHaveLength(43);
    expect(
      await consumePairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        secret: begun.secret,
        now,
      }),
    ).toEqual({ ok: false, code: "PAIRING_NOT_CONSUMABLE" });
    expect(
      await confirmPairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        now,
      }),
    ).toEqual({ ok: true });
    expect(
      await consumePairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        secret: begun.secret,
        now,
      }),
    ).toEqual({ ok: true, deviceId });
    expect(
      await consumePairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        secret: begun.secret,
        now,
      }),
    ).toEqual({ ok: false, code: "PAIRING_NOT_CONSUMABLE" });
  });

  it("fails closed across principals, expiry, brute force, and revocation", async () => {
    const begun = await challenge();
    if (!begun.ok) throw new Error(begun.code);
    expect(
      await confirmPairing(env.VILLAGE_DB, {
        principalId: otherPrincipalId,
        pairingId: begun.pairingId,
        now,
      }),
    ).toEqual({ ok: false, code: "PAIRING_NOT_CONFIRMABLE" });
    await confirmPairing(env.VILLAGE_DB, {
      principalId,
      pairingId: begun.pairingId,
      now,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await consumePairing(env.VILLAGE_DB, {
          principalId,
          pairingId: begun.pairingId,
          secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          now,
        }),
      ).toEqual({ ok: false, code: "PAIRING_SECRET_REJECTED" });
    }
    expect(
      await consumePairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        secret: begun.secret,
        now,
      }),
    ).toEqual({ ok: false, code: "PAIRING_NOT_CONSUMABLE" });

    const second = await challenge();
    if (!second.ok) throw new Error(second.code);
    expect(
      await confirmPairing(env.VILLAGE_DB, {
        principalId,
        pairingId: second.pairingId,
        now: "2026-08-12T18:06:00.000Z",
      }),
    ).toEqual({ ok: false, code: "PAIRING_NOT_CONFIRMABLE" });

    const third = await beginPairing(env.VILLAGE_DB, {
      principalId,
      deviceId: "dev_01J00000000000000000000001",
      deviceDisplayName: "Replacement",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "cmVwbGFjZW1lbnQ" },
      protection: "OS_PROTECTED_FALLBACK",
      now,
    });
    if (!third.ok) throw new Error(third.code);
    await confirmPairing(env.VILLAGE_DB, {
      principalId,
      pairingId: third.pairingId,
      now,
    });
    await consumePairing(env.VILLAGE_DB, {
      principalId,
      pairingId: third.pairingId,
      secret: third.secret,
      now,
    });
    expect(
      await rotateDeviceCredential(env.VILLAGE_DB, {
        principalId,
        deviceId: "dev_01J00000000000000000000001",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "cm90YXRlZA" },
        now,
      }),
    ).toEqual({ ok: true });
    const rotated = await env.VILLAGE_DB.prepare(
      `SELECT public_key, credential_generation FROM devices
       WHERE principal_id = ? AND device_id = ?`,
    )
      .bind(principalId, "dev_01J00000000000000000000001")
      .first<{ public_key: string; credential_generation: number }>();
    expect(rotated).toMatchObject({ credential_generation: 2 });
    expect(JSON.parse(rotated!.public_key)).toMatchObject({ x: "cm90YXRlZA" });
    expect(
      await revokeDevice(
        env.VILLAGE_DB,
        principalId,
        "dev_01J00000000000000000000001",
        now,
      ),
    ).toEqual({ ok: true });

    const rejected = await beginPairing(env.VILLAGE_DB, {
      principalId,
      deviceId: "dev_01J00000000000000000000002",
      deviceDisplayName: "Rejected host",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "cmVqZWN0ZWQ" },
      protection: "HARDWARE_NON_EXPORTABLE",
      now,
    });
    if (!rejected.ok) throw new Error(rejected.code);
    expect(
      await rejectPairing(env.VILLAGE_DB, {
        principalId,
        pairingId: rejected.pairingId,
        now,
      }),
    ).toEqual({ ok: true });
    expect(
      await confirmPairing(env.VILLAGE_DB, {
        principalId,
        pairingId: rejected.pairingId,
        now,
      }),
    ).toEqual({ ok: false, code: "PAIRING_NOT_CONFIRMABLE" });
  });
});
