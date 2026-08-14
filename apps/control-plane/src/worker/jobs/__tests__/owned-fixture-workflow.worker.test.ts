import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserControlState } from "@village/contracts";
import {
  projectSessionEvents,
  rebuildSessionProjection,
} from "../../browser-control/projection-outbox.js";
import type { BrowserSessionCoordinator } from "../../browser-control/session-coordinator.js";
import { getJob } from "../../handlers/jobs.js";

const principalId = "prn_01J00000000000000000000030" as const;
const otherPrincipalId = "prn_01J00000000000000000000031" as const;
const deviceId = "dev_01J00000000000000000000030" as const;
const jobId = "job_01J00000000000000000000030" as const;
const browserSessionId = "brs_01J00000000000000000000030" as const;
const now = "2026-08-13T18:00:00.000Z";

type WorkflowCoordinator = {
  initialize(candidate: unknown): Promise<{ ok: boolean }>;
  claimAgentLease(candidate: unknown): Promise<unknown>;
  acceptAuthenticatedCommand(candidate: unknown): Promise<any>;
  recordWorkflowReceipt(candidate: unknown): Promise<any>;
  workflowSnapshot(principalId: unknown): Promise<any>;
};

function coordinator(): WorkflowCoordinator {
  return env.BROWSER_SESSION_COORDINATOR.getByName(
    browserSessionId,
  ) as unknown as WorkflowCoordinator;
}

function setupEnvelope(
  actionId: string,
  sequence: number,
  logicalStep:
    | "SET_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "SET_PREFERRED_FOCUS"
    | "FINALIZE_SETUP",
  effectId: string,
  capability:
    | "REPLACE_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "REPLACE_PREFERRED_FOCUS"
    | "FINALIZE_SETUP",
) {
  return {
    protocolVersion: 1,
    principalId,
    deviceId,
    jobId,
    browserSessionId,
    actionId,
    leaseEpoch: 1,
    sequence,
    issuedAt: now,
    expiresAt: "2026-08-13T18:00:30.000Z",
    signature: "signature",
    workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
    workflowVersion: 1,
    jobRevision: 1,
    logicalStep,
    effectId,
    command: { capability },
  };
}

