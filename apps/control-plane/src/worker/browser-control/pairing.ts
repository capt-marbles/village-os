import {
  deviceCredentialSchema,
  deviceIdSchema,
  instantSchema,
  pairingIdSchema,
  principalIdSchema,
} from "@village/contracts";
import { z } from "zod";

const publicKeySchema = deviceCredentialSchema.shape.publicKey;

const beginPairingSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  deviceDisplayName: z.string().trim().min(1).max(80),
  publicKey: publicKeySchema,
  protection: z.enum(["HARDWARE_NON_EXPORTABLE", "OS_PROTECTED_FALLBACK"]),
  secretHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  now: instantSchema,
});

const pairingOperationSchema = z.strictObject({
  principalId: principalIdSchema,
  pairingId: pairingIdSchema,
  now: instantSchema,
});

const consumePairingSchema = pairingOperationSchema.extend({
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const rotateCredentialSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  publicKey: publicKeySchema,
  now: instantSchema,
});

type PairingRow = {
  principal_id: string;
  pairing_id: string;
  device_id: string;
  public_key_json: string;
  device_display_name: string;
  fingerprint: string;
  protection: "HARDWARE_NON_EXPORTABLE" | "OS_PROTECTED_FALLBACK";
  secret_hash: string;
  attempts_remaining: number;
  state:
    "PENDING_CONFIRMATION" | "CONFIRMED" | "EXPIRED" | "REJECTED" | "CONSUMED";
  expires_at: string;
};

