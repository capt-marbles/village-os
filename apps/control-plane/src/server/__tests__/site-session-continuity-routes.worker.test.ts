import { env } from "cloudflare:workers";
import { SELF, applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalContinuityActivationRequestBytes,
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRecipientKeyEnrollmentBytes,
  canonicalContinuityRevisionAssociatedData,
  canonicalContinuityRevisionBytes,
  continuityRevisionDigestBytes,
} from "@village/contracts";

const principalId = "prn_01J00000000000000000000000";
const otherPrincipalId = "prn_01J00000000000000000000009";
const grantId = "cgr_01J00000000000000000000000";
const activationGrantId = "cgr_01J00000000000000000000008";
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
      "DELETE FROM continuity_recipient_keys WHERE principal_id = ?",
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
  it("returns active grant material only to its signed source and destination", async () => {
    expect((await enrollDestinationKey()).status).toBe(201);
    expect((await createGrant(activationGrantId)).status).toBe(201);

    const sourceActivation = await activationPost(
      await signedActivation(
        sourceDeviceId,
        sourceBrowserSessionId,
        sourceKeys.privateKey,
      ),
    );
    expect(sourceActivation.status).toBe(200);
    await expect(sourceActivation.json()).resolves.toMatchObject({
      ok: true,
      activations: [
        {
          role: "SOURCE",
          binding: bindingFor(activationGrantId),
          destinationEncryptionPublicKey: {
            kty: "OKP",
            crv: "X25519",
            x: "a".repeat(43),
          },
        },
      ],
    });

    const destinationActivation = await activationPost(
      await signedActivation(
        destinationDeviceId,
        destinationBrowserSessionId,
        destinationKeys.privateKey,
      ),
    );
    expect(destinationActivation.status).toBe(200);
    const destinationBody = await destinationActivation.json();
    expect(destinationBody).toMatchObject({
      ok: true,
      activations: [
        {
          role: "DESTINATION",
          binding: bindingFor(activationGrantId),
        },
      ],
    });
    expect(JSON.stringify(destinationBody)).not.toContain(
      "destinationEncryptionPublicKey",
    );
    expect(
      (
        await activationPost(
          await signedActivation(
            sourceDeviceId,
            sourceBrowserSessionId,
            sourceKeys.privateKey,
          ),
        )
      ).status,
    ).toBe(409);
  });

  it("moves only signed ciphertext between an owner's paired Macs and keeps a deletion tombstone", async () => {
    const beforeEnrollment = await createGrant();
    expect(beforeEnrollment.status).toBe(409);
    await expect(beforeEnrollment.json()).resolves.toMatchObject({
      ok: false,
      code: "CONTINUITY_RECIPIENT_KEY_NOT_ENROLLED",
    });
    expect((await enrollDestinationKey("z".repeat(86))).status).toBe(409);
    const enrolled = await enrollDestinationKey();
    expect(enrolled.status).toBe(201);
    await expect(enrolled.json()).resolves.toMatchObject({
      ok: true,
      enrolled: true,
      deviceId: destinationDeviceId,
      browserSessionId: destinationBrowserSessionId,
    });
    const setup = await SELF.fetch(
      new Request("https://village.test/api/site-session-continuity/setup", {
        headers: ownerHeaders,
      }),
    );
    expect(setup.status).toBe(200);
    const setupBody = await setup.json();
    expect(setupBody).toEqual({
      ok: true,
      sessions: [
        {
          deviceId: destinationDeviceId,
          browserSessionId: destinationBrowserSessionId,
          deviceName: "Destination Mac",
          connection: "ONLINE",
          recipientKeyState: "READY",
        },
        {
          deviceId: sourceDeviceId,
          browserSessionId: sourceBrowserSessionId,
          deviceName: "Source Mac",
          connection: "ONLINE",
          recipientKeyState: "MISSING",
        },
      ],
      grants: [],
    });
    expect(JSON.stringify(setupBody)).not.toContain("publicKey");
    expect(JSON.stringify(setupBody)).not.toContain("a".repeat(43));
    await expect((await enrollDestinationKey()).json()).resolves.toMatchObject({
      ok: true,
      enrolled: false,
    });
    const rotatedRecipientKey = await enrollDestinationKey(undefined, {
      sequence: 2,
      encryptionPublicKey: {
        kty: "OKP",
        crv: "X25519",
        x: "q".repeat(43),
      },
    });
    expect(rotatedRecipientKey.status).toBe(409);
    await expect(rotatedRecipientKey.json()).resolves.toMatchObject({
      ok: false,
      code: "CONTINUITY_RECIPIENT_KEY_CONFLICT",
    });

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
    const protectedRecipientKey = await SELF.fetch(
      new Request(
        "https://village.test/api/site-session-continuity/recipient-keys/revoke",
        {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({
            deviceId: destinationDeviceId,
            browserSessionId: destinationBrowserSessionId,
            site: "OWNED_FIXTURE",
          }),
        },
      ),
    );
    expect(protectedRecipientKey.status).toBe(409);
    await expect(protectedRecipientKey.json()).resolves.toMatchObject({
      ok: false,
      code: "ACTIVE_CONTINUITY_GRANT_EXISTS",
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

    const ownerStatus = await SELF.fetch(
      new Request(
        `https://village.test/api/site-session-continuity/grants/${grantId}`,
        { headers: ownerHeaders },
      ),
    );
    expect(ownerStatus.status).toBe(200);
    await expect(ownerStatus.json()).resolves.toMatchObject({
      ok: true,
      grant: { grantId, state: "ACTIVE" },
      transfer: {
        state: "ACTIVE",
        publishedRevision: 1,
        appliedRevision: 1,
        pendingRevisions: 0,
      },
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
    expect((await enrollDestinationKey()).status).toBe(201);
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

  it("rejects a recipient key enrolled before device credential rotation", async () => {
    expect((await enrollDestinationKey()).status).toBe(201);
    const replacement = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    await env.VILLAGE_DB.prepare(
      "UPDATE devices SET public_key = ? WHERE principal_id = ? AND device_id = ?",
    )
      .bind(
        JSON.stringify(await publicJwk(replacement.publicKey)),
        principalId,
        destinationDeviceId,
      )
      .run();

    const response = await createGrant();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "CONTINUITY_RECIPIENT_KEY_STALE",
    });

    const revoked = await SELF.fetch(
      new Request(
        "https://village.test/api/site-session-continuity/recipient-keys/revoke",
        {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({
            deviceId: destinationDeviceId,
            browserSessionId: destinationBrowserSessionId,
            site: "OWNED_FIXTURE",
          }),
        },
      ),
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({
      ok: true,
      revoked: true,
    });
    destinationKeys = replacement;
    expect(
      (
        await enrollDestinationKey(undefined, {
          sequence: 2,
          encryptionPublicKey: {
            kty: "OKP",
            crv: "X25519",
            x: "r".repeat(43),
          },
        })
      ).status,
    ).toBe(201);
  });

  it("rejects recipient enrollment through a downgraded device protocol", async () => {
    await env.VILLAGE_DB.prepare(
      "UPDATE devices SET protocol_version = 0 WHERE principal_id = ? AND device_id = ?",
    )
      .bind(principalId, destinationDeviceId)
      .run();

    const response = await enrollDestinationKey();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "PROTOCOL_DOWNGRADE_REJECTED",
    });
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
        expiresAt: grantExpiresAt,
      }),
    }),
  );
}

