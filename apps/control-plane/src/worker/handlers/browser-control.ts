import {
  browserControlStateSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  hostIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  type SignedCommandEnvelope,
  type SignedResultEnvelope,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../../env.js";
import {
  verifyCommandEnvelope,
  verifyResultEnvelope,
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
    `SELECT j.state AS job_state, d.credential_status AS device_status
     FROM jobs j JOIN devices d ON d.principal_id = j.principal_id
     WHERE j.principal_id = ? AND j.job_id = ? AND d.device_id = ?`,
  )
    .bind(input.principalId, input.jobId, input.deviceId)
    .first<{ job_state: string; device_status: string }>();
  if (
    !eligible ||
    eligible.job_state !== "QUEUED" ||
    eligible.device_status !== "ACTIVE"
  ) {
    return { ok: false as const, code: "JOB_OR_DEVICE_NOT_ELIGIBLE" };
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
  const initialized = await environment.BROWSER_SESSION_COORDINATOR.getByName(
    input.browserSessionId,
  ).initialize({
    principalId: input.principalId,
    browserSessionId: input.browserSessionId,
    site: input.site,
    initializedAt: input.now,
    control,
  });
  return initialized.ok
    ? { ok: true as const, browserSessionId: input.browserSessionId }
    : { ok: false as const, code: initialized.code };
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