export async function getPairingStatus(db: D1Database, candidate: unknown) {
  const parsed = pairingOperationSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false as const, code: "INVALID_PAIRING_STATUS" };
  }
  const input = parsed.data;
  const row = await db
    .prepare(
      `SELECT principal_id, pairing_id, device_id, device_display_name,
              public_key_json, protection, secret_hash, fingerprint,
              attempts_remaining, state, expires_at
       FROM pairing_challenges WHERE principal_id = ? AND pairing_id = ?`,
    )
    .bind(input.principalId, input.pairingId)
    .first<PairingRow>();
  if (!row) return { ok: false as const, code: "PAIRING_NOT_FOUND" };
  let state = row.state;
  if (
    (state === "PENDING_CONFIRMATION" || state === "CONFIRMED") &&
    row.expires_at <= input.now
  ) {
    state = "EXPIRED";
    await db
      .prepare(
        `UPDATE pairing_challenges SET state = 'EXPIRED'
         WHERE principal_id = ? AND pairing_id = ?
           AND state IN ('PENDING_CONFIRMATION', 'CONFIRMED')`,
      )
      .bind(input.principalId, input.pairingId)
      .run();
  }
  return {
    ok: true as const,
    pairing: {
      principalId: row.principal_id,
      pairingId: row.pairing_id,
      deviceId: row.device_id,
      deviceDisplayName: row.device_display_name,
      fingerprint: row.fingerprint,
      attemptsRemaining: row.attempts_remaining,
      state,
      expiresAt: row.expires_at,
    },
  };
}

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(timestamp: number): string {
  let value = timestamp;
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = alphabet[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return encoded;
}

function createVillageId(prefix: "par", now: number): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  let suffix = encodeTime(now);
  for (let index = 0; index < 16; index += 1) {
    suffix += alphabet[random[index]! & 31];
  }
  return `${prefix}_${suffix}`;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function sha256(value: string): Promise<string> {
  return base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function beginPairing(db: D1Database, candidate: unknown) {
  const parsed = beginPairingSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_PAIRING_REQUEST" };
  const input = parsed.data;
  const publicKeyJson = JSON.stringify(input.publicKey);
  const fingerprint = (await sha256(publicKeyJson)).slice(0, 16).toUpperCase();
  const pairingId = pairingIdSchema.parse(
    createVillageId("par", Date.parse(input.now)),
  );
  const expiresAt = new Date(Date.parse(input.now) + 5 * 60_000).toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO pairing_challenges
         (principal_id, pairing_id, device_id, device_display_name, public_key_json,
          protection, secret_hash, fingerprint, attempts_remaining, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, 'PENDING_CONFIRMATION', ?, ?)`,
      )
      .bind(
        input.principalId,
        pairingId,
        input.deviceId,
        input.deviceDisplayName,
        publicKeyJson,
        input.protection,
        input.secretHash,
        fingerprint,
        input.now,
        expiresAt,
      )
      .run();
  } catch {
    return { ok: false as const, code: "PAIRING_CONFLICT" };
  }
  return {
    ok: true as const,
    principalId: input.principalId,
    pairingId,
    fingerprint,
    expiresAt,
  };
}

export async function confirmPairing(db: D1Database, candidate: unknown) {
  const parsed = pairingOperationSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_PAIRING_CONFIRMATION" };
  const input = parsed.data;
  const result = await db
    .prepare(
      `UPDATE pairing_challenges
       SET state = 'CONFIRMED', confirmed_at = ?
       WHERE principal_id = ? AND pairing_id = ?
         AND state = 'PENDING_CONFIRMATION' AND expires_at > ?`,
    )
    .bind(input.now, input.principalId, input.pairingId, input.now)
    .run();
  return result.meta.changes === 1
    ? { ok: true as const }
    : { ok: false as const, code: "PAIRING_NOT_CONFIRMABLE" };
}

export async function rejectPairing(db: D1Database, candidate: unknown) {
  const parsed = pairingOperationSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_PAIRING_REJECTION" };
  const input = parsed.data;
  const result = await db
    .prepare(
      `UPDATE pairing_challenges SET state = 'REJECTED'
       WHERE principal_id = ? AND pairing_id = ?
         AND state IN ('PENDING_CONFIRMATION', 'CONFIRMED')`,
    )
    .bind(input.principalId, input.pairingId)
    .run();
  return result.meta.changes === 1
    ? { ok: true as const }
    : { ok: false as const, code: "PAIRING_NOT_REJECTABLE" };
}

export async function consumePairing(db: D1Database, candidate: unknown) {
  const parsed = consumePairingSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_PAIRING_CONSUMPTION" };
  const input = parsed.data;
  const row = await db
    .prepare(
      `SELECT principal_id, pairing_id, device_id, device_display_name,
              public_key_json, protection, secret_hash, fingerprint,
              attempts_remaining, state, expires_at
       FROM pairing_challenges WHERE principal_id = ? AND pairing_id = ?`,
    )
    .bind(input.principalId, input.pairingId)
    .first<PairingRow>();
  if (!row || row.state !== "CONFIRMED" || row.expires_at <= input.now) {
    if (row?.state === "CONFIRMED" && row.expires_at <= input.now) {
      await db
        .prepare(
          `UPDATE pairing_challenges SET state = 'EXPIRED'
           WHERE principal_id = ? AND pairing_id = ? AND state = 'CONFIRMED'`,
        )
        .bind(input.principalId, input.pairingId)
        .run();
    }
    return { ok: false as const, code: "PAIRING_NOT_CONSUMABLE" };
  }
  const suppliedHash = await sha256(input.secret);
  if (!constantTimeEqual(row.secret_hash, suppliedHash)) {
    await db
      .prepare(
        `UPDATE pairing_challenges
         SET attempts_remaining = MAX(0, attempts_remaining - 1),
             state = CASE WHEN attempts_remaining <= 1 THEN 'REJECTED' ELSE state END
         WHERE principal_id = ? AND pairing_id = ? AND state = 'CONFIRMED'`,
      )
      .bind(input.principalId, input.pairingId)
      .run();
    return { ok: false as const, code: "PAIRING_SECRET_REJECTED" };
  }

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO devices
           (principal_id, device_id, public_key, credential_status, protocol_version,
            last_accepted_sequence, created_at)
           VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
        )
        .bind(input.principalId, row.device_id, row.public_key_json, input.now),
      db
        .prepare(
          `UPDATE pairing_challenges SET state = 'CONSUMED', consumed_at = ?
           WHERE principal_id = ? AND pairing_id = ? AND state = 'CONFIRMED'`,
        )
        .bind(input.now, input.principalId, input.pairingId),
    ]);
  } catch {
    return { ok: false as const, code: "DEVICE_CREDENTIAL_CONFLICT" };
  }
  return { ok: true as const, deviceId: row.device_id };
}

export async function rotateDeviceCredential(
  db: D1Database,
  candidate: unknown,
) {
  const parsed = rotateCredentialSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_CREDENTIAL_ROTATION" };
  const input = parsed.data;
  const result = await db
    .prepare(
      `UPDATE devices
       SET public_key = ?, protocol_version = 1, last_accepted_sequence = 0,
           credential_generation = credential_generation + 1, rotated_at = ?
       WHERE principal_id = ? AND device_id = ? AND credential_status = 'ACTIVE'`,
    )
    .bind(
      JSON.stringify(input.publicKey),
      input.now,
      input.principalId,
      input.deviceId,
    )
    .run();
  return result.meta.changes === 1
    ? { ok: true as const }
    : { ok: false as const, code: "DEVICE_NOT_ACTIVE" };
}

export async function revokeDevice(
  db: D1Database,
  principalId: unknown,
  deviceId: unknown,
  now: unknown,
) {
  const parsed = z
    .strictObject({
      principalId: principalIdSchema,
      deviceId: deviceIdSchema,
      now: instantSchema,
    })
    .safeParse({ principalId, deviceId, now });
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_REVOCATION" };
  const result = await db
    .prepare(
      `UPDATE devices SET credential_status = 'REVOKED', revoked_at = ?
       WHERE principal_id = ? AND device_id = ? AND credential_status = 'ACTIVE'`,
    )
    .bind(parsed.data.now, parsed.data.principalId, parsed.data.deviceId)
    .run();
  return result.meta.changes === 1
    ? { ok: true as const }
    : { ok: false as const, code: "DEVICE_NOT_ACTIVE" };
}
