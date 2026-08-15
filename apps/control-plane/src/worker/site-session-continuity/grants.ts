import {
  continuityAcknowledgementEnvelopeSchema,
  continuityFetchEnvelopeSchema,
  continuityGrantIdSchema,
  continuityGrantRequestSchema,
  deviceCredentialSchema,
  encryptedContinuityRevisionSchema,
  principalIdSchema,
  type ContinuityBinding,
} from "@village/contracts";
import type { Environment } from "../../env.js";

type GrantRow = {
  principal_id: string;
  grant_id: string;
  source_device_id: string;
  destination_device_id: string;
  source_browser_session_id: string;
  destination_browser_session_id: string;
  site: "OWNED_FIXTURE";
  destination_encryption_public_key: string | null;
  source_signing_public_key: string | null;
  destination_signing_public_key: string | null;
  state: "PENDING" | "ACTIVE" | "REVOKED" | "DELETING" | "DELETED" | "EXPIRED";
  created_at: string;
  expires_at: string;
};

type EligibleSessionRow = {
  device_id: string;
  site: string;
  profile_state: string;
  public_key: string;
  credential_status: string;
};

export async function createContinuityGrant(
  environment: Environment,
  principalIdCandidate: unknown,
  candidate: unknown,
  now: string,
) {
  const principal = principalIdSchema.safeParse(principalIdCandidate);
  const request = continuityGrantRequestSchema.safeParse(candidate);
  if (!principal.success || !request.success) {
    return { ok: false as const, code: "INVALID_CONTINUITY_GRANT" };
  }
  if (
    Date.parse(request.data.expiresAt) <= Date.parse(now) ||
    Date.parse(request.data.expiresAt) - Date.parse(now) > 30 * 24 * 60 * 60_000
  ) {
    return { ok: false as const, code: "INVALID_CONTINUITY_GRANT_EXPIRY" };
  }

  const [source, destination] = await Promise.all([
    eligibleSession(
      environment.VILLAGE_DB,
      principal.data,
      request.data.sourceBrowserSessionId,
    ),
    eligibleSession(
      environment.VILLAGE_DB,
      principal.data,
      request.data.destinationBrowserSessionId,
    ),
  ]);
  if (
    !source ||
    !destination ||
    source.device_id !== request.data.sourceDeviceId ||
    destination.device_id !== request.data.destinationDeviceId ||
    source.site !== request.data.site ||
    destination.site !== request.data.site ||
    source.profile_state !== "PRESENT" ||
    destination.profile_state !== "PRESENT" ||
    source.credential_status !== "ACTIVE" ||
    destination.credential_status !== "ACTIVE"
  ) {
    return { ok: false as const, code: "CONTINUITY_PAIR_NOT_ELIGIBLE" };
  }

  const sourceKey = parseSigningKey(source.public_key);
  const destinationKey = parseSigningKey(destination.public_key);
  if (!sourceKey || !destinationKey) {
    return { ok: false as const, code: "INVALID_DEVICE_CREDENTIAL" };
  }
  const binding: ContinuityBinding = {
    principalId: principal.data,
    grantId: request.data.grantId,
    sourceDeviceId: request.data.sourceDeviceId,
    destinationDeviceId: request.data.destinationDeviceId,
    sourceBrowserSessionId: request.data.sourceBrowserSessionId,
    destinationBrowserSessionId: request.data.destinationBrowserSessionId,
    site: request.data.site,
  };
  const keyStrings = {
    encryption: JSON.stringify(request.data.destinationEncryptionPublicKey),
    source: JSON.stringify(sourceKey),
    destination: JSON.stringify(destinationKey),
  };

  let existing = await grantRow(
    environment.VILLAGE_DB,
    principal.data,
    request.data.grantId,
  );
  if (
    existing &&
    !sameCreation(
      existing,
      binding,
      keyStrings.encryption,
      request.data.expiresAt,
    )
  ) {
    return { ok: false as const, code: "CONTINUITY_GRANT_CONFLICT" };
  }
  let created = false;
  if (!existing) {
    const inserted = await environment.VILLAGE_DB.prepare(
      `INSERT OR IGNORE INTO continuity_grants
       (principal_id, grant_id, source_device_id, destination_device_id,
        source_browser_session_id, destination_browser_session_id, site,
        destination_encryption_public_key, source_signing_public_key,
        destination_signing_public_key, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    )
      .bind(
        principal.data,
        binding.grantId,
        binding.sourceDeviceId,
        binding.destinationDeviceId,
        binding.sourceBrowserSessionId,
        binding.destinationBrowserSessionId,
        binding.site,
        keyStrings.encryption,
        keyStrings.source,
        keyStrings.destination,
        now,
        request.data.expiresAt,
      )
      .run();
    created = inserted.meta.changes === 1;
    existing = await grantRow(
      environment.VILLAGE_DB,
      principal.data,
      request.data.grantId,
    );
    if (
      !existing ||
      !sameCreation(
        existing,
        binding,
        keyStrings.encryption,
        request.data.expiresAt,
      )
    ) {
      return { ok: false as const, code: "CONTINUITY_GRANT_CONFLICT" };
    }
  }
  if (existing.state === "ACTIVE") {
    return { ok: true as const, grant: publicGrant(existing), created };
  }
  if (existing.state !== "PENDING") {
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_ACTIVE" };
  }

  const pinnedSourceKey = existing?.source_signing_public_key
    ? parseSigningKey(existing.source_signing_public_key)
    : sourceKey;
  const pinnedDestinationKey = existing?.destination_signing_public_key
    ? parseSigningKey(existing.destination_signing_public_key)
    : destinationKey;
  if (!pinnedSourceKey || !pinnedDestinationKey) {
    return { ok: false as const, code: "INVALID_DEVICE_CREDENTIAL" };
  }
  const initialized = await mailbox(environment, binding).initialize({
    binding,
    sourceSigningPublicKey: pinnedSourceKey,
    destinationSigningPublicKey: pinnedDestinationKey,
    createdAt: existing.created_at,
    expiresAt: request.data.expiresAt,
  });
  if (!initialized.ok) return initialized;
  await environment.VILLAGE_DB.prepare(
    `UPDATE continuity_grants SET state = 'ACTIVE'
     WHERE principal_id = ? AND grant_id = ? AND state = 'PENDING'`,
  )
    .bind(principal.data, binding.grantId)
    .run();
  const active = await grantRow(
    environment.VILLAGE_DB,
    principal.data,
    binding.grantId,
  );
  return {
    ok: true as const,
    grant: publicGrant(active!),
    created,
  };
}

export async function getContinuityGrant(
  environment: Environment,
  principalId: string,
  grantIdCandidate: unknown,
) {
  const grantId = continuityGrantIdSchema.safeParse(grantIdCandidate);
  if (!grantId.success)
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  const row = await grantRow(environment.VILLAGE_DB, principalId, grantId.data);
  if (!row || row.state === "DELETED") {
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  }
  return { ok: true as const, grant: publicGrant(row) };
}

export async function publishContinuityRevision(
  environment: Environment,
  routeGrantId: string,
  candidate: unknown,
  now: string,
) {
  const revision = encryptedContinuityRevisionSchema.safeParse(candidate);
  if (!revision.success || revision.data.grantId !== routeGrantId) {
    return { ok: false as const, code: "INVALID_CONTINUITY_REVISION" };
  }
  const eligible = await activeGrantForEnvelope(
    environment,
    revision.data,
    "SOURCE",
  );
  if (!eligible.ok) return eligible;
  return mailbox(environment, revision.data).publish(revision.data, now);
}

export async function fetchContinuityRevision(
  environment: Environment,
  routeGrantId: string,
  candidate: unknown,
  now: string,
) {
  const request = continuityFetchEnvelopeSchema.safeParse(candidate);
  if (!request.success || request.data.grantId !== routeGrantId) {
    return { ok: false as const, code: "INVALID_CONTINUITY_FETCH" };
  }
  const eligible = await activeGrantForEnvelope(
    environment,
    request.data,
    "DESTINATION",
  );
  if (!eligible.ok) return eligible;
  return mailbox(environment, request.data).fetchAfter(request.data, now);
}

export async function acknowledgeContinuityRevision(
  environment: Environment,
  routeGrantId: string,
  candidate: unknown,
  now: string,
) {
  const request = continuityAcknowledgementEnvelopeSchema.safeParse(candidate);
  if (!request.success || request.data.grantId !== routeGrantId) {
    return { ok: false as const, code: "INVALID_CONTINUITY_ACKNOWLEDGEMENT" };
  }
  const eligible = await activeGrantForEnvelope(
    environment,
    request.data,
    "DESTINATION",
  );
  if (!eligible.ok) return eligible;
  return mailbox(environment, request.data).acknowledge(request.data, now);
}

export async function deleteContinuityGrant(
  environment: Environment,
  principalId: string,
  grantIdCandidate: unknown,
  now: string,
) {
  const grantId = continuityGrantIdSchema.safeParse(grantIdCandidate);
  if (!grantId.success)
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  const row = await grantRow(environment.VILLAGE_DB, principalId, grantId.data);
  if (!row || row.state === "DELETED") {
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  }
  await environment.VILLAGE_DB.prepare(
    `UPDATE continuity_grants SET state = 'DELETING'
     WHERE principal_id = ? AND grant_id = ?`,
  )
    .bind(principalId, grantId.data)
    .run();
  const destroyed = await mailbox(environment, row).destroy(principalId);
  if (!destroyed.ok && destroyed.code !== "MAILBOX_NOT_FOUND") return destroyed;
  await environment.VILLAGE_DB.prepare(
    `UPDATE continuity_grants
     SET state = 'DELETED', destination_encryption_public_key = NULL,
         source_signing_public_key = NULL, destination_signing_public_key = NULL,
         deleted_at = ?
     WHERE principal_id = ? AND grant_id = ?`,
  )
    .bind(now, principalId, grantId.data)
    .run();
  return { ok: true as const, deleted: true as const };
}

export async function revokeContinuityGrant(
  environment: Environment,
  principalId: string,
  grantIdCandidate: unknown,
  now: string,
) {
  const grantId = continuityGrantIdSchema.safeParse(grantIdCandidate);
  if (!grantId.success) {
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  }
  const row = await grantRow(environment.VILLAGE_DB, principalId, grantId.data);
  if (!row || row.state !== "ACTIVE") {
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  }
  const revoked = await mailbox(environment, row).revoke({
    principalId,
    deviceId: row.source_device_id,
    revokedAt: now,
  });
  if (!revoked.ok) return revoked;
  await environment.VILLAGE_DB.prepare(
    `UPDATE continuity_grants SET state = 'REVOKED', revoked_at = ?
     WHERE principal_id = ? AND grant_id = ? AND state = 'ACTIVE'`,
  )
    .bind(now, principalId, grantId.data)
    .run();
  return { ok: true as const, revoked: true as const };
}

async function activeGrantForEnvelope(
  environment: Environment,
  binding: ContinuityBinding,
  actor: "SOURCE" | "DESTINATION",
) {
  const row = await grantRow(
    environment.VILLAGE_DB,
    binding.principalId,
    binding.grantId,
  );
  if (!row || row.state !== "ACTIVE" || !sameBinding(row, binding)) {
    return { ok: false as const, code: "CONTINUITY_GRANT_NOT_FOUND" };
  }
  const deviceId =
    actor === "SOURCE" ? binding.sourceDeviceId : binding.destinationDeviceId;
  const device = await environment.VILLAGE_DB.prepare(
    `SELECT credential_status, protocol_version, public_key FROM devices
     WHERE principal_id = ? AND device_id = ?`,
  )
    .bind(binding.principalId, deviceId)
    .first<{
      credential_status: string;
      protocol_version: number;
      public_key: string;
    }>();
  if (!device || device.credential_status !== "ACTIVE") {
    await revokeForDeviceChange(
      environment,
      row,
      deviceId,
      new Date().toISOString(),
    );
    return { ok: false as const, code: "DEVICE_REVOKED_OR_UNKNOWN" };
  }
  if (device.protocol_version !== 1) {
    return { ok: false as const, code: "PROTOCOL_DOWNGRADE_REJECTED" };
  }
  const pinnedKey = parseSigningKey(
    actor === "SOURCE"
      ? (row.source_signing_public_key ?? "")
      : (row.destination_signing_public_key ?? ""),
  );
  const currentKey = parseSigningKey(device.public_key);
  if (!pinnedKey || !currentKey || !sameSigningKey(pinnedKey, currentKey)) {
    await revokeForDeviceChange(
      environment,
      row,
      deviceId,
      new Date().toISOString(),
    );
    return { ok: false as const, code: "DEVICE_CREDENTIAL_CHANGED" };
  }
  return { ok: true as const };
}

async function revokeForDeviceChange(
  environment: Environment,
  row: GrantRow,
  deviceId: string,
  now: string,
) {
  await mailbox(environment, row).revoke({
    principalId: row.principal_id,
    deviceId,
    revokedAt: now,
  });
  await environment.VILLAGE_DB.prepare(
    `UPDATE continuity_grants SET state = 'REVOKED', revoked_at = ?
     WHERE principal_id = ? AND grant_id = ? AND state = 'ACTIVE'`,
  )
    .bind(now, row.principal_id, row.grant_id)
    .run();
}

async function eligibleSession(
  db: D1Database,
  principalId: string,
  browserSessionId: string,
) {
  return db
    .prepare(
      `SELECT s.device_id, s.site, s.profile_state, d.public_key, d.credential_status
       FROM browser_sessions s JOIN devices d
         ON d.principal_id = s.principal_id AND d.device_id = s.device_id
       WHERE s.principal_id = ? AND s.browser_session_id = ?`,
    )
    .bind(principalId, browserSessionId)
    .first<EligibleSessionRow>();
}

async function grantRow(db: D1Database, principalId: string, grantId: string) {
  return db
    .prepare(
      "SELECT * FROM continuity_grants WHERE principal_id = ? AND grant_id = ?",
    )
    .bind(principalId, grantId)
    .first<GrantRow>();
}

function mailbox(
  environment: Environment,
  binding: ContinuityBinding | GrantRow,
) {
  const identity =
    "principalId" in binding
      ? { principalId: binding.principalId, grantId: binding.grantId }
      : { principalId: binding.principal_id, grantId: binding.grant_id };
  return environment.SITE_SESSION_MAILBOX.getByName(
    `${identity.principalId}:${identity.grantId}`,
  );
}

function parseSigningKey(value: string) {
  try {
    return deviceCredentialSchema.shape.publicKey.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function sameSigningKey(
  left: { kty: "OKP"; crv: "Ed25519"; x: string },
  right: { kty: "OKP"; crv: "Ed25519"; x: string },
) {
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x;
}

function sameBinding(row: GrantRow, binding: ContinuityBinding) {
  return (
    row.principal_id === binding.principalId &&
    row.grant_id === binding.grantId &&
    row.source_device_id === binding.sourceDeviceId &&
    row.destination_device_id === binding.destinationDeviceId &&
    row.source_browser_session_id === binding.sourceBrowserSessionId &&
    row.destination_browser_session_id ===
      binding.destinationBrowserSessionId &&
    row.site === binding.site
  );
}

function sameCreation(
  row: GrantRow,
  binding: ContinuityBinding,
  destinationEncryptionPublicKey: string,
  expiresAt: string,
) {
  return (
    sameBinding(row, binding) &&
    row.destination_encryption_public_key === destinationEncryptionPublicKey &&
    row.expires_at === expiresAt
  );
}

function publicGrant(row: GrantRow) {
  return {
    grantId: row.grant_id,
    sourceDeviceId: row.source_device_id,
    destinationDeviceId: row.destination_device_id,
    sourceBrowserSessionId: row.source_browser_session_id,
    destinationBrowserSessionId: row.destination_browser_session_id,
    site: row.site,
    state: row.state,
    destinationEncryptionPublicKey: row.destination_encryption_public_key
      ? JSON.parse(row.destination_encryption_public_key)
      : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