async function initialize() {
  const control: BrowserControlState = {
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
  await coordinator().initialize({
    principalId,
    browserSessionId,
    site: "OWNED_FIXTURE",
    initializedAt: now,
    control,
  });
  await coordinator().claimAgentLease({
    principalId,
    deviceId,
    connectionId: "connector-u3",
    now,
    expiresAt: "2026-08-13T18:00:45.000Z",
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  await runInDurableObject(
    env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId),
    async (_instance: BrowserSessionCoordinator, state) => {
      state.storage.sql.exec(`
        DELETE FROM workflow_cancellations;
        DELETE FROM workflow_checkpoint;
        DELETE FROM workflow_receipts;
        DELETE FROM workflow_effects;
        DELETE FROM accepted_actions;
        DELETE FROM projection_outbox;
        DELETE FROM coordinator_events;
        DELETE FROM command_quota_windows;
        DELETE FROM event_stream_quota_windows;
        DELETE FROM control_state;
        DELETE FROM session_metadata;
      `);
    },
  );
  await env.VILLAGE_DB.prepare("DELETE FROM principals").run();
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "INSERT INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principalId, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    ).bind(principalId, deviceId, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO jobs
       (principal_id, job_id, browser_session_id, state, version,
        last_event_sequence, created_at, updated_at, objective_kind, objective_version)
       VALUES (?, ?, ?, 'RUNNING_AGENT', 1, 1, ?, ?,
               'OWNED_FIXTURE_ACCOUNT_SETUP_V1', 1)`,
    ).bind(principalId, jobId, browserSessionId, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO browser_sessions
       (principal_id, browser_session_id, job_id, device_id, host_id, site,
        controller, connection_state, lease_epoch, last_accepted_sequence,
        automation_blocked, takeover_state, profile_state, updated_at)
       VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000030', 'OWNED_FIXTURE',
               'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
    ).bind(principalId, browserSessionId, jobId, deviceId, now),
  ]);
  await initialize();
});

describe("owned fixture workflow durability", () => {
  it("keeps legacy rows readable while exposing versioned workflow objectives", async () => {
    const legacyJobId = "job_01J00000000000000000000039";
    await env.VILLAGE_DB.prepare(
      `INSERT INTO jobs
       (principal_id, job_id, state, version, last_event_sequence,
        created_at, updated_at)
       VALUES (?, ?, 'QUEUED', 1, 1, ?, ?)`,
    )
      .bind(principalId, legacyJobId, now, now)
      .run();
    await expect(
      getJob(env.VILLAGE_DB, principalId, legacyJobId),
    ).resolves.toMatchObject({ ok: true, job: { objective: null } });
    await expect(
      getJob(env.VILLAGE_DB, principalId, jobId),
    ).resolves.toMatchObject({
      ok: true,
      job: {
        objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
      },
    });
  });

  it("accepts one stable logical effect, permits a dispatch retry, and rejects conflicts", async () => {
    const first = await coordinator().acceptAuthenticatedCommand({
      connectionId: "connector-u3",
      now: "2026-08-13T18:00:01.000Z",
      envelope: setupEnvelope(
        "act_01J00000000000000000000030",
        1,
        "SET_DISPLAY_NAME",
        "efx_01J00000000000000000000030",
        "REPLACE_DISPLAY_NAME",
      ),
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first).toMatchObject({ effectReplay: false });

    const retry = await coordinator().acceptAuthenticatedCommand({
      connectionId: "connector-u3",
      now: "2026-08-13T18:00:02.000Z",
      envelope: setupEnvelope(
        "act_01J00000000000000000000031",
        2,
        "SET_DISPLAY_NAME",
        "efx_01J00000000000000000000030",
        "REPLACE_DISPLAY_NAME",
      ),
    });
    expect(retry).toMatchObject({
      ok: true,
      effectReplay: true,
      canonicalActionId: "act_01J00000000000000000000030",
    });

    const conflictingEffect = await coordinator().acceptAuthenticatedCommand({
      connectionId: "connector-u3",
      now: "2026-08-13T18:00:03.000Z",
      envelope: setupEnvelope(
        "act_01J00000000000000000000032",
        3,
        "SET_DISPLAY_NAME",
        "efx_01J00000000000000000000031",
        "REPLACE_DISPLAY_NAME",
      ),
    });
    expect(conflictingEffect).toEqual({
      ok: false,
      code: "LOGICAL_EFFECT_CONFLICT",
    });

    const reusedEffect = await coordinator().acceptAuthenticatedCommand({
      connectionId: "connector-u3",
      now: "2026-08-13T18:00:04.000Z",
      envelope: setupEnvelope(
        "act_01J00000000000000000000033",
        3,
        "SELECT_ROLE",
        "efx_01J00000000000000000000030",
        "SELECT_ROLE",
      ),
    });
    expect(reusedEffect).toEqual({
      ok: false,
      code: "LOGICAL_EFFECT_CONFLICT",
    });
  });

  it("atomically receipts a sanitized checkpoint and survives restart and projection rebuild", async () => {
    const actionId = "act_01J00000000000000000000030" as const;
    const effectId = "efx_01J00000000000000000000030" as const;
    await coordinator().acceptAuthenticatedCommand({
      connectionId: "connector-u3",
      now: "2026-08-13T18:00:01.000Z",
      envelope: setupEnvelope(
        actionId,
        1,
        "SET_DISPLAY_NAME",
        effectId,
        "REPLACE_DISPLAY_NAME",
      ),
    });
    const receipt = {
      receiptId: "rcp_01J00000000000000000000030",
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      actionId,
      stepId: "bsp_01J00000000000000000000030",
      objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
      jobRevision: 1,
      logicalStep: "SET_DISPLAY_NAME",
      effectId,
      leaseEpoch: 1,
      outcome: "POSTCONDITION_SATISFIED",
      predicateIds: ["setup-display-name-matches-v1"],
      recordedAt: "2026-08-13T18:00:05.000Z",
    };
    const checkpoint = {
      checkpointId: "chk_01J00000000000000000000030",
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      jobRevision: 1,
      eventSequence: 4,
      state: "RUNNING_AGENT",
      objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
      site: "OWNED_FIXTURE",
      currentStep: "SELECT_ROLE",
      currentEffectId: "efx_01J00000000000000000000031",
      completedEffects: [{ logicalStep: "SET_DISPLAY_NAME", effectId }],
      outstandingAction: null,
      lastPredicateVersion: "setup-display-name-matches-v1",
      actionPhase: "RECEIPTED",
      reconciliation: "NONE",
      createdAt: "2026-08-13T18:00:05.000Z",
    };

    await expect(
      coordinator().recordWorkflowReceipt({ receipt, checkpoint }),
    ).resolves.toMatchObject({ ok: true, eventSequence: 4 });
    const serializedSnapshot = JSON.stringify(
      await coordinator().workflowSnapshot(principalId),
    );
    expect(serializedSnapshot).not.toContain("Andrew");
    expect(serializedSnapshot).not.toContain("page text");
    expect(serializedSnapshot).not.toContain("https://");

    await evictDurableObject(
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId),
    );
    await expect(
      coordinator().workflowSnapshot(principalId),
    ).resolves.toMatchObject({
      ok: true,
      checkpoint: { checkpointId: checkpoint.checkpointId },
      effects: expect.arrayContaining([
        expect.objectContaining({
          logicalStep: "SET_DISPLAY_NAME",
          effectId,
          receiptId: receipt.receiptId,
        }),
      ]),
    });

    await expect(
      projectSessionEvents(
        env,
        principalId,
        browserSessionId,
        "2026-08-13T18:00:06.000Z",
      ),
    ).resolves.toMatchObject({ ok: true, projected: 4 });
    await expect(
      env.VILLAGE_DB.prepare(
        `SELECT action_phase AS actionPhase, receipt_id AS receiptId,
                checkpoint_id AS checkpointId
         FROM workflow_effect_projections
         WHERE principal_id = ? AND browser_session_id = ? AND logical_step = ?`,
      )
        .bind(principalId, browserSessionId, "SET_DISPLAY_NAME")
        .first(),
    ).resolves.toEqual({
      actionPhase: "RECEIPTED",
      receiptId: receipt.receiptId,
      checkpointId: checkpoint.checkpointId,
    });
    // A lost projection acknowledgement is safe: duplicate delivery converges.
    await expect(
      projectSessionEvents(
        env,
        principalId,
        browserSessionId,
        "2026-08-13T18:00:07.000Z",
      ),
    ).resolves.toMatchObject({ ok: true, projected: 0 });
    await env.VILLAGE_DB.prepare(
      `DELETE FROM browser_session_event_projections
       WHERE principal_id = ? AND browser_session_id = ?`,
    )
      .bind(principalId, browserSessionId)
      .run();
    await expect(
      rebuildSessionProjection(
        env,
        principalId,
        browserSessionId,
        "2026-08-13T18:00:08.000Z",
      ),
    ).resolves.toMatchObject({ ok: true, projected: 4 });
    await expect(
      env.VILLAGE_DB.prepare(
        `SELECT COUNT(*) AS count FROM browser_session_event_projections
         WHERE principal_id = ? AND browser_session_id = ?`,
      )
        .bind(principalId, browserSessionId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 4 });
    await expect(
      coordinator().workflowSnapshot(otherPrincipalId),
    ).resolves.toEqual({ ok: false, code: "IDENTITY_MISMATCH" });
  });
});
