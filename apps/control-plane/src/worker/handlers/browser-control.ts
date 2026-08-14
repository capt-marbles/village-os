import {
  automationSyncResponseSchema,
  automationSyncRequestSchema,
  browserControlStateSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  hostIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  workflowOperationRequestSchema,
  workflowOperationResponseSchema,
  type SignedCommandEnvelope,
  type SignedResultEnvelope,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../../env.js";
import {
  verifyAutomationSyncRequest,
  verifyCommandEnvelope,
  verifyResultEnvelope,
  verifyWorkflowOperationRequest,
} from "../browser-control/device-credentials.js";
import { consumeAuthenticatedQuota } from "../limits/quotas.js";

type DeviceRow = {
  public_key: string;
  credential_status: "ACTIVE" | "REVOKED";
  protocol_version: number;
};

const createSessionSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  hostId: hostIdSchema,
  site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
  now: instantSchema,
});

export async function createOwnedBrowserSession(
  environment: Environment,
  candidate: unknown,
) {
  const parsed = createSessionSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false as const, code: "INVALID_SESSION_REQUEST" };
  const input = parsed.data;
  const eligible = await environment.VILLAGE_DB.prepare(
    `SELECT j.state AS job_state, d.credential_status AS device_status,
            j.objective_kind, j.objective_version
     FROM jobs j JOIN devices d ON d.principal_id = j.principal_id
     WHERE j.principal_id = ? AND j.job_id = ? AND d.device_id = ?`,
  )
    .bind(input.principalId, input.jobId, input.deviceId)
    .first<{
      job_state: string;
      device_status: string;
      objective_kind: string | null;
      objective_version: number | null;
    }>();
  if (
    !eligible ||
    eligible.job_state !== "QUEUED" ||
    eligible.device_status !== "ACTIVE"
  ) {
    return { ok: false as const, code: "JOB_OR_DEVICE_NOT_ELIGIBLE" };
  }
  if (
    eligible.objective_kind === "OWNED_FIXTURE_ACCOUNT_SETUP_V1" &&
    input.site !== "OWNED_FIXTURE"
  ) {
    return { ok: false as const, code: "DESTINATION_SITE_MISMATCH" };
  }
  const control = browserControlStateSchema.parse({
    principalId: input.principalId,
    deviceId: input.deviceId,
    jobId: input.jobId,
    browserSessionId: input.browserSessionId,
    controller: "NONE",
    connection: "ONLINE",
    leaseEpoch: 0,
    leaseExpiresAt: null,
    lastAcceptedSequence: 0,
    automationBlocked: true,
    takeover: "NONE",
    profile: "PRESENT",
  });
  try {
    await environment.VILLAGE_DB.batch([
      environment.VILLAGE_DB.prepare(
        `INSERT INTO browser_sessions
         (principal_id, browser_session_id, job_id, device_id, host_id, site,
          controller, connection_state, lease_epoch, last_accepted_sequence,
          automation_blocked, takeover_state, profile_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'NONE', 'ONLINE', 0, 0, 1, 'NONE', 'PRESENT', ?)`,
      ).bind(
        input.principalId,
        input.browserSessionId,
        input.jobId,
        input.deviceId,
        input.hostId,
        input.site,
        input.now,
      ),
      environment.VILLAGE_DB.prepare(
        `UPDATE jobs SET browser_session_id = ?, state = 'WAITING_FOR_BROWSER',
                         version = 2, last_event_sequence = 2, updated_at = ?
         WHERE principal_id = ? AND job_id = ? AND state = 'QUEUED' AND version = 1`,
      ).bind(input.browserSessionId, input.now, input.principalId, input.jobId),
      environment.VILLAGE_DB.prepare(
        `INSERT INTO job_events
         (principal_id, job_id, event_id, sequence, event_type, payload_json, occurred_at)
         VALUES (?, ?, ?, 2, 'BROWSER_HOST_UNAVAILABLE', '{}', ?)`,
      ).bind(
        input.principalId,
        input.jobId,
        `evt_${input.browserSessionId.slice(4)}`,
        input.now,
      ),
    ]);
  } catch {
    return { ok: false as const, code: "SESSION_CONFLICT" };
  }
  const coordinator = environment.BROWSER_SESSION_COORDINATOR.getByName(
    input.browserSessionId,
  );
  const initialized = await coordinator.initialize({
    principalId: input.principalId,
    browserSessionId: input.browserSessionId,
    site: input.site,
    initializedAt: input.now,
    control,
  });
  if (!initialized.ok) return { ok: false as const, code: initialized.code };
  if (
    eligible.objective_kind === "OWNED_FIXTURE_ACCOUNT_SETUP_V1" &&
    eligible.objective_version === 1
  ) {
    const workflow = await coordinator.initializeWorkflow({
      principalId: input.principalId,
      deviceId: input.deviceId,
      jobId: input.jobId,
      browserSessionId: input.browserSessionId,
      objective: { kind: eligible.objective_kind, version: 1 },
      jobRevision: 2,
      logicalStep: "SET_DISPLAY_NAME",
      effectId: `efx_${input.browserSessionId.slice(4)}`,
      initializedAt: input.now,
    });
    if (!workflow.ok) return workflow;
  }
  return { ok: true as const, browserSessionId: input.browserSessionId };
}

