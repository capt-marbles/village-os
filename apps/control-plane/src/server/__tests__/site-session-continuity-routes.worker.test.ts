import { env } from "cloudflare:workers";
import { SELF, applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRevisionAssociatedData,
  canonicalContinuityRevisionBytes,
  continuityRevisionDigestBytes,
} from "@village/contracts";

const principalId = "prn_01J00000000000000000000000";
const otherPrincipalId = "prn_01J00000000000000000000009";
const grantId = "cgr_01J00000000000000000000000";
const sourceDeviceId = "dev_01J00000000000000000000001";
const destinationDeviceId = "dev_01J00000000000000000000002";
const sourceBrowserSessionId = "brs_01J00000000000000000000001";
const destinationBrowserSessionId = "brs_01J00000000000000000000002";
const csrf = "csrf_csrf_csrf_csrf_csrf_csrf_1234";

const ownerHeaders = {
  "content-type": "application/json",
  origin: "http://localhost:5173",
  cookie: `village_csrf=${csrf}`,
  "x-village-csrf": csrf,
  "x-village-development-principal": principalId,
};

let sourceKeys: CryptoKeyPair;
let destinationKeys: CryptoKeyPair;
let issuedAt: string;
let requestExpiresAt: string;
let revisionExpiresAt: string;
let grantExpiresAt: string;

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "DELETE FROM continuity_grants WHERE principal_id = ?",
    ).bind(principalId),
    env.VILLAGE_DB.prepare(
      "DELETE FROM browser_sessions WHERE principal_id = ?",
    ).bind(principalId),
    env.VILLAGE_DB.prepare("DELETE FROM jobs WHERE principal_id = ?").bind(
      principalId,
    ),
    env.VILLAGE_DB.prepare("DELETE FROM devices WHERE principal_id = ?").bind(
      principalId,
    ),
    env.VILLAGE_DB.prepare(
      "DELETE FROM principals WHERE principal_id = ?",
    ).bind(principalId),
  ]);
  sourceKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  destinationKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  issuedAt = new Date(Date.now() - 1_000).toISOString();
  requestExpiresAt = new Date(Date.now() + 30_000).toISOString();
  revisionExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  grantExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await seedEligiblePair();
});

