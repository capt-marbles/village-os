import { env } from "cloudflare:workers";
import { applyD1Migrations, evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalCommandEnvelopeBytes,
  canonicalResultEnvelopeBytes,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  type BrowserControlState,
  type BrowserCommand,
  type UnsignedCommandEnvelope,
  type UnsignedResultEnvelope,
} from "@village/contracts";
import {
  dispatchAuthenticatedCommand,
  dispatchAuthenticatedResult,
} from "../../handlers/browser-control.js";
import {
  projectSessionEvents,
  rebuildSessionProjection,
} from "../projection-outbox.js";

const principalId = "prn_01J00000000000000000000000" as const;
const deviceId = "dev_01J00000000000000000000000" as const;
const jobId = "job_01J00000000000000000000000" as const;
const projectionJobId = "job_01J00000000000000000000002" as const;
const browserSessionA = "brs_01J00000000000000000000000" as const;
const browserSessionB = "brs_01J00000000000000000000001" as const;
const browserSessionC = "brs_01J00000000000000000000002" as const;
const now = "2026-08-12T18:00:00.000Z";
let keys: CryptoKeyPair;

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
});

async function signedCommand(
  command: BrowserCommand,
  sequence = 1,
  browserSessionId: string = browserSessionA,
) {
  const unsigned: UnsignedCommandEnvelope = {
    protocolVersion: 1 as const,
    principalId,
    deviceId,
    jobId,
    browserSessionId,
    actionId:
      sequence === 1
        ? "act_01J00000000000000000000000"
        : "act_01J00000000000000000000001",
    leaseEpoch: 1,
    sequence,
    issuedAt: now,
    expiresAt: "2026-08-12T18:00:30.000Z",
    command,
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    canonicalCommandEnvelopeBytes(unsigned),
  );
  return signedCommandEnvelopeSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
}

async function signedSetupCommand(
  command: Extract<BrowserCommand, { capability: "REPLACE_DISPLAY_NAME" }>,
  sequence = 1,
  browserSessionId: string = browserSessionA,
) {
  const unsigned = {
    protocolVersion: 1 as const,
    principalId,
    deviceId,
    jobId,
    browserSessionId,
    actionId: "act_01J00000000000000000000000" as const,
    leaseEpoch: 1,
    sequence,
    issuedAt: now,
    expiresAt: "2026-08-12T18:00:30.000Z",
    workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
    workflowVersion: 1 as const,
    jobRevision: 1,
    logicalStep: "SET_DISPLAY_NAME" as const,
    effectId: "efx_01J00000000000000000000000" as const,
    command,
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    canonicalCommandEnvelopeBytes(unsigned),
  );
  return signedCommandEnvelopeSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
}

async function signedResult(
  actionId: string,
  sequence: number,
  browserSessionId: string = browserSessionA,
) {
  const unsigned: UnsignedResultEnvelope = {
    protocolVersion: 1,
    principalId,
    deviceId,
    jobId,
    browserSessionId,
    actionId,
    leaseEpoch: 1,
    sequence,
    issuedAt: now,
    expiresAt: "2026-08-12T18:00:30.000Z",
    result: { status: "ACCEPTED" },
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    canonicalResultEnvelopeBytes(unsigned),
  );
  return signedResultEnvelopeSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
}