async function authenticatedDevice(
  environment: Environment,
  envelope: SignedCommandEnvelope,
) {
  const device = await environment.VILLAGE_DB.prepare(
    `SELECT public_key, credential_status, protocol_version FROM devices
     WHERE principal_id = ? AND device_id = ?`,
  )
    .bind(envelope.principalId, envelope.deviceId)
    .first<DeviceRow>();
  if (!device || device.credential_status !== "ACTIVE") {
    return { ok: false as const, code: "DEVICE_REVOKED_OR_UNKNOWN" };
  }
  if (device.protocol_version !== envelope.protocolVersion) {
    return { ok: false as const, code: "PROTOCOL_DOWNGRADE_REJECTED" };
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = JSON.parse(device.public_key) as JsonWebKey;
  } catch {
    return { ok: false as const, code: "INVALID_DEVICE_CREDENTIAL" };
  }
  if (!(await verifyCommandEnvelope(envelope, publicKey))) {
    return { ok: false as const, code: "INVALID_SIGNATURE" };
  }
  return { ok: true as const };
}

async function authenticatedResultDevice(
  environment: Environment,
  envelope: SignedResultEnvelope,
) {
  const device = await environment.VILLAGE_DB.prepare(
    `SELECT public_key, credential_status, protocol_version FROM devices
     WHERE principal_id = ? AND device_id = ?`,
  )
    .bind(envelope.principalId, envelope.deviceId)
    .first<DeviceRow>();
  if (!device || device.credential_status !== "ACTIVE") {
    return { ok: false as const, code: "DEVICE_REVOKED_OR_UNKNOWN" };
  }
  if (device.protocol_version !== envelope.protocolVersion) {
    return { ok: false as const, code: "PROTOCOL_DOWNGRADE_REJECTED" };
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = JSON.parse(device.public_key) as JsonWebKey;
  } catch {
    return { ok: false as const, code: "INVALID_DEVICE_CREDENTIAL" };
  }
  if (!(await verifyResultEnvelope(envelope, publicKey))) {
    return { ok: false as const, code: "INVALID_SIGNATURE" };
  }
  return { ok: true as const };
}

export async function dispatchAuthenticatedCommand(
  environment: Environment,
  candidate: unknown,
  connectionId: string,
  now: string,
  expectedSessionId?: string,
) {
  const parsed = signedCommandEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false as const, code: "INVALID_ENVELOPE" };
  const envelope: SignedCommandEnvelope = parsed.data;
  if (
    expectedSessionId !== undefined &&
    envelope.browserSessionId !== expectedSessionId
  ) {
    return { ok: false as const, code: "SESSION_ROUTE_MISMATCH" };
  }
  const authenticated = await authenticatedDevice(environment, envelope);
  if (!authenticated.ok) return authenticated;
  const quota = await consumeAuthenticatedQuota(
    environment.VILLAGE_DB,
    envelope.principalId,
    envelope.deviceId,
    "commands",
    now,
  );
  if (!quota.ok) return quota;
  return environment.BROWSER_SESSION_COORDINATOR.getByName(
    envelope.browserSessionId,
  ).acceptAuthenticatedCommand({ envelope, connectionId, now });
}