describe("Site Session continuity routes", () => {
  it("moves only signed ciphertext between an owner's paired Macs and keeps a deletion tombstone", async () => {
    const [created, concurrentReplay] = await Promise.all([
      createGrant(),
      createGrant(),
    ]);
    expect([created.status, concurrentReplay.status]).toEqual([201, 201]);
    await expect(created.json()).resolves.toMatchObject({
      ok: true,
      grant: { grantId, state: "ACTIVE" },
    });
    await expect(concurrentReplay.json()).resolves.toMatchObject({
      ok: true,
      grant: { grantId, state: "ACTIVE" },
    });
    await expect((await createGrant()).json()).resolves.toMatchObject({
      ok: true,
      created: false,
      grant: { grantId, state: "ACTIVE" },
    });

    const revision = await signedRevision();
    expect(
      (
        await devicePost("revisions", {
          ...revision,
          signature: "e".repeat(86),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await devicePost("revisions", {
          ...revision,
          principalId: otherPrincipalId,
        })
      ).status,
    ).toBe(404);
    const published = await devicePost("revisions", revision);
    expect(published.status).toBe(201);
    await expect(published.json()).resolves.toEqual({
      ok: true,
      stored: true,
    });
    await expect(
      (await devicePost("revisions", revision)).json(),
    ).resolves.toEqual({
      ok: true,
      stored: false,
    });

    const expiredFetch = await signedFetch(1, {
      issuedAt: new Date(Date.now() - 30_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    expect((await devicePost("fetch", expiredFetch)).status).toBe(409);

    const fetched = await devicePost("fetch", await signedFetch());
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toEqual({ ok: true, revision });

    const acknowledged = await devicePost(
      "acknowledgements",
      await signedAcknowledgement(revision.digest),
    );
    expect(acknowledged.status).toBe(200);
    await expect(acknowledged.json()).resolves.toEqual({
      ok: true,
      acknowledged: true,
    });

    const foreignRead = await SELF.fetch(
      new Request(
        `https://village.test/api/site-session-continuity/grants/${grantId}`,
        {
          headers: {
            ...ownerHeaders,
            "x-village-development-principal": otherPrincipalId,
          },
        },
      ),
    );
    expect(foreignRead.status).toBe(404);

    const revoked = await SELF.fetch(
      new Request(
        `https://village.test/api/site-session-continuity/grants/${grantId}/revoke`,
        { method: "POST", headers: ownerHeaders },
      ),
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({
      ok: true,
      revoked: true,
    });
    expect((await devicePost("fetch", await signedFetch(3))).status).toBe(404);

    const deleted = await SELF.fetch(
      new Request(
        `https://village.test/api/site-session-continuity/grants/${grantId}`,
        { method: "DELETE", headers: ownerHeaders },
      ),
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    const tombstone = await env.VILLAGE_DB.prepare(
      `SELECT state, destination_encryption_public_key, source_signing_public_key
       FROM continuity_grants WHERE principal_id = ? AND grant_id = ?`,
    )
      .bind(principalId, grantId)
      .first<{
        state: string;
        destination_encryption_public_key: string | null;
        source_signing_public_key: string | null;
      }>();
    expect(tombstone).toEqual({
      state: "DELETED",
      destination_encryption_public_key: null,
      source_signing_public_key: null,
    });
    expect(JSON.stringify(tombstone)).not.toContain(revision.ciphertext);
    expect((await devicePost("fetch", await signedFetch(4))).status).toBe(404);
  });

  it("revokes a mailbox when either pinned device credential changes", async () => {
    const rotatedGrantId = "cgr_01J00000000000000000000003";
    expect((await createGrant(rotatedGrantId)).status).toBe(201);
    expect(
      (
        await devicePost(
          "revisions",
          await signedRevision(rotatedGrantId),
          rotatedGrantId,
        )
      ).status,
    ).toBe(201);
    await env.VILLAGE_DB.prepare(
      "UPDATE devices SET public_key = ? WHERE principal_id = ? AND device_id = ?",
    )
      .bind(
        JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "z".repeat(43) }),
        principalId,
        destinationDeviceId,
      )
      .run();

    const denied = await devicePost(
      "fetch",
      await signedFetch(1, {}, rotatedGrantId),
      rotatedGrantId,
    );
    expect(denied.status).toBe(409);
    await expect(denied.json()).resolves.toMatchObject({
      ok: false,
      code: "DEVICE_CREDENTIAL_CHANGED",
    });
    await expect(
      env.VILLAGE_DB.prepare(
        "SELECT state FROM continuity_grants WHERE principal_id = ? AND grant_id = ?",
      )
        .bind(principalId, rotatedGrantId)
        .first(),
    ).resolves.toEqual({ state: "REVOKED" });
  });
});

function createGrant(requestedGrantId = grantId) {
  return SELF.fetch(
    new Request("https://village.test/api/site-session-continuity/grants", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        grantId: requestedGrantId,
        sourceDeviceId,
        destinationDeviceId,
        sourceBrowserSessionId,
        destinationBrowserSessionId,
        site: "OWNED_FIXTURE",
        destinationEncryptionPublicKey: {
          kty: "OKP",
          crv: "X25519",
          x: "a".repeat(43),
        },
        expiresAt: grantExpiresAt,
      }),
    }),
  );
}

async function seedEligiblePair() {
  const now = "2026-08-15T18:00:00.000Z";
  const sourcePublicKey = await publicJwk(sourceKeys.publicKey);
  const destinationPublicKey = await publicJwk(destinationKeys.publicKey);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "INSERT INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principalId, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
    ).bind(principalId, sourceDeviceId, JSON.stringify(sourcePublicKey), now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
    ).bind(
      principalId,
      destinationDeviceId,
      JSON.stringify(destinationPublicKey),
      now,
    ),
    ...(
      [
        [
          "job_01J00000000000000000000001",
          sourceBrowserSessionId,
          sourceDeviceId,
        ],
        [
          "job_01J00000000000000000000002",
          destinationBrowserSessionId,
          destinationDeviceId,
        ],
      ] as const
    ).flatMap(([jobId, browserSessionId, deviceId]) => [
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, browser_session_id, state, version,
          last_event_sequence, created_at, updated_at)
         VALUES (?, ?, ?, 'WAITING_FOR_BROWSER', 1, 1, ?, ?)`,
      ).bind(principalId, jobId, browserSessionId, now, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, ?, 'OWNED_FIXTURE', 'NONE', 'ONLINE', 0, 0, 1,
                 'NONE', 'PRESENT', ?)`,
      ).bind(
        principalId,
        browserSessionId,
        jobId,
        deviceId,
        `hst_${browserSessionId.slice(4)}`,
        now,
      ),
    ]),
  ]);
}

