import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  executePrincipalDeletion,
  exportPrincipalRecords,
  planPrincipalDeletion,
  verifyPrincipalDeletion,
} from "../deletion.js";
import {
  executeCloudRetentionBatch,
  executeRetentionBatch,
  recordRetentionPolicies,
} from "../policy.js";
import type { SiteSessionMailbox } from "../../site-session-continuity/mailbox.js";
import type { BrowserControlState } from "@village/contracts";

const principalId = "prn_01J00000000000000000000020";
const otherPrincipalId = "prn_01J00000000000000000000021";
const jobId = "job_01J00000000000000000000020";
const browserSessionId = "brs_01J00000000000000000000020";
const actionId = "act_01J00000000000000000000020";
const now = "2026-08-12T18:00:00.000Z";

async function seedPrincipal(principal: string, suffix: string) {
  const device = `dev_01J000000000000000000000${suffix}`;
  const job = `job_01J000000000000000000000${suffix}`;
  const session = `brs_01J000000000000000000000${suffix}`;
  const action = `act_01J000000000000000000000${suffix}`;
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      "INSERT INTO principals (principal_id, created_at) VALUES (?, ?)",
    ).bind(principal, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, '{}', 'ACTIVE', 1, 0, ?)`,
    ).bind(principal, device, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO jobs
       (principal_id, job_id, browser_session_id, state, version, last_event_sequence,
        active_human_gate_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'QUEUED', 1, 1, NULL, ?, ?)`,
    ).bind(principal, job, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO job_events
       (principal_id, job_id, event_id, sequence, event_type, payload_json, occurred_at)
       VALUES (?, ?, ?, 1, 'JOB_CREATED', '{}', ?)`,
    ).bind(principal, job, `evt_01J000000000000000000000${suffix}`, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO checkpoints
       (principal_id, job_id, checkpoint_id, job_version, event_sequence, state, created_at)
       VALUES (?, ?, ?, 1, 1, 'QUEUED', ?)`,
    ).bind(principal, job, `chk_01J000000000000000000000${suffix}`, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO browser_sessions
       (principal_id, browser_session_id, job_id, device_id, host_id, site, controller,
        connection_state, lease_epoch, last_accepted_sequence, automation_blocked,
        takeover_state, profile_state, updated_at)
       VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000000', 'OWNED_FIXTURE', 'NONE',
        'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
    ).bind(principal, session, job, device, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO browser_actions
       (principal_id, browser_session_id, action_id, lease_epoch, command_sequence, phase,
        mutation_class, postcondition, accepted_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 'RECEIPTED', 'IDEMPOTENT', 'SATISFIED', ?, ?)`,
    ).bind(principal, session, action, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO browser_session_event_projections
       (principal_id, browser_session_id, sequence, event_type, payload_json, occurred_at, projected_at)
       VALUES (?, ?, 1, 'SESSION_INITIALIZED', '{}', ?, ?)`,
    ).bind(principal, session, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO action_receipts
       (principal_id, browser_session_id, receipt_id, job_id, action_id, outcome,
        predicate_ids_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'POSTCONDITION_SATISFIED', '[]', ?)`,
    ).bind(
      principal,
      session,
      `rcp_01J000000000000000000000${suffix}`,
      job,
      action,
      now,
    ),
    env.VILLAGE_DB.prepare(
      `INSERT INTO workflow_effect_projections
       (principal_id, browser_session_id, job_id, job_revision, workflow_kind,
        workflow_version, logical_step, effect_id, canonical_action_id,
        action_phase, receipt_id, checkpoint_id, updated_at)
       VALUES (?, ?, ?, 1, 'OWNED_FIXTURE_ACCOUNT_SETUP_V1', 1,
               'SET_DISPLAY_NAME', ?, ?, 'RECEIPTED', NULL, NULL, ?)`,
    ).bind(
      principal,
      session,
      job,
      `efx_01J000000000000000000000${suffix}`,
      action,
      now,
    ),
    env.VILLAGE_DB.prepare(
      `INSERT INTO workflow_cancellations
       (principal_id, browser_session_id, cancellation_id, job_id,
        expected_job_revision, resulting_job_revision, event_sequence, accepted_at)
       VALUES (?, ?, ?, ?, 1, 2, 2, ?)`,
    ).bind(
      principal,
      session,
      `cnl_01J000000000000000000000${suffix}`,
      job,
      now,
    ),
  ]);
}

async function seedContinuityMailbox() {
  const grantId = "cgr_01J00000000000000000000020";
  const destinationDeviceId = "dev_01J00000000000000000000022";
  const destinationJobId = "job_01J00000000000000000000022";
  const destinationSessionId = "brs_01J00000000000000000000022";
  const sourceDeviceId = "dev_01J00000000000000000000020";
  const sourceSessionId = "brs_01J00000000000000000000020";
  const publicKey = { kty: "OKP", crv: "Ed25519", x: "a".repeat(43) };
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare(
      `INSERT INTO devices
       (principal_id, device_id, public_key, credential_status, protocol_version,
        last_accepted_sequence, created_at)
       VALUES (?, ?, ?, 'ACTIVE', 1, 0, ?)`,
    ).bind(principalId, destinationDeviceId, JSON.stringify(publicKey), now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO jobs
       (principal_id, job_id, browser_session_id, state, version,
        last_event_sequence, created_at, updated_at)
       VALUES (?, ?, ?, 'WAITING_FOR_BROWSER', 1, 1, ?, ?)`,
    ).bind(principalId, destinationJobId, destinationSessionId, now, now),
    env.VILLAGE_DB.prepare(
      `INSERT INTO browser_sessions
       (principal_id, browser_session_id, job_id, device_id, host_id, site,
        controller, connection_state, lease_epoch, last_accepted_sequence,
        automation_blocked, takeover_state, profile_state, updated_at)
       VALUES (?, ?, ?, ?, 'hst_01J00000000000000000000022', 'OWNED_FIXTURE',
               'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
    ).bind(
      principalId,
      destinationSessionId,
      destinationJobId,
      destinationDeviceId,
      now,
    ),
    env.VILLAGE_DB.prepare(
      `INSERT INTO continuity_recipient_keys
       (principal_id, device_id, browser_session_id, site,
        encryption_public_key, device_signing_public_key,
        last_accepted_sequence, enrolled_at)
       VALUES (?, ?, ?, 'OWNED_FIXTURE', ?, ?, 1, ?)`,
    ).bind(
      principalId,
      destinationDeviceId,
      destinationSessionId,
      JSON.stringify({ kty: "OKP", crv: "X25519", x: "b".repeat(43) }),
      JSON.stringify(publicKey),
      now,
    ),
    env.VILLAGE_DB.prepare(
      `INSERT INTO continuity_grants
       (principal_id, grant_id, source_device_id, destination_device_id,
        source_browser_session_id, destination_browser_session_id, site,
        destination_encryption_public_key, source_signing_public_key,
        destination_signing_public_key, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'OWNED_FIXTURE', ?, ?, ?, 'ACTIVE', ?, ?)`,
    ).bind(
      principalId,
      grantId,
      sourceDeviceId,
      destinationDeviceId,
      sourceSessionId,
      destinationSessionId,
      JSON.stringify({ kty: "OKP", crv: "X25519", x: "b".repeat(43) }),
      JSON.stringify(publicKey),
      JSON.stringify(publicKey),
      now,
      "2026-08-16T18:00:00.000Z",
    ),
  ]);
  const mailbox = (
    env as unknown as {
      SITE_SESSION_MAILBOX: DurableObjectNamespace<SiteSessionMailbox>;
    }
  ).SITE_SESSION_MAILBOX.getByName(`${principalId}:${grantId}`);
  await mailbox.initialize({
    binding: {
      principalId,
      grantId,
      sourceDeviceId,
      destinationDeviceId,
      sourceBrowserSessionId: sourceSessionId,
      destinationBrowserSessionId: destinationSessionId,
      site: "OWNED_FIXTURE",
    },
    sourceSigningPublicKey: publicKey,
    destinationSigningPublicKey: publicKey,
    createdAt: now,
    expiresAt: "2026-08-16T18:00:00.000Z",
  });
  return mailbox;
}

beforeEach(async () => {
  await applyD1Migrations(env.VILLAGE_DB, env.TEST_MIGRATIONS!);
  await env.VILLAGE_DB.batch([
    env.VILLAGE_DB.prepare("DELETE FROM principal_deletion_plans"),
    env.VILLAGE_DB.prepare("DELETE FROM continuity_grants"),
    env.VILLAGE_DB.prepare("DELETE FROM principals"),
  ]);
  await seedPrincipal(principalId, "20");
  await seedPrincipal(otherPrincipalId, "21");
});

describe("principal data lifecycle", () => {
  it("declares lifecycle controls for every owner-exported history class", () => {
    expect(recordRetentionPolicies).toEqual(
      expect.objectContaining({
        PROJECTIONS: expect.objectContaining({
          scope: "PRINCIPAL",
          export: "AVAILABLE",
          deletion: "CASCADE_ON_PRINCIPAL_DELETE",
          backup: "EXPIRES_WITH_BACKUP_RETENTION",
        }),
        EVENTS: expect.objectContaining({ scope: "PRINCIPAL" }),
        CHECKPOINTS: expect.objectContaining({ scope: "PRINCIPAL" }),
        RECEIPTS: expect.objectContaining({ scope: "PRINCIPAL" }),
        WORKFLOW_EFFECTS: expect.objectContaining({ scope: "PRINCIPAL" }),
        WORKFLOW_ACTORS: expect.objectContaining({ scope: "PRINCIPAL" }),
        CANCELLATIONS: expect.objectContaining({ scope: "PRINCIPAL" }),
        CONTINUITY_GRANTS: expect.objectContaining({ scope: "PRINCIPAL" }),
        CONTINUITY_RECIPIENT_KEYS: expect.objectContaining({
          scope: "PRINCIPAL",
        }),
      }),
    );
    for (const policy of Object.values(recordRetentionPolicies)) {
      expect(policy.retentionDays).toBeGreaterThan(0);
      expect(policy.encryptionAtRest).toBe("CLOUDFLARE_MANAGED");
      expect(policy.verification).toBe("TOMBSTONE_AND_ABSENCE_CHECK");
    }
  });

  it("exports only the requesting principal's projections, events, checkpoints, and receipts", async () => {
    await expect(
      exportPrincipalRecords(env.VILLAGE_DB, principalId),
    ).resolves.toEqual(
      expect.objectContaining({
        principalId,
        projections: [
          expect.objectContaining({ browserSessionId, sequence: 1 }),
        ],
        events: [expect.objectContaining({ jobId, sequence: 1 })],
        checkpoints: [expect.objectContaining({ jobId })],
        receipts: [expect.objectContaining({ actionId })],
        workflowEffects: [
          expect.objectContaining({
            jobId,
            effectId: "efx_01J00000000000000000000020",
          }),
        ],
        cancellations: [expect.objectContaining({ jobId })],
        continuityGrants: [],
        continuityRecipientKeys: [],
      }),
    );
    const exported = await exportPrincipalRecords(env.VILLAGE_DB, principalId);
    expect(JSON.stringify(exported)).not.toContain(otherPrincipalId);
  });

  it("plans, executes, and verifies a deletion idempotently without deleting another principal", async () => {
    const mailbox = await seedContinuityMailbox();
    const coordinator =
      env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    const control: BrowserControlState = {
      principalId,
      deviceId: "dev_01J00000000000000000000020",
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
    await coordinator.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control,
    });
    const otherCoordinator = env.BROWSER_SESSION_COORDINATOR.getByName(
      "brs_01J00000000000000000000021",
    );
    await otherCoordinator.initialize({
      principalId: otherPrincipalId,
      browserSessionId: "brs_01J00000000000000000000021",
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: {
        ...control,
        principalId: otherPrincipalId,
        deviceId: "dev_01J00000000000000000000021",
        jobId: "job_01J00000000000000000000021",
        browserSessionId: "brs_01J00000000000000000000021",
      },
    });
    await expect(coordinator.lifecycleStatus(principalId)).resolves.toEqual({
      ok: true,
      state: "PRESENT",
    });
    const request = {
      principalId,
      deletionRequestId: "del_01J00000000000000000000020",
      requestedAt: now,
    };
    await expect(
      planPrincipalDeletion(env.VILLAGE_DB, request),
    ).resolves.toMatchObject({
      ok: true,
      status: "PLANNED",
    });
    await expect(
      planPrincipalDeletion(env.VILLAGE_DB, request),
    ).resolves.toMatchObject({
      ok: true,
      status: "PLANNED",
    });
    await expect(
      executePrincipalDeletion(env, request, "2026-08-12T18:05:00.000Z"),
    ).resolves.toMatchObject({
      ok: true,
      status: "COMPLETED",
      verification: { verified: true },
    });
    await expect(
      executePrincipalDeletion(env, request, "2026-08-12T18:10:00.000Z"),
    ).resolves.toMatchObject({
      ok: true,
      status: "COMPLETED",
      verification: { verified: true },
    });
    await expect(
      env.VILLAGE_DB.prepare(
        `SELECT completed_at AS completedAt FROM principal_deletion_plans
         WHERE principal_id = ? AND deletion_request_id = ?`,
      )
        .bind(principalId, request.deletionRequestId)
        .first(),
    ).resolves.toEqual({ completedAt: "2026-08-12T18:05:00.000Z" });
    await expect(
      verifyPrincipalDeletion(env.VILLAGE_DB, principalId),
    ).resolves.toEqual({
      verified: true,
      remainingRecords: 0,
    });
    await expect(mailbox.diagnostics(principalId)).resolves.toEqual({
      ok: false,
      code: "MAILBOX_NOT_FOUND",
    });
    await expect(coordinator.lifecycleStatus(principalId)).resolves.toEqual({
      ok: true,
      state: "ABSENT",
    });
    await expect(
      env.BROWSER_SESSION_COORDINATOR.getByName(
        "brs_01J00000000000000000000021",
      ).lifecycleStatus(otherPrincipalId),
    ).resolves.toEqual({ ok: true, state: "PRESENT" });
    await expect(
      exportPrincipalRecords(env.VILLAGE_DB, otherPrincipalId),
    ).resolves.toMatchObject({
      principalId: otherPrincipalId,
      receipts: [expect.any(Object)],
    });
  });

  it("expires bounded records only for terminal jobs", async () => {
    await env.VILLAGE_DB.prepare(
      "UPDATE jobs SET state = 'SUCCEEDED', updated_at = ? WHERE principal_id = ?",
    )
      .bind("2026-06-01T00:00:00.000Z", principalId)
      .run();
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        "UPDATE job_events SET occurred_at = ? WHERE principal_id = ?",
      ).bind("2026-06-01T00:00:00.000Z", principalId),
      env.VILLAGE_DB.prepare(
        "UPDATE checkpoints SET created_at = ? WHERE principal_id = ?",
      ).bind("2026-06-01T00:00:00.000Z", principalId),
      env.VILLAGE_DB.prepare(
        "UPDATE browser_session_event_projections SET occurred_at = ? WHERE principal_id = ?",
      ).bind("2026-06-01T00:00:00.000Z", principalId),
      env.VILLAGE_DB.prepare(
        "UPDATE action_receipts SET recorded_at = ? WHERE principal_id = ?",
      ).bind("2026-06-01T00:00:00.000Z", principalId),
      env.VILLAGE_DB.prepare(
        "UPDATE workflow_effect_projections SET updated_at = ? WHERE principal_id = ?",
      ).bind("2026-06-01T00:00:00.000Z", principalId),
      env.VILLAGE_DB.prepare(
        "UPDATE workflow_cancellations SET accepted_at = ? WHERE principal_id = ?",
      ).bind("2026-06-01T00:00:00.000Z", principalId),
    ]);

    await expect(
      executeRetentionBatch(env.VILLAGE_DB, now, 1),
    ).resolves.toEqual({ deleted: 6, hasMore: true });
    const exported = await exportPrincipalRecords(env.VILLAGE_DB, principalId);
    expect(exported).toMatchObject({
      projections: [],
      events: [],
      checkpoints: [],
      receipts: [],
      workflowEffects: [],
      cancellations: [],
    });
    const active = await exportPrincipalRecords(
      env.VILLAGE_DB,
      otherPrincipalId,
    );
    expect(active.events).toHaveLength(1);
  });

  it("prunes expired ceremony, quota, and projected outbox records", async () => {
    await env.VILLAGE_DB.prepare(
      "UPDATE jobs SET state = 'SUCCEEDED', updated_at = ? WHERE principal_id = ?",
    )
      .bind("2026-06-01T00:00:00.000Z", principalId)
      .run();
    await env.VILLAGE_DB.batch([
      env.VILLAGE_DB.prepare(
        `INSERT INTO pairing_challenges
         (principal_id, pairing_id, device_id, device_display_name, public_key_json,
          protection, secret_hash, fingerprint, attempts_remaining, state,
          created_at, expires_at)
         VALUES (?, 'par_01J00000000000000000000020',
          'dev_01J00000000000000000000020', 'Old Mac', '{}',
          'OS_PROTECTED_FALLBACK', 'hash', 'fingerprint', 0, 'EXPIRED', ?, ?)`,
      ).bind(
        principalId,
        "2026-05-01T00:00:00.000Z",
        "2026-05-01T00:05:00.000Z",
      ),
      env.VILLAGE_DB.prepare(
        `INSERT INTO authenticated_quota_usage
         (principal_id, device_id, window_started_at, connections)
         VALUES (?, 'dev_01J00000000000000000000020', '2026-06-01T00:00', 1)`,
      ).bind(principalId),
      env.VILLAGE_DB.prepare(
        `INSERT INTO authenticated_principal_quota_usage
         (principal_id, window_started_at, connections)
         VALUES (?, '2026-06-01T00:00', 1)`,
      ).bind(principalId),
      env.VILLAGE_DB.prepare(
        `INSERT INTO projection_outbox
         (principal_id, job_id, event_sequence, projection_type, payload_json,
          projected_at, created_at)
         VALUES (?, ?, 1, 'JOB', '{}', ?, ?)`,
      ).bind(
        principalId,
        jobId,
        "2026-06-01T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
      ),
    ]);

    await executeRetentionBatch(env.VILLAGE_DB, now, 100);
    for (const table of [
      "pairing_challenges",
      "authenticated_quota_usage",
      "authenticated_principal_quota_usage",
      "projection_outbox",
    ]) {
      await expect(
        env.VILLAGE_DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
          count: number;
        }>(),
      ).resolves.toEqual({ count: 0 });
    }
  });

  it("destroys terminal continuity ciphertext before deleting old grant metadata", async () => {
    const mailbox = await seedContinuityMailbox();
    await env.VILLAGE_DB.prepare(
      `UPDATE continuity_grants SET state = 'EXPIRED', expires_at = ?
       WHERE principal_id = ?`,
    )
      .bind("2026-06-01T00:00:00.000Z", principalId)
      .run();

    await executeCloudRetentionBatch(env, "2026-08-12T18:00:00.000Z", 100);
    await expect(mailbox.diagnostics(principalId)).resolves.toEqual({
      ok: false,
      code: "MAILBOX_NOT_FOUND",
    });
    await expect(
      env.VILLAGE_DB.prepare(
        "SELECT COUNT(*) AS count FROM continuity_grants WHERE principal_id = ?",
      )
        .bind(principalId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });
});