export async function dispatchAuthenticatedSessionOpen(
  environment: Environment,
  candidate: unknown,
  connectionId: string,
  now: string,
  expectedSessionId?: string,
) {
  const parsed = signedCommandEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false as const, code: "INVALID_ENVELOPE" };
  const envelope = parsed.data;
  if (
    expectedSessionId !== undefined &&
    envelope.browserSessionId !== expectedSessionId
  ) {
    return { ok: false as const, code: "SESSION_ROUTE_MISMATCH" };
  }
  if (envelope.command.capability !== "SESSION_OPEN") {
    return { ok: false as const, code: "SESSION_OPEN_REQUIRED" };
  }
  if (
    Date.parse(envelope.issuedAt) > Date.parse(now) ||
    Date.parse(envelope.expiresAt) <= Date.parse(now)
  ) {
    return { ok: false as const, code: "ENVELOPE_EXPIRED_OR_NOT_YET_VALID" };
  }
  const authenticated = await authenticatedDevice(environment, envelope);
  if (!authenticated.ok) return authenticated;
  const quota = await consumeAuthenticatedQuota(
    environment.VILLAGE_DB,
    envelope.principalId,
    envelope.deviceId,
    "connections",
    now,
  );
  if (!quota.ok) return quota;
  const session = await environment.VILLAGE_DB.prepare(
    `SELECT site FROM browser_sessions
     WHERE principal_id = ? AND browser_session_id = ? AND job_id = ? AND device_id = ?`,
  )
    .bind(
      envelope.principalId,
      envelope.browserSessionId,
      envelope.jobId,
      envelope.deviceId,
    )
    .first<{ site: "OWNED_FIXTURE" | "LINKEDIN" }>();
  if (!session) return { ok: false as const, code: "SESSION_NOT_OWNED" };
  if (session.site !== envelope.command.site) {
    return { ok: false as const, code: "DESTINATION_SITE_MISMATCH" };
  }
  const claimed = await environment.BROWSER_SESSION_COORDINATOR.getByName(
    envelope.browserSessionId,
  ).claimAgentLease({
    principalId: envelope.principalId,
    deviceId: envelope.deviceId,
    connectionId,
    now,
    expiresAt: envelope.expiresAt,
    commandSequence: envelope.sequence,
  });
  if (!claimed.ok) return claimed;
  const jobProjection = await environment.VILLAGE_DB.prepare(
    `SELECT state, version FROM jobs WHERE principal_id = ? AND job_id = ?`,
  )
    .bind(envelope.principalId, envelope.jobId)
    .first<{ state: string; version: number }>();
  if (
    jobProjection?.state !== "WAITING_FOR_BROWSER" ||
    jobProjection.version !== 2
  ) {
    return { ...claimed, jobProjection: "LAGGING" as const };
  }
  try {
    await environment.VILLAGE_DB.batch([
      environment.VILLAGE_DB.prepare(
        `UPDATE jobs SET state = 'RUNNING_AGENT', version = 3,
                         last_event_sequence = 3, updated_at = ?
         WHERE principal_id = ? AND job_id = ?
           AND state = 'WAITING_FOR_BROWSER' AND version = 2`,
      ).bind(now, envelope.principalId, envelope.jobId),
      environment.VILLAGE_DB.prepare(
        `INSERT INTO job_events
         (principal_id, job_id, event_id, sequence, event_type, payload_json, occurred_at)
         VALUES (?, ?, ?, 3, 'BROWSER_HOST_AVAILABLE', ?, ?)`,
      ).bind(
        envelope.principalId,
        envelope.jobId,
        `evt_${envelope.actionId.slice(4)}`,
        JSON.stringify({ browserSessionId: envelope.browserSessionId }),
        now,
      ),
    ]);
    return { ...claimed, jobProjection: "CURRENT" as const };
  } catch {
    return { ...claimed, jobProjection: "LAGGING" as const };
  }
}