async function enrollDestinationKey(
  signatureOverride?: string,
  overrides: {
    sequence?: number;
    encryptionPublicKey?: {
      kty: "OKP";
      crv: "X25519";
      x: string;
    };
  } = {},
) {
  const unsigned = {
    protocolVersion: 1 as const,
    principalId,
    deviceId: destinationDeviceId,
    browserSessionId: destinationBrowserSessionId,
    site: "OWNED_FIXTURE" as const,
    sequence: overrides.sequence ?? 1,
    issuedAt,
    expiresAt: requestExpiresAt,
    encryptionPublicKey: overrides.encryptionPublicKey ?? {
      kty: "OKP" as const,
      crv: "X25519" as const,
      x: "a".repeat(43),
    },
  };
  const signature =
    signatureOverride ??
    Buffer.from(
      await crypto.subtle.sign(
        "Ed25519",
        destinationKeys.privateKey,
        canonicalContinuityRecipientKeyEnrollmentBytes(unsigned),
      ),
    ).toString("base64url");
  return SELF.fetch(
    new Request(
      "https://village.test/api/site-session-continuity/recipient-keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...unsigned, signature }),
      },
    ),
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
        ["par_01J00000000000000000000001", sourceDeviceId, "Source Mac"],
        [
          "par_01J00000000000000000000002",
          destinationDeviceId,
          "Destination Mac",
        ],
      ] as const
    ).map(([pairingId, deviceId, deviceName]) =>
      env.VILLAGE_DB.prepare(
        `INSERT INTO pairing_challenges
         (principal_id, pairing_id, device_id, device_display_name,
          public_key_json, protection, secret_hash, fingerprint,
          attempts_remaining, state, created_at, expires_at, confirmed_at,
          consumed_at)
         VALUES (?, ?, ?, ?, '{}', 'OS_PROTECTED_FALLBACK', ?, ?, 10,
                 'CONSUMED', ?, ?, ?, ?)`,
      ).bind(
        principalId,
        pairingId,
        deviceId,
        deviceName,
        "s".repeat(43),
        "A1B2C3D4E5F60708",
        now,
        "2026-08-16T18:00:00.000Z",
        now,
        now,
      ),
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

async function signedActivation(
  deviceId: string,
  browserSessionId: string,
  privateKey: CryptoKey,
) {
  const unsigned = {
    protocolVersion: 1 as const,
    principalId,
    deviceId,
    browserSessionId,
    site: "OWNED_FIXTURE" as const,
    sequence: 1,
    issuedAt,
    expiresAt: requestExpiresAt,
  };
  return {
    ...unsigned,
    signature: Buffer.from(
      await crypto.subtle.sign(
        "Ed25519",
        privateKey,
        canonicalContinuityActivationRequestBytes(unsigned),
      ),
    ).toString("base64url"),
  };
}

function activationPost(body: unknown) {
  return SELF.fetch(
    new Request(
      "https://village.test/api/site-session-continuity/activations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}