async function seedProjectionRows(
  site: "OWNED_FIXTURE" | "LINKEDIN" = "OWNED_FIXTURE",
  browserSessionId: string = browserSessionA,
  sessionJobId: string = jobId,
) {
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "INSERT OR IGNORE INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principalId, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at) VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)
       ON CONFLICT(principal_id, device_id) DO UPDATE SET
         public_key = excluded.public_key,
         credential_status = 'ACTIVE',
         protocol_version = excluded.protocol_version`,
    ).bind(principalId, deviceId, JSON.stringify(publicKey), now),
    env.VILLAGE_DB.prepare(
      `INSERT OR IGNORE INTO jobs
       (principal_id, job_id, state, version, last_event_sequence, created_at, updated_at)
       VALUES (?, ?, 'QUEUED', 1, 1, ?, ?)`,
    ).bind(principalId, sessionJobId, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT OR IGNORE INTO browser_sessions
       (principal_id, browser_session_id, job_id, device_id, host_id, site,
        controller, connection_state, lease_epoch, last_accepted_sequence,
        automation_blocked, takeover_state, profile_state, updated_at)
       VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000000', ?, 'NONE',
               'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
    ).bind(principalId, browserSessionId, sessionJobId, deviceId, site, now),
  ]);
}

async function initializedCoordinator(
  site: "OWNED_FIXTURE" | "LINKEDIN" = "OWNED_FIXTURE",
  browserSessionId: string = browserSessionA,
  sessionJobId: string = jobId,
) {
  const initial: BrowserControlState = {
    principalId,
    deviceId,
    jobId: sessionJobId,
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
  const stub = env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
  await stub.initialize({
    principalId,
    browserSessionId,
    site,
    initializedAt: now,
    control: initial,
  });
  await stub.claimAgentLease({
    principalId,
    deviceId,
    connectionId: "connector-a",
    now,
    expiresAt: "2026-08-12T18:00:45.000Z",
  });
  return stub;
}

describe("authenticated protocol", () => {
  it("rejects tampering, replay, stale connector, policy bypass, and revocation", async () => {
    await seedProjectionRows();
    const stub = await initializedCoordinator();
    const observe = await signedCommand({
      capability: "OBSERVE",
      facts: ["AUTH_STATE"],
    });
    expect(
      await dispatchAuthenticatedCommand(
        env,
        observe,
        "connector-a",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toMatchObject({ ok: true, action: { phase: "ACCEPTED" } });
    expect(
      await dispatchAuthenticatedCommand(
        env,
        observe,
        "connector-a",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "REPLAYED_SEQUENCE" });
    expect(
      await dispatchAuthenticatedCommand(
        env,
        { ...observe, jobId: "job_01J00000000000000000000001" },
        "connector-a",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
    const second = await signedCommand(
      { capability: "OBSERVE", facts: ["AUTH_STATE"] },
      2,
    );
    expect(
      await dispatchAuthenticatedCommand(
        env,
        second,
        "connector-b",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "STALE_CONNECTOR" });
    expect(
      await dispatchAuthenticatedCommand(
        env,
        second,
        "connector-a",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toMatchObject({ ok: true });

    const firstResult = await signedResult(observe.actionId, 1);
    expect(
      await dispatchAuthenticatedResult(
        env,
        firstResult,
        "connector-a",
        "2026-08-12T18:00:06.000Z",
      ),
    ).toMatchObject({ ok: true, action: { phase: "DISPATCHED" } });
    expect(
      await dispatchAuthenticatedResult(
        env,
        firstResult,
        "connector-a",
        "2026-08-12T18:00:06.000Z",
      ),
    ).toEqual({ ok: false, code: "REPLAYED_RESULT_SEQUENCE" });
    const reorderedHigh = await signedResult(second.actionId, 3);
    expect(
      await dispatchAuthenticatedResult(
        env,
        reorderedHigh,
        "connector-a",
        "2026-08-12T18:00:06.000Z",
      ),
    ).toMatchObject({ ok: true });
    const reorderedLow = await signedResult(observe.actionId, 2);
    expect(
      await dispatchAuthenticatedResult(
        env,
        reorderedLow,
        "connector-a",
        "2026-08-12T18:00:06.000Z",
      ),
    ).toEqual({ ok: false, code: "REPLAYED_RESULT_SEQUENCE" });

    await evictDurableObject(stub);
    expect(await stub.action(principalId, observe.actionId)).toMatchObject({
      ok: true,
      action: { actionId: observe.actionId, phase: "DISPATCHED" },
    });
    await env.VILLAGE_DB.prepare(
      "UPDATE devices SET credential_status = 'REVOKED' WHERE principal_id = ? AND device_id = ?",
    )
      .bind(principalId, deviceId)
      .run();
    expect(
      await dispatchAuthenticatedCommand(
        env,
        second,
        "connector-a",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "DEVICE_REVOKED_OR_UNKNOWN" });
  });

  it("keeps LinkedIn human-only inside the authoritative coordinator", async () => {
    await seedProjectionRows("LINKEDIN", browserSessionB);
    await initializedCoordinator("LINKEDIN", browserSessionB);
    const input = await signedSetupCommand(
      { capability: "REPLACE_DISPLAY_NAME" },
      1,
      browserSessionB,
    );
    expect(
      await dispatchAuthenticatedCommand(
        env,
        input,
        "connector-a",
        "2026-08-12T18:00:05.000Z",
      ),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
  });

  it("retains authoritative state on projection failure then retries and rebuilds idempotently", async () => {
    const stub = await initializedCoordinator(
      "OWNED_FIXTURE",
      browserSessionC,
      projectionJobId,
    );
    expect(
      await projectSessionEvents(env, principalId, browserSessionC, now),
    ).toEqual({ ok: false, code: "PROJECTION_WRITE_FAILED" });
    expect(await stub.snapshot(principalId)).toMatchObject({
      ok: true,
      projectionLag: 2,
      eventSequence: 2,
    });

    await seedProjectionRows("OWNED_FIXTURE", browserSessionC, projectionJobId);
    expect(
      await projectSessionEvents(env, principalId, browserSessionC, now),
    ).toEqual({ ok: true, projected: 2 });
    expect(await stub.snapshot(principalId)).toMatchObject({
      projectionLag: 0,
    });
    expect(
      await rebuildSessionProjection(env, principalId, browserSessionC, now),
    ).toEqual({ ok: true, projected: 2 });
    const count = await env.VILLAGE_DB.prepare(
      `SELECT COUNT(*) AS count FROM browser_session_event_projections
       WHERE principal_id = ? AND browser_session_id = ?`,
    )
      .bind(principalId, browserSessionC)
      .first<{ count: number }>();
    expect(count?.count).toBe(2);
  });
});