export async function dispatchAuthenticatedResult(
  environment: Environment,
  candidate: unknown,
  connectionId: string,
  now: string,
  expectedSessionId?: string,
) {
  const parsed = signedResultEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false as const, code: "INVALID_ENVELOPE" };
  const envelope = parsed.data;
  if (
    expectedSessionId !== undefined &&
    envelope.browserSessionId !== expectedSessionId
  ) {
    return { ok: false as const, code: "SESSION_ROUTE_MISMATCH" };
  }
  const authenticated = await authenticatedResultDevice(environment, envelope);
  if (!authenticated.ok) return authenticated;
  const quota = await consumeAuthenticatedQuota(
    environment.VILLAGE_DB,
    envelope.principalId,
    envelope.deviceId,
    "commands",
    now,
  );
  if (!quota.ok) return quota;
  return environment.BROWSER_SESSION_COORDINATOR.getByName(
    envelope.browserSessionId,
  ).acceptAuthenticatedResult({ envelope, connectionId, now });
}

export async function dispatchAuthenticatedAutomationSync(
  environment: Environment,
  candidate: unknown,
  connectionId: string,
  now: string,
  expectedSessionId?: string,
) {
  const parsed = automationSyncRequestSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false as const, code: "INVALID_ENVELOPE" };
  const envelope = parsed.data;
  if (envelope.connectionId !== connectionId) {
    return { ok: false as const, code: "CONNECTION_ID_MISMATCH" };
  }
  if (
    expectedSessionId !== undefined &&
    envelope.browserSessionId !== expectedSessionId
  ) {
    return { ok: false as const, code: "SESSION_ROUTE_MISMATCH" };
  }
  if (
    Date.parse(envelope.issuedAt) > Date.parse(now) ||
    Date.parse(envelope.expiresAt) <= Date.parse(now)
  ) {
    return {
      ok: false as const,
      code: "ENVELOPE_EXPIRED_OR_NOT_YET_VALID",
    };
  }
  const device = await environment.VILLAGE_DB.prepare(
    `SELECT public_key, credential_status, protocol_version FROM devices
     WHERE principal_id = ? AND device_id = ?`,
  )
    .bind(envelope.principalId, envelope.deviceId)
    .first<DeviceRow>();
  if (!device || device.credential_status !== "ACTIVE") {
    return { ok: false as const, code: "DEVICE_REVOKED_OR_UNKNOWN" };
  }
  if (device.protocol_version !== envelope.protocolVersion) {
    return { ok: false as const, code: "PROTOCOL_DOWNGRADE_REJECTED" };
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = JSON.parse(device.public_key) as JsonWebKey;
  } catch {
    return { ok: false as const, code: "INVALID_DEVICE_CREDENTIAL" };
  }
  if (!(await verifyAutomationSyncRequest(envelope, publicKey))) {
    return { ok: false as const, code: "INVALID_SIGNATURE" };
  }
  const session = await environment.VILLAGE_DB.prepare(
    `SELECT 1 AS owned FROM browser_sessions
     WHERE principal_id = ? AND device_id = ? AND browser_session_id = ?`,
  )
    .bind(envelope.principalId, envelope.deviceId, envelope.browserSessionId)
    .first<{ owned: number }>();
  if (!session) return { ok: false as const, code: "SESSION_NOT_OWNED" };
  const accepted = await environment.VILLAGE_DB.prepare(
    `UPDATE devices SET last_automation_sync_sequence = ?
     WHERE principal_id = ? AND device_id = ? AND credential_status = 'ACTIVE'
       AND protocol_version = ?
       AND last_automation_sync_sequence < ?`,
  )
    .bind(
      envelope.sequence,
      envelope.principalId,
      envelope.deviceId,
      envelope.protocolVersion,
      envelope.sequence,
    )
    .run();
  if (accepted.meta.changes !== 1) {
    return { ok: false as const, code: "REPLAYED_SEQUENCE" };
  }
  const snapshot = await environment.BROWSER_SESSION_COORDINATOR.getByName(
    envelope.browserSessionId,
  ).snapshot(envelope.principalId);
  if (!snapshot.ok) return snapshot;
  if (
    snapshot.control.deviceId !== envelope.deviceId ||
    snapshot.control.browserSessionId !== envelope.browserSessionId
  ) {
    return { ok: false as const, code: "SESSION_NOT_OWNED" };
  }
  const workflowSnapshot =
    await environment.BROWSER_SESSION_COORDINATOR.getByName(
      envelope.browserSessionId,
    ).workflowSnapshot(envelope.principalId);
  if (!workflowSnapshot.ok) return workflowSnapshot;
  const checkpoint = workflowSnapshot.checkpoint;
  const currentEffect = checkpoint
    ? workflowSnapshot.effects.find(
        (effect) => effect.effectId === checkpoint.currentEffectId,
      )
    : workflowSnapshot.effects[0];
  const workflow =
    workflowSnapshot.jobRevision === null || currentEffect === undefined
      ? null
      : {
          objective: {
            kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
            version: 1 as const,
          },
          jobRevision: workflowSnapshot.jobRevision,
          logicalStep: currentEffect.logicalStep,
          effectId: currentEffect.effectId,
          completedEffects: checkpoint?.completedEffects ?? [],
          actionPhase: currentEffect.phase,
          outstandingAction:
            currentEffect.canonicalActionId === null ||
            currentEffect.phase === "RECEIPTED"
              ? null
              : {
                  actionId: currentEffect.canonicalActionId,
                  logicalStep: currentEffect.logicalStep,
                  effectId: currentEffect.effectId,
                  leaseEpoch: snapshot.control.leaseEpoch,
                },
        };
  return automationSyncResponseSchema.parse({
    ok: true as const,
    cursor: snapshot.eventSequence,
    jobId: snapshot.control.jobId,
    controller: snapshot.control.controller,
    connection: snapshot.control.connection,
    leaseEpoch: snapshot.control.leaseEpoch,
    automationBlocked: snapshot.control.automationBlocked,
    canceled: snapshot.canceled,
    workflow,
  });
}