async function publicJwk(key: CryptoKey) {
  const exported = await crypto.subtle.exportKey("jwk", key);
  return { kty: "OKP", crv: "Ed25519", x: exported.x! };
}

function bindingFor(requestedGrantId: string) {
  return {
    principalId,
    grantId: requestedGrantId,
    sourceDeviceId,
    destinationDeviceId,
    sourceBrowserSessionId,
    destinationBrowserSessionId,
    site: "OWNED_FIXTURE" as const,
  };
}

async function signedRevision(requestedGrantId = grantId) {
  const ciphertextBytes = new TextEncoder().encode("opaque-route-ciphertext");
  const ciphertext = Buffer.from(ciphertextBytes).toString("base64url");
  const partial = {
    protocolVersion: 1 as const,
    ...bindingFor(requestedGrantId),
    revision: 1,
    previousDigest: null,
    issuedAt,
    expiresAt: revisionExpiresAt,
    ephemeralPublicKey: {
      kty: "OKP" as const,
      crv: "X25519" as const,
      x: "b".repeat(43),
    },
    salt: "c".repeat(22),
    iv: "d".repeat(16),
  };
  const digest = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      continuityRevisionDigestBytes(
        canonicalContinuityRevisionAssociatedData(partial),
        Uint8Array.from(ciphertextBytes).buffer,
      ),
    ),
  ).toString("hex");
  const unsigned = { ...partial, ciphertext, digest };
  return {
    ...unsigned,
    signature: Buffer.from(
      await crypto.subtle.sign(
        "Ed25519",
        sourceKeys.privateKey,
        canonicalContinuityRevisionBytes(unsigned),
      ),
    ).toString("base64url"),
  };
}

async function signedFetch(
  sequence = 1,
  times: { issuedAt?: string; expiresAt?: string } = {},
  requestedGrantId = grantId,
) {
  const unsigned = {
    protocolVersion: 1 as const,
    ...bindingFor(requestedGrantId),
    sequence,
    afterRevision: 0,
    issuedAt: times.issuedAt ?? issuedAt,
    expiresAt: times.expiresAt ?? requestExpiresAt,
  };
  return {
    ...unsigned,
    signature: Buffer.from(
      await crypto.subtle.sign(
        "Ed25519",
        destinationKeys.privateKey,
        canonicalContinuityFetchBytes(unsigned),
      ),
    ).toString("base64url"),
  };
}

async function signedAcknowledgement(digest: string) {
  const unsigned = {
    protocolVersion: 1 as const,
    ...bindingFor(grantId),
    sequence: 2,
    revision: 1,
    digest,
    issuedAt,
    expiresAt: requestExpiresAt,
  };
  return {
    ...unsigned,
    signature: Buffer.from(
      await crypto.subtle.sign(
        "Ed25519",
        destinationKeys.privateKey,
        canonicalContinuityAcknowledgementBytes(unsigned),
      ),
    ).toString("base64url"),
  };
}

function devicePost(
  operation: string,
  body: unknown,
  requestedGrantId = grantId,
) {
  return SELF.fetch(
    new Request(
      `https://village.test/api/site-session-continuity/grants/${requestedGrantId}/${operation}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}
