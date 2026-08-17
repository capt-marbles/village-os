import { env } from "cloudflare:workers";
import { SELF, applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  automationSyncRequestSchema,
  canonicalAutomationSyncRequestBytes,
  canonicalCommandEnvelopeBytes,
  canonicalWorkflowOperationRequestBytes,
  signedCommandEnvelopeSchema,
  workflowOperationRequestSchema,
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
  it("exposes the authenticated Village Identity without authentication material", async () => {
    const response = await SELF.fetch(
      new Request("https://village.test/api/identity", {
        headers: {
          "x-village-development-principal": principalId,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(
      /^village_csrf=[a-f0-9]{64}; Path=\/; Secure; SameSite=Strict; Max-Age=86400$/,
    );
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      principalId,
      provider: "DEVELOPMENT",
    });
  });

  it("preserves an existing valid browser CSRF cookie", async () => {
    const response = await SELF.fetch(
      new Request("https://village.test/api/identity", {
        headers: ownerHeaders,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

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
        body: JSON.stringify({
          objective: {
            kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
            version: 1,
          },
        }),
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
    ).toMatchObject({ ok: true, eventSequence: 2 });
    await expect(
      env.BROWSER_SESSION_COORDINATOR.getByName(
        browserSessionId,
      ).workflowSnapshot(principalId),
    ).resolves.toMatchObject({
      ok: true,
      jobRevision: 2,
      effects: [
        expect.objectContaining({
          logicalStep: "SET_DISPLAY_NAME",
          effectId: `efx_${browserSessionId.slice(4)}`,
          phase: "ACCEPTED",
        }),
      ],
    });
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

  it("binds workflow cancellation to origin, CSRF, principal, Job revision, and replay identity", async () => {
    const created = await SELF.fetch(
      new Request("https://village.test/api/jobs", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
        }),
      }),
    );
    const { jobId } = await created.json<{ jobId: string }>();
    const deviceId = "dev_01J00000000000000000000050";
    const browserSessionId = "brs_01J00000000000000000000050";
    await env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    )
      .bind(principalId, deviceId, new Date().toISOString())
      .run();
    expect(
      (
        await SELF.fetch(
          new Request(
            `https://village.test/api/jobs/${jobId}/browser-sessions`,
            {
              method: "POST",
              headers: ownerHeaders,
              body: JSON.stringify({
                deviceId,
                browserSessionId,
                hostId: "hst_01J00000000000000000000050",
                site: "OWNED_FIXTURE",
              }),
            },
          ),
        )
      ).status,
    ).toBe(201);
    const cancellation = {
      jobId,
      expectedJobRevision: 2,
      cancellationId: "cnl_01J00000000000000000000050",
    };
    const cancelUrl = `https://village.test/api/browser-sessions/${browserSessionId}/cancel`;
    const requestCancel = (
      headers: Record<string, string>,
      body = cancellation,
    ) =>
      SELF.fetch(
        new Request(cancelUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );

    const { origin: _origin, ...missingOrigin } = ownerHeaders;
    expect((await requestCancel(missingOrigin)).status).toBe(403);
    expect(
      (
        await requestCancel({
          ...ownerHeaders,
          cookie: "village_csrf=wrong",
        })
      ).status,
    ).toBe(403);
    await expect(
      requestCancel(ownerHeaders, { ...cancellation, expectedJobRevision: 1 }),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      requestCancel(ownerHeaders, {
        ...cancellation,
        jobId: "job_01J00000000000000000000051",
      }),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      requestCancel(
        {
          ...ownerHeaders,
          "x-village-development-principal": otherPrincipalId,
        },
        cancellation,
      ),
    ).resolves.toMatchObject({ status: 409 });

    const accepted = await requestCancel(ownerHeaders);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      replayed: false,
      jobRevision: 3,
    });
    const replay = await requestCancel(ownerHeaders);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      replayed: true,
      jobRevision: 3,
    });
    const race = await requestCancel(ownerHeaders, {
      ...cancellation,
      cancellationId: "cnl_01J00000000000000000000051",
    });
    await expect(race.json()).resolves.toMatchObject({
      ok: false,
      code: "STALE_JOB_REVISION",
    });

    const projected = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/project`,
        { method: "POST", headers: ownerHeaders },
      ),
    );
    expect(projected.status).toBe(200);
    const observed = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/observer?cursor=0`,
        { headers: ownerHeaders },
      ),
    );
    expect(observed.status).toBe(200);
    const observerBody = await observed.json<{
      projection: Record<string, unknown>;
    }>();
    expect(observerBody.projection).toMatchObject({
      workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
      workflowVersion: 1,
      jobState: "CANCELED",
      terminalEvidence: "CANCELLED",
      automationFenced: true,
      cancellationAcknowledgedAt: expect.any(String),
    });
    expect(Object.keys(observerBody.projection).sort()).toEqual(
      [
        "actionPhase",
        "automationFenced",
        "cancellationAcknowledgedAt",
        "connection",
        "controller",
        "cursor",
        "humanGate",
        "jobRevision",
        "jobState",
        "lastDurableUpdateAt",
        "lastEffectActor",
        "logicalStep",
        "projectionLag",
        "terminalEvidence",
        "workflowKind",
        "workflowVersion",
      ].sort(),
    );
    expect(JSON.stringify(observerBody)).not.toMatch(
      /pageText|rawUrl|selector|cookie|screenshot|profile|<script/i,
    );
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
    const syncUnsigned = {
      protocolVersion: 1 as const,
      principalId,
      deviceId,
      browserSessionId,
      connectionId: "connector-route",
      sequence: 1,
      cursor: 0,
      issuedAt,
      expiresAt,
    };
    const syncSignature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalAutomationSyncRequestBytes(syncUnsigned),
    );
    const synchronized = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/automation-sync`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-route",
          },
          body: JSON.stringify(
            automationSyncRequestSchema.parse({
              ...syncUnsigned,
              signature: Buffer.from(syncSignature).toString("base64url"),
            }),
          ),
        },
      ),
    );
    expect(synchronized.status, await synchronized.clone().text()).toBe(200);
    const renewed =
      await env.BROWSER_SESSION_COORDINATOR.getByName(
        browserSessionId,
      ).snapshot(principalId);
    expect(renewed).toMatchObject({ ok: true });
    expect(
      Date.parse(renewed.ok ? renewed.control.leaseExpiresAt! : ""),
    ).toBeGreaterThan(Date.parse(expiresAt));
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

    const coordinator =
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    expect(
      await coordinator.hostDisconnected({
        principalId,
        deviceId,
        connectionId: "connector-route",
        leaseEpoch: 1,
        now: new Date().toISOString(),
      }),
    ).toEqual({ ok: true });
    const recoveryUnsigned: UnsignedCommandEnvelope = {
      ...unsigned,
      actionId: "act_01J00000000000000000000003",
      sequence: 2,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const recoverySignature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalCommandEnvelopeBytes(recoveryUnsigned),
    );
    const recovered = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/connect`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-recovered",
          },
          body: JSON.stringify(
            signedCommandEnvelopeSchema.parse({
              ...recoveryUnsigned,
              signature: Buffer.from(recoverySignature).toString("base64url"),
            }),
          ),
        },
      ),
    );
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      ok: true,
      leaseEpoch: 2,
    });
  });

  it("returns authoritative automation fencing to a signed paired desktop", async () => {
    const deviceId = "dev_01J00000000000000000000008" as const;
    const jobId = "job_01J00000000000000000000008" as const;
    const browserSessionId = "brs_01J00000000000000000000008" as const;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
      ).bind(principalId, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO devices
         (principal_id, device_id, public_key, credential_status, protocol_version,
          last_accepted_sequence, created_at) VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
      ).bind(principalId, deviceId, JSON.stringify(publicKey), now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
         VALUES (?, ?, 'RUNNING_AGENT', 1, 1, ?, ?)`,
      ).bind(principalId, jobId, now, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000008', 'OWNED_FIXTURE',
                 'AGENT', 'ONLINE', 4, 3, 0, 'NONE', 'PRESENT', ?)`,
      ).bind(principalId, browserSessionId, jobId, deviceId, now),
    ]);
    const coordinator =
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await coordinator.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: {
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        controller: "AGENT",
        connection: "ONLINE",
        leaseEpoch: 4,
        leaseExpiresAt: new Date(nowDate.getTime() + 60_000).toISOString(),
        lastAcceptedSequence: 3,
        automationBlocked: false,
        takeover: "NONE",
        profile: "PRESENT",
      },
    });
    await coordinator.initializeWorkflow({
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        version: 1,
      },
      jobRevision: 2,
      logicalStep: "SET_DISPLAY_NAME",
      effectId: `efx_${browserSessionId.slice(4)}`,
      initializedAt: now,
    });
    await coordinator.cancel(principalId, now);

    const unsigned = {
      protocolVersion: 1 as const,
      principalId,
      deviceId,
      browserSessionId,
      connectionId: "connector-desktop",
      sequence: 5,
      cursor: 0,
      issuedAt: now,
      expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
    };
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalAutomationSyncRequestBytes(unsigned),
    );
    const envelope = automationSyncRequestSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const synchronize = (body: unknown = envelope) =>
      SELF.fetch(
        new Request(
          `https://village.test/api/browser-sessions/${browserSessionId}/automation-sync`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-village-connection-id": "connector-desktop",
            },
            body: JSON.stringify(body),
          },
        ),
      );

    const response = await synchronize();
    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      cursor: 3,
      jobId,
      controller: "NONE",
      connection: "ONLINE",
      leaseEpoch: 5,
      automationBlocked: true,
      canceled: true,
      workflow: {
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
          version: 1,
        },
        jobRevision: 2,
        logicalStep: "SET_DISPLAY_NAME",
        effectId: `efx_${browserSessionId.slice(4)}`,
        completedEffects: [],
        actionPhase: "ACCEPTED",
        outstandingAction: null,
      },
    });
    const replay = await synchronize();
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      ok: false,
      code: "REPLAYED_SEQUENCE",
    });
    const tampered = await synchronize({ ...envelope, cursor: 1 });
    expect(tampered.status).toBe(409);
    await expect(tampered.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });

    const restartedUnsigned = { ...unsigned, sequence: 6, cursor: 3 };
    const restartedSignature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalAutomationSyncRequestBytes(restartedUnsigned),
    );
    const restarted = await synchronize({
      ...restartedUnsigned,
      signature: Buffer.from(restartedSignature).toString("base64url"),
    });
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      ok: true,
      cursor: 3,
      leaseEpoch: 5,
      automationBlocked: true,
      canceled: true,
    });

    const nextJobId = "job_01J00000000000000000000018" as const;
    const nextBrowserSessionId = "brs_01J00000000000000000000018" as const;
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
         VALUES (?, ?, 'WAITING_FOR_BROWSER', 1, 1, ?, ?)`,
      ).bind(principalId, nextJobId, now, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000018', 'OWNED_FIXTURE',
                 'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
      ).bind(principalId, nextBrowserSessionId, nextJobId, deviceId, now),
    ]);
    await env.BROWSER_SESSION_COORDINATOR.getByName(
      nextBrowserSessionId,
    ).initialize({
      principalId,
      browserSessionId: nextBrowserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: {
        principalId,
        deviceId,
        jobId: nextJobId,
        browserSessionId: nextBrowserSessionId,
        controller: "NONE",
        connection: "ONLINE",
        leaseEpoch: 0,
        leaseExpiresAt: null,
        lastAcceptedSequence: 0,
        automationBlocked: true,
        takeover: "NONE",
        profile: "PRESENT",
      },
    });
    const nextUnsigned = {
      ...unsigned,
      browserSessionId: nextBrowserSessionId,
      connectionId: "connector-next-session",
      sequence: 1,
      cursor: 0,
    };
    const nextSignature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalAutomationSyncRequestBytes(nextUnsigned),
    );
    const nextSession = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${nextBrowserSessionId}/automation-sync`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-next-session",
          },
          body: JSON.stringify(
            automationSyncRequestSchema.parse({
              ...nextUnsigned,
              signature: Buffer.from(nextSignature).toString("base64url"),
            }),
          ),
        },
      ),
    );
    expect(nextSession.status, await nextSession.clone().text()).toBe(200);
  });

  it("records a device-signed receipt and advances the durable logical step", async () => {
    const deviceId = "dev_01J00000000000000000000009" as const;
    const jobId = "job_01J00000000000000000000009" as const;
    const browserSessionId = "brs_01J00000000000000000000009" as const;
    const actionId = "act_01J00000000000000000000009" as const;
    const effectId = "efx_01J00000000000000000000009" as const;
    const checkpointId = "chk_01J00000000000000000000009" as const;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
      ).bind(principalId, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO devices
         (principal_id, device_id, public_key, credential_status, protocol_version,
          last_accepted_sequence, created_at) VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
      ).bind(principalId, deviceId, JSON.stringify(publicKey), now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at,
          updated_at, objective_kind, objective_version)
         VALUES (?, ?, 'RUNNING_AGENT', 2, 2, ?, ?,
                 'OWNED_FIXTURE_ACCOUNT_SETUP_V1', 1)`,
      ).bind(principalId, jobId, now, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000009', 'OWNED_FIXTURE',
                 'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
      ).bind(principalId, browserSessionId, jobId, deviceId, now),
    ]);
    const coordinator =
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await coordinator.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: {
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
      },
    });
    await coordinator.initializeWorkflow({
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        version: 1,
      },
      jobRevision: 2,
      logicalStep: "SET_DISPLAY_NAME",
      effectId,
      initializedAt: now,
    });
    await coordinator.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "connector-receipt",
      now,
      expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
    });
    await coordinator.acceptAuthenticatedCommand({
      connectionId: "connector-receipt",
      now,
      envelope: {
        protocolVersion: 1,
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        actionId,
        leaseEpoch: 1,
        workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        workflowVersion: 1,
        jobRevision: 2,
        logicalStep: "SET_DISPLAY_NAME",
        effectId,
        sequence: 1,
        issuedAt: now,
        expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
        command: { capability: "REPLACE_DISPLAY_NAME" },
        signature: "signature",
      },
    });
    const unsigned = {
      protocolVersion: 1 as const,
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      connectionId: "connector-receipt",
      sequence: 1,
      issuedAt: now,
      expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
      operation: "RECORD_RECEIPT" as const,
      receipt: {
        receiptId: "rcp_01J00000000000000000000009",
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        actionId,
        stepId: "bsp_01J00000000000000000000009",
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
          version: 1 as const,
        },
        jobRevision: 2,
        logicalStep: "SET_DISPLAY_NAME" as const,
        effectId,
        leaseEpoch: 1,
        outcome: "POSTCONDITION_SATISFIED" as const,
        predicateIds: ["setup-display-name-matches-v1"],
        recordedAt: now,
      },
      checkpoint: {
        checkpointId,
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        jobRevision: 2,
        eventSequence: 5,
        state: "RUNNING_AGENT" as const,
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
          version: 1 as const,
        },
        site: "OWNED_FIXTURE" as const,
        currentStep: "SET_DISPLAY_NAME" as const,
        currentEffectId: effectId,
        completedEffects: [
          { logicalStep: "SET_DISPLAY_NAME" as const, effectId },
        ],
        outstandingAction: null,
        lastPredicateVersion: "setup-display-name-matches-v1",
        actionPhase: "RECEIPTED" as const,
        reconciliation: "NONE" as const,
        createdAt: now,
      },
    };
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalWorkflowOperationRequestBytes(unsigned),
    );
    const envelope = workflowOperationRequestSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    if (envelope.operation !== "RECORD_RECEIPT") {
      throw new Error("RECEIPT_OPERATION_REQUIRED");
    }
    const response = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/workflow-operations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-receipt",
          },
          body: JSON.stringify(envelope),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      operation: "RECORD_RECEIPT",
      cursor: 5,
    });
    await expect(
      coordinator.workflowSnapshot(principalId),
    ).resolves.toMatchObject({
      checkpoint: {
        currentStep: "SELECT_ROLE",
        currentEffectId: `efx_${checkpointId.slice(4, -1)}0`,
        actionPhase: "ACCEPTED",
      },
    });
    const replay = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/workflow-operations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-receipt",
          },
          body: JSON.stringify(envelope),
        },
      ),
    );
    await expect(replay.json()).resolves.toEqual({
      ok: false,
      code: "REPLAYED_SEQUENCE",
    });
    const tampered = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/workflow-operations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-receipt",
          },
          body: JSON.stringify({
            ...envelope,
            checkpoint: {
              ...envelope.checkpoint,
              lastPredicateVersion: "setup-role-v1",
            },
          }),
        },
      ),
    );
    await expect(tampered.json()).resolves.toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
  });

  it("claims one fresh fenced lease from signed owner hand-back state", async () => {
    const deviceId = "dev_01J00000000000000000000010" as const;
    const jobId = "job_01J00000000000000000000010" as const;
    const browserSessionId = "brs_01J00000000000000000000010" as const;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
      ).bind(principalId, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO devices
         (principal_id, device_id, public_key, credential_status, protocol_version,
          last_accepted_sequence, created_at) VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
      ).bind(principalId, deviceId, JSON.stringify(publicKey), now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
         VALUES (?, ?, 'RUNNING_USER', 2, 2, ?, ?)`,
      ).bind(principalId, jobId, now, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000010', 'OWNED_FIXTURE',
                 'USER', 'ONLINE', 2, 0, 1, 'NONE', 'PRESENT', ?)`,
      ).bind(principalId, browserSessionId, jobId, deviceId, now),
    ]);
    const coordinator =
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await coordinator.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: {
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        controller: "USER",
        connection: "ONLINE",
        leaseEpoch: 2,
        leaseExpiresAt: null,
        lastAcceptedSequence: 0,
        automationBlocked: true,
        takeover: "NONE",
        profile: "PRESENT",
      },
    });
    const unsigned = {
      protocolVersion: 1 as const,
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      connectionId: "connector-hand-back",
      sequence: 1,
      issuedAt: now,
      expiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
      operation: "CLAIM_FRESH_LEASE" as const,
      afterLeaseEpoch: 2,
      cursor: 1,
      leaseExpiresAt: new Date(nowDate.getTime() + 30_000).toISOString(),
    };
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalWorkflowOperationRequestBytes(unsigned),
    );
    const envelope = workflowOperationRequestSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });
    const requestLease = () =>
      SELF.fetch(
        new Request(
          `https://village.test/api/browser-sessions/${browserSessionId}/workflow-operations`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-village-connection-id": "connector-hand-back",
            },
            body: JSON.stringify(envelope),
          },
        ),
      );

    const response = await requestLease();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      operation: "CLAIM_FRESH_LEASE",
      cursor: 2,
      leaseEpoch: 3,
    });
    await expect(coordinator.snapshot(principalId)).resolves.toMatchObject({
      eventSequence: 2,
      control: {
        controller: "AGENT",
        leaseEpoch: 3,
        automationBlocked: false,
        takeover: "NONE",
      },
    });
    const replay = await requestLease();
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      ok: false,
      code: "REPLAYED_SEQUENCE",
    });
    const staleUnsigned = { ...unsigned, sequence: 2 };
    const staleSignature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalWorkflowOperationRequestBytes(staleUnsigned),
    );
    const stale = await SELF.fetch(
      new Request(
        `https://village.test/api/browser-sessions/${browserSessionId}/workflow-operations`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-village-connection-id": "connector-hand-back",
          },
          body: JSON.stringify({
            ...staleUnsigned,
            signature: Buffer.from(staleSignature).toString("base64url"),
          }),
        },
      ),
    );
    await expect(stale.json()).resolves.toEqual({
      ok: false,
      code: "STALE_WORKFLOW_BINDING",
    });
  });

  it("records signed takeover and owner progress against one durable cursor", async () => {
    const deviceId = "dev_01J00000000000000000000011" as const;
    const jobId = "job_01J00000000000000000000011" as const;
    const browserSessionId = "brs_01J00000000000000000000011" as const;
    const effectId = "efx_01J00000000000000000000011" as const;
    const connectionId = "connector-owner-progress";
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + 30_000).toISOString();
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
      ).bind(principalId, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO devices
         (principal_id, device_id, public_key, credential_status, protocol_version,
          last_accepted_sequence, created_at) VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
      ).bind(principalId, deviceId, JSON.stringify(publicKey), now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO jobs
         (principal_id, job_id, state, version, last_event_sequence, created_at,
          updated_at, objective_kind, objective_version)
         VALUES (?, ?, 'RUNNING_AGENT', 2, 2, ?, ?,
                 'OWNED_FIXTURE_ACCOUNT_SETUP_V1', 1)`,
      ).bind(principalId, jobId, now, now),
      env.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000011', 'OWNED_FIXTURE',
                 'AGENT', 'ONLINE', 1, 0, 0, 'NONE', 'PRESENT', ?)`,
      ).bind(principalId, browserSessionId, jobId, deviceId, now),
    ]);
    const coordinator =
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await coordinator.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: {
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
      },
    });
    await coordinator.initializeWorkflow({
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
      jobRevision: 2,
      logicalStep: "SET_DISPLAY_NAME",
      effectId,
      initializedAt: now,
    });
    await coordinator.claimAgentLease({
      principalId,
      deviceId,
      connectionId,
      now,
      expiresAt,
    });
    const requestOperation = async (
      unsigned: Parameters<typeof canonicalWorkflowOperationRequestBytes>[0],
    ) => {
      const signature = await crypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        canonicalWorkflowOperationRequestBytes(unsigned),
      );
      return SELF.fetch(
        new Request(
          `https://village.test/api/browser-sessions/${browserSessionId}/workflow-operations`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-village-connection-id": connectionId,
            },
            body: JSON.stringify({
              ...unsigned,
              signature: Buffer.from(signature).toString("base64url"),
            }),
          },
        ),
      );
    };
    const common = {
      protocolVersion: 1 as const,
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      connectionId,
      issuedAt: now,
      expiresAt,
    };
    const takeover = {
      ...common,
      sequence: 1,
      operation: "TAKEOVER" as const,
      expectedLeaseEpoch: 1,
      cursor: 3,
    };
    const takeoverResponse = await requestOperation(takeover);
    const takeoverBody = await takeoverResponse.json();
    expect(takeoverResponse.status, JSON.stringify(takeoverBody)).toBe(200);
    expect(takeoverBody).toEqual({
      ok: true,
      operation: "TAKEOVER",
      cursor: 4,
      leaseEpoch: 2,
    });
    await expect(coordinator.snapshot(principalId)).resolves.toMatchObject({
      eventSequence: 4,
      control: {
        controller: "USER",
        leaseEpoch: 2,
        automationBlocked: true,
        takeover: "NONE",
      },
    });
    const replay = await requestOperation(takeover);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({
      ok: false,
      code: "REPLAYED_SEQUENCE",
    });

    const ownerProgress = {
      ...common,
      sequence: 2,
      operation: "RECORD_OWNER_PROGRESS" as const,
      objective: {
        kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
        version: 1 as const,
      },
      jobRevision: 2,
      logicalStep: "SET_DISPLAY_NAME" as const,
      effectId,
      actionPhase: "EFFECT_OBSERVED" as const,
      leaseEpoch: 2,
      cursor: 4,
      actor: "OWNER" as const,
      occurredAt: now,
    };
    const progressResponse = await requestOperation(ownerProgress);
    expect(progressResponse.status).toBe(200);
    await expect(progressResponse.json()).resolves.toEqual({
      ok: true,
      operation: "RECORD_OWNER_PROGRESS",
      cursor: 5,
    });
    await expect(
      coordinator.workflowSnapshot(principalId),
    ).resolves.toMatchObject({
      eventSequence: 5,
      effects: [
        expect.objectContaining({
          logicalStep: "SET_DISPLAY_NAME",
          effectId,
          phase: "EFFECT_OBSERVED",
        }),
      ],
    });
  });

  it("exports owner-scoped cloud data and completes a two-stage verified deletion", async () => {
    const created = await SELF.fetch(
      new Request("https://village.test/api/jobs", {
        method: "POST",
        headers: ownerHeaders,
      }),
    );
    const { jobId } = await created.json<{ jobId: string }>();
    const deviceId = "dev_01J00000000000000000000090";
    const browserSessionId = "brs_01J00000000000000000000090";
    await env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    )
      .bind(principalId, deviceId, new Date().toISOString())
      .run();
    expect(
      (
        await SELF.fetch(
          new Request(
            `https://village.test/api/jobs/${jobId}/browser-sessions`,
            {
              method: "POST",
              headers: ownerHeaders,
              body: JSON.stringify({
                deviceId,
                browserSessionId,
                hostId: "hst_01J00000000000000000000090",
                site: "OWNED_FIXTURE",
              }),
            },
          ),
        )
      ).status,
    ).toBe(201);

    const exported = await SELF.fetch(
      new Request("https://village.test/api/owner/data-export", {
        headers: ownerHeaders,
      }),
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("cache-control")).toBe("no-store");
    const exportBody = await exported.json<Record<string, unknown>>();
    expect(exportBody).toMatchObject({
      schemaVersion: 1,
      principalId,
      coordinators: expect.arrayContaining([
        expect.objectContaining({ browserSessionId, site: "OWNED_FIXTURE" }),
      ]),
    });
    expect(JSON.stringify(exportBody)).not.toMatch(
      /public_key|secret_hash|ciphertext|other@example/i,
    );

    const { "x-village-csrf": _csrfHeader, ...missingCsrfHeaders } =
      ownerHeaders;
    const missingCsrf = await SELF.fetch(
      new Request("https://village.test/api/owner/deletion-requests", {
        method: "POST",
        headers: missingCsrfHeaders,
        body: JSON.stringify({ confirmation: "DELETE_CLOUD_DATA" }),
      }),
    );
    expect(missingCsrf.status).toBe(403);
    const invalidPlan = await SELF.fetch(
      new Request("https://village.test/api/owner/deletion-requests", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ confirmation: "delete" }),
      }),
    );
    expect(invalidPlan.status).toBe(400);
    const planned = await SELF.fetch(
      new Request("https://village.test/api/owner/deletion-requests", {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ confirmation: "DELETE_CLOUD_DATA" }),
      }),
    );
    expect(planned.status).toBe(201);
    const plan = await planned.json<{ deletionRequestId: string }>();
    const confirmationUrl = `https://village.test/api/owner/deletion-requests/${plan.deletionRequestId}/confirm`;
    const foreign = await SELF.fetch(
      new Request(confirmationUrl, {
        method: "POST",
        headers: {
          ...ownerHeaders,
          "x-village-development-principal": otherPrincipalId,
        },
        body: JSON.stringify({ confirmation: "DELETE_CLOUD_DATA" }),
      }),
    );
    expect(foreign.status).toBe(404);
    const confirmed = await SELF.fetch(
      new Request(confirmationUrl, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ confirmation: "DELETE_CLOUD_DATA" }),
      }),
    );
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      ok: true,
      status: "COMPLETED",
      verification: { verified: true, remainingRecords: 0 },
    });
    const replayedConfirmation = await SELF.fetch(
      new Request(confirmationUrl, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ confirmation: "DELETE_CLOUD_DATA" }),
      }),
    );
    expect(replayedConfirmation.status).toBe(200);
    await expect(replayedConfirmation.json()).resolves.toMatchObject({
      ok: true,
      status: "COMPLETED",
    });
    await expect(
      env.BROWSER_SESSION_COORDINATOR.getByName(
        browserSessionId,
      ).lifecycleStatus(principalId),
    ).resolves.toEqual({ ok: true, state: "ABSENT" });
    const deletedIdentity = await SELF.fetch(
      new Request("https://village.test/api/identity", {
        headers: ownerHeaders,
      }),
    );
    expect(deletedIdentity.status).toBe(410);
    await expect(deletedIdentity.json()).resolves.toEqual({
      ok: false,
      code: "ACCOUNT_DELETED",
    });
  });
});