export async function dispatchAuthenticatedWorkflowOperation(
  environment: Environment,
  candidate: unknown,
  connectionId: string,
  now: string,
  expectedSessionId?: string,
) {
  const parsed = workflowOperationRequestSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false as const, code: "INVALID_ENVELOPE" };
  const envelope = parsed.data;
  if (envelope.connectionId !== connectionId) {
    return { ok: false as const, code: "CONNECTION_ID_MISMATCH" };
  }
  if (
    expectedSessionId !== undefined &&
    envelope.browserSessionId !== expectedSessionId
  ) {
    return { ok: false as const, code: "SESSION_ROUTE_MISMATCH" };
  }
  if (
    Date.parse(envelope.issuedAt) > Date.parse(now) ||
    Date.parse(envelope.expiresAt) <= Date.parse(now)
  ) {
    return { ok: false as const, code: "ENVELOPE_EXPIRED_OR_NOT_YET_VALID" };
  }
  const device = await environment.VILLAGE_DB.prepare(
    `SELECT public_key, credential_status, protocol_version FROM devices
     WHERE principal_id = ? AND device_id = ?`,
  )
    .bind(envelope.principalId, envelope.deviceId)
    .first<DeviceRow>();
  if (!device || device.credential_status !== "ACTIVE") {
    return { ok: false as const, code: "DEVICE_REVOKED_OR_UNKNOWN" };
  }
  if (device.protocol_version !== envelope.protocolVersion) {
    return { ok: false as const, code: "PROTOCOL_DOWNGRADE_REJECTED" };
  }
  let publicKey: JsonWebKey;
  try {
    publicKey = JSON.parse(device.public_key) as JsonWebKey;
  } catch {
    return { ok: false as const, code: "INVALID_DEVICE_CREDENTIAL" };
  }
  if (!(await verifyWorkflowOperationRequest(envelope, publicKey))) {
    return { ok: false as const, code: "INVALID_SIGNATURE" };
  }
  const session = await environment.VILLAGE_DB.prepare(
    `SELECT 1 AS owned FROM browser_sessions
     WHERE principal_id = ? AND device_id = ? AND job_id = ? AND browser_session_id = ?`,
  )
    .bind(
      envelope.principalId,
      envelope.deviceId,
      envelope.jobId,
      envelope.browserSessionId,
    )
    .first<{ owned: number }>();
  if (!session) return { ok: false as const, code: "SESSION_NOT_OWNED" };
  const accepted = await environment.VILLAGE_DB.prepare(
    `UPDATE devices SET last_workflow_operation_sequence = ?
     WHERE principal_id = ? AND device_id = ? AND credential_status = 'ACTIVE'
       AND protocol_version = ? AND last_workflow_operation_sequence < ?`,
  )
    .bind(
      envelope.sequence,
      envelope.principalId,
      envelope.deviceId,
      envelope.protocolVersion,
      envelope.sequence,
    )
    .run();
  if (accepted.meta.changes !== 1) {
    return { ok: false as const, code: "REPLAYED_SEQUENCE" };
  }
  const coordinator = environment.BROWSER_SESSION_COORDINATOR.getByName(
    envelope.browserSessionId,
  );
  if (envelope.operation === "RECORD_RECEIPT") {
    const result = await coordinator.recordWorkflowReceipt({
      receipt: envelope.receipt,
      checkpoint: envelope.checkpoint,
      connectionId,
    });
    return result.ok
      ? workflowOperationResponseSchema.parse({
          ok: true,
          operation: envelope.operation,
          cursor: result.eventSequence,
        })
      : result;
  }
  if (envelope.operation === "CLAIM_FRESH_LEASE") {
    const result = await coordinator.claimFreshWorkflowLease({
      principalId: envelope.principalId,
      deviceId: envelope.deviceId,
      jobId: envelope.jobId,
      browserSessionId: envelope.browserSessionId,
      connectionId,
      afterLeaseEpoch: envelope.afterLeaseEpoch,
      cursor: envelope.cursor,
      now,
      expiresAt: envelope.leaseExpiresAt,
    });
    return result.ok
      ? workflowOperationResponseSchema.parse({
          ok: true,
          operation: envelope.operation,
          cursor: result.eventSequence,
          leaseEpoch: result.leaseEpoch,
        })
      : result;
  }
  if (envelope.operation === "TAKEOVER") {
    const result = await coordinator.takeoverWorkflowControl({
      principalId: envelope.principalId,
      deviceId: envelope.deviceId,
      jobId: envelope.jobId,
      browserSessionId: envelope.browserSessionId,
      connectionId,
      expectedLeaseEpoch: envelope.expectedLeaseEpoch,
      cursor: envelope.cursor,
      now,
    });
    return result.ok
      ? workflowOperationResponseSchema.parse({
          ok: true,
          operation: envelope.operation,
          cursor: result.eventSequence,
          leaseEpoch: result.leaseEpoch,
        })
      : result;
  }
  const result = await coordinator.recordOwnerProgress({
    principalId: envelope.principalId,
    deviceId: envelope.deviceId,
    jobId: envelope.jobId,
    browserSessionId: envelope.browserSessionId,
    objective: envelope.objective,
    jobRevision: envelope.jobRevision,
    logicalStep: envelope.logicalStep,
    effectId: envelope.effectId,
    actionPhase: envelope.actionPhase,
    leaseEpoch: envelope.leaseEpoch,
    cursor: envelope.cursor,
    actor: envelope.actor,
    occurredAt: envelope.occurredAt,
  });
  return result.ok
    ? workflowOperationResponseSchema.parse({
        ok: true,
        operation: envelope.operation,
        cursor: result.eventSequence,
      })
    : result;
}
