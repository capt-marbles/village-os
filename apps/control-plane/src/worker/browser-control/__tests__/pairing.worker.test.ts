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
const pairingSecret = "a".repeat(43);

async function hashSecret(secret: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  ).toString("base64url");
}

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
    publicKey: {
      kty: "EC",
      crv: "P-256",
      x: "a".repeat(43),
      y: "b".repeat(43),
    },
    protection: "HARDWARE_NON_EXPORTABLE",
    secretHash: await hashSecret(pairingSecret),
    now,
  });
}

describe("device pairing", () => {
  it("rejects a public key whose declared protection does not match", async () => {
    await expect(
      beginPairing(env.VILLAGE_DB, {
        principalId,
        deviceId,
        deviceDisplayName: "Andrew's Mac",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" },
        protection: "HARDWARE_NON_EXPORTABLE",
        secretHash: await hashSecret(pairingSecret),
        now,
      }),
    ).resolves.toEqual({ ok: false, code: "INVALID_PAIRING_REQUEST" });
  });

  it("requires owner confirmation and consumes the high-entropy secret once", async () => {
    const begun = await challenge();
    if (!begun.ok) throw new Error(begun.code);
    expect(
      await consumePairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        secret: pairingSecret,
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
        secret: pairingSecret,
        now,
      }),
    ).toEqual({ ok: true, deviceId });
    await expect(
      env.VILLAGE_DB.prepare(
        `SELECT algorithm, credential_protection AS protection
         FROM devices WHERE principal_id = ? AND device_id = ?`,
      )
        .bind(principalId, deviceId)
        .first(),
    ).resolves.toEqual({
      algorithm: "ES256",
      protection: "HARDWARE_NON_EXPORTABLE",
    });
    expect(
      await consumePairing(env.VILLAGE_DB, {
        principalId,
        pairingId: begun.pairingId,
        secret: pairingSecret,
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
        secret: pairingSecret,
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
      secretHash: await hashSecret(pairingSecret),
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
      secret: pairingSecret,
      now,
    });
    expect(
      await rotateDeviceCredential(env.VILLAGE_DB, {
        principalId,
        deviceId: "dev_01J00000000000000000000001",
        publicKey: { kty: "OKP", crv: "Ed25519", x: "cm90YXRlZA" },
        protection: "OS_PROTECTED_FALLBACK",
        now,
      }),
    ).toEqual({ ok: true });
    const rotated = await env.VILLAGE_DB.prepare(
      `SELECT public_key, algorithm, credential_protection, credential_generation FROM devices
       WHERE principal_id = ? AND device_id = ?`,
    )
      .bind(principalId, "dev_01J00000000000000000000001")
      .first<{
        public_key: string;
        algorithm: string;
        credential_protection: string;
        credential_generation: number;
      }>();
    expect(rotated).toMatchObject({
      algorithm: "Ed25519",
      credential_protection: "OS_PROTECTED_FALLBACK",
      credential_generation: 2,
    });
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
      protection: "OS_PROTECTED_FALLBACK",
      secretHash: await hashSecret(pairingSecret),
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
