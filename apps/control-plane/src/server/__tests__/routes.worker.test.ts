import { env } from "cloudflare:workers";
import { SELF, applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalCommandEnvelopeBytes,
  signedCommandEnvelopeSchema,
  type BrowserControlState,
  type UnsignedCommandEnvelope,
} from "@village/contracts";
import { authenticateRequest } from "../auth.js";

const principalId = "prn_01J00000000000000000000000";
const otherPrincipalId = "prn_01J00000000000000000000001";
const csrf = "csrf_csrf_csrf_csrf_csrf_csrf_1234";
const pairingSecret = "a".repeat(43);

async function hashSecret(secret: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  ).toString("base64url");
}

const ownerHeaders = {
  "content-type": "application/json",
  origin: "http://localhost:5173",
  cookie: `village_csrf=${csrf}`,
  "x-village-csrf": csrf,
  "x-village-development-principal": principalId,
};

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
});

describe("authenticated pairing routes", () => {
  it("creates and reads owner-scoped durable jobs", async () => {
    const created = await SELF.fetch(
      new Request("https://village.test/api/jobs", {
        method: "POST",
        headers: ownerHeaders,
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ jobId: string }>();
    const listed = await SELF.fetch(
      new Request("https://village.test/api/jobs", { headers: ownerHeaders }),
    );
    await expect(listed.json()).resolves.toMatchObject({
      ok: true,
      jobs: [{ jobId: createdBody.jobId, state: "QUEUED", version: 1 }],
    });
    const foreignRead = await SELF.fetch(
      new Request(`https://village.test/api/jobs/${createdBody.jobId}`, {
        headers: {
          ...ownerHeaders,
          "x-village-development-principal": otherPrincipalId,
        },
      }),
    );
    expect(foreignRead.status).toBe(404);
  });

  it("binds one active device and one coordinator to an owner job", async () => {
    const created = await SELF.fetch(
      new Request("https://village.test/api/jobs", {
        method: "POST",
        headers: ownerHeaders,
      }),
    );
    const { jobId } = await created.json<{ jobId: string }>();
    const deviceId = "dev_01J00000000000000000000004";
    const browserSessionId = "brs_01J00000000000000000000004";
    await env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    )
      .bind(principalId, deviceId, new Date().toISOString())
      .run();
    const session = await SELF.fetch(
      new Request(`https://village.test/api/jobs/${jobId}/browser-sessions`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          deviceId,
          browserSessionId,
          hostId: "hst_01J00000000000000000000004",
          site: "OWNED_FIXTURE",
        }),
      }),
    );
    expect(session.status).toBe(201);
    await expect(session.json()).resolves.toEqual({
      ok: true,
      browserSessionId,
    });
    const job = await SELF.fetch(
      new Request(`https://village.test/api/jobs/${jobId}`, {
        headers: ownerHeaders,
      }),
    );
    await expect(job.json()).resolves.toMatchObject({
      ok: true,
      job: { state: "WAITING_FOR_BROWSER", browserSessionId, version: 2 },
    });
    expect(
      await env.BROWSER_SESSION_COORDINATOR.getByName(
        browserSessionId,
      ).snapshot(principalId),
    ).toMatchObject({ ok: true, eventSequence: 1 });
  });

  it("rejects CSRF and exact-origin violations", async () => {
    const body = JSON.stringify({
      deviceId: "dev_01J00000000000000000000000",
      deviceDisplayName: "Andrew's Mac",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" },
      protection: "HARDWARE_NON_EXPORTABLE",
      secretHash: await hashSecret(pairingSecret),
    });
    const missing = await SELF.fetch(
      new Request("https://village.test/api/pairing/challenges", {
        method: "POST",
        headers: {
          ...ownerHeaders,
          "x-village-csrf": "missing",
        },
        body,
      }),
    );
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toMatchObject({
      code: "CSRF_DENIED",
    });

    const crossOrigin = await SELF.fetch(
      new Request("https://village.test/api/pairing/challenges", {
        method: "POST",
        headers: { ...ownerHeaders, origin: "https://evil.example" },
        body,
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("binds confirmation and revocation to the authenticated owner", async () => {
    const begunResponse = await SELF.fetch(
      new Request("https://village.test/api/pairing/challenges", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          deviceId: "dev_01J00000000000000000000000",
          deviceDisplayName: "Andrew's Mac",
          publicKey: { kty: "OKP", crv: "Ed25519", x: "cHVibGljX2tleQ" },
          protection: "HARDWARE_NON_EXPORTABLE",
          secretHash: await hashSecret(pairingSecret),
        }),
      }),
    );
    expect(begunResponse.status).toBe(201);
    const begun = await begunResponse.json<{
      pairingId: string;
    }>();

    const wrongOwner = await SELF.fetch(
      new Request(
        `https://village.test/api/pairing/${begun.pairingId}/confirm`,
        {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "x-village-development-principal": otherPrincipalId,
          },
        },
      ),
    );
    expect(wrongOwner.status).toBe(409);

    const confirmed = await SELF.fetch(
      new Request(
        `https://village.test/api/pairing/${begun.pairingId}/confirm`,
        { method: "POST", headers: ownerHeaders },
      ),
    );
    expect(confirmed.status).toBe(200);

    const confirmedStatus = await SELF.fetch(
      new Request(`https://village.test/api/pairing/${begun.pairingId}`, {
        headers: ownerHeaders,
      }),
    );
    await expect(confirmedStatus.json()).resolves.toMatchObject({
      ok: true,
      pairing: {
        principalId,
        pairingId: begun.pairingId,
        state: "CONFIRMED",
      },
    });

    const consumed = await SELF.fetch(
      new Request(
        `https://village.test/api/pairing/${begun.pairingId}/consume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principalId, secret: pairingSecret }),
        },
      ),
    );
    expect(consumed.status).toBe(200);

    const consumedStatus = await SELF.fetch(
      new Request(`https://village.test/api/pairing/${begun.pairingId}`, {
        headers: ownerHeaders,
      }),
    );
    await expect(consumedStatus.json()).resolves.toMatchObject({
      ok: true,
      pairing: { state: "CONSUMED" },
    });

    const wrongRevoke = await SELF.fetch(
      new Request(
        "https://village.test/api/devices/dev_01J00000000000000000000000",
        {
          method: "DELETE",
          headers: {
            ...ownerHeaders,
            "x-village-development-principal": otherPrincipalId,
          },
        },
      ),
    );
    expect(wrongRevoke.status).toBe(404);
    const revoked = await SELF.fetch(
      new Request(
        "https://village.test/api/devices/dev_01J00000000000000000000000",
        { method: "DELETE", headers: ownerHeaders },
      ),
    );
    expect(revoked.status).toBe(200);
  });

  it("fails closed when insecure auth is selected outside development", async () => {
    expect(
      await authenticateRequest(
        new Request("https://village.test", {
          headers: { "x-village-development-principal": principalId },
        }),
        {
          ...env,
          VILLAGE_AUTH_MODE: "development-header",
          VILLAGE_ENVIRONMENT: "production",
        },
      ),
    ).toEqual({ ok: false, code: "INSECURE_AUTH_MODE_DISABLED" });
    expect(
      await authenticateRequest(new Request("https://village.test"), {
        ...env,
        VILLAGE_AUTH_MODE: "cloudflare-access",
        VILLAGE_ENVIRONMENT: "production",
      }),
    ).toEqual({ ok: false, code: "UNAUTHENTICATED" });
  });

  it("authenticates a connector claim and keeps event cursors owner-scoped", async () => {
    const deviceId = "dev_01J00000000000000000000002" as const;
    const jobId = "job_01J00000000000000000000002" as const;
    const browserSessionId = "brs_01J00000000000000000000002" as const;
    const actionId = "act_01J00000000000000000000002" as const;
    const now = new Date();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30_000).toISOString();
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
      ).bind(principalId, issuedAt),
      env.VILLAGE_DB.prepare(
        `INSERT INTO devices
         (principal_id, device_id, public_key, credential_status, protocol_version,
          last_accepted_sequence, created_at) VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
      ).bind(principalId, deviceId, JSON.stringify(publicKey), issuedAt),
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
         VALUES (?, ?, 'WAITING_FOR_BROWSER', 1, 1, ?, ?)`,
      ).bind(principalId, jobId, issuedAt, issuedAt),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000002', 'OWNED_FIXTURE',
                 'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
      ).bind(principalId, browserSessionId, jobId, deviceId, issuedAt),
    ]);
    const initial: BrowserControlState = {
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      controller: "NONE",
      connection: "ONLINE",
      leaseEpoch: 0,
      leaseExpiresAt: null,
      lastAcceptedSequence: 0,
      automationBlocked: true,
      takeover: "NONE",
      profile: "PRESENT",
    };
    await env.BROWSER_SESSION_COORDINATOR.getByName(
      browserSessionId,
    ).initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: issuedAt,
      control: initial,
    });
    const unsigned: UnsignedCommandEnvelope = {
      protocolVersion: 1,
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      actionId,
      leaseEpoch: 1,
      sequence: 1,
      issuedAt,
      expiresAt,
      command: { capability: "SESSION_OPEN", site: "OWNED_FIXTURE" },
    };
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalCommandEnvelopeBytes(unsigned),
    );
    const envelope = signedCommandEnvelopeSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const connectRequest = () =>
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/connect`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-route",
          },
          body: JSON.stringify(envelope),
        },
      );
    const connected = await SELF.fetch(connectRequest());
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toMatchObject({
      ok: true,
      leaseEpoch: 1,
    });
    const replayed = await SELF.fetch(connectRequest());
    expect(replayed.status).toBe(409);

    const ownerEvents = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/events?cursor=0`,
        { headers: ownerHeaders },
      ),
    );
    expect(ownerEvents.status).toBe(200);
    await expect(ownerEvents.json()).resolves.toMatchObject({
      ok: true,
      events: [{ sequence: 1 }, { sequence: 2 }],
    });
    const foreignEvents = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/events?cursor=0`,
        {
          headers: {
            ...ownerHeaders,
            "x-village-development-principal": otherPrincipalId,
          },
        },
      ),
    );
    expect(foreignEvents.status).toBe(400);
  });
});
