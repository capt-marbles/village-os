import {
  continuityAcknowledgementEnvelopeSchema,
  continuityActivationRequestSchema,
  continuityActivationResponseSchema,
  continuityFetchEnvelopeSchema,
  continuityGrantIdSchema,
  continuityGrantRequestSchema,
  continuityRecipientKeyEnrollmentSchema,
  continuityRecipientKeyRevocationSchema,
  deviceCredentialSchema,
  encryptedContinuityRevisionSchema,
  principalIdSchema,
  x25519PublicKeySchema,
  type ContinuityBinding,
} from "@village/contracts";
import type { Environment } from "../../env.js";
import {
  verifyContinuityActivationRequest,
  verifyContinuityRecipientKeyEnrollment,
} from "../browser-control/device-credentials.js";

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
  protocol_version: number;
};

type ActivationGrantRow = GrantRow & {
  destination_encryption_public_key: string;
  source_signing_public_key: string;
  destination_signing_public_key: string;
};

export async function getContinuityActivations(
  environment: Environment,
  candidate: unknown,
  now: string,
) {
  const request = continuityActivationRequestSchema.safeParse(candidate);
  if (!request.success) {
    return { ok: false as const, code: "INVALID_CONTINUITY_ACTIVATION" };
  }
  if (
    Date.parse(request.data.issuedAt) > Date.parse(now) + 5_000 ||
    Date.parse(request.data.expiresAt) <= Date.parse(now)
  ) {
    return { ok: false as const, code: "CONTINUITY_ACTIVATION_EXPIRED" };
  }
  const session = await eligibleSession(
    environment.VILLAGE_DB,
    request.data.principalId,
    request.data.browserSessionId,
  );
  if (
    !session ||
    session.device_id !== request.data.deviceId ||
    session.site !== request.data.site ||
    session.profile_state !== "PRESENT" ||
    session.credential_status !== "ACTIVE" ||
    session.protocol_version !== 1
  ) {
    return { ok: false as const, code: "CONTINUITY_SESSION_NOT_ELIGIBLE" };
  }
  const signingKey = parseSigningKey(session.public_key);
  if (
    !signingKey ||
    !(await verifyContinuityActivationRequest(request.data, signingKey))
  ) {
    return { ok: false as const, code: "INVALID_DEVICE_SIGNATURE" };
  }
  const accepted = await environment.VILLAGE_DB.prepare(
    `UPDATE browser_sessions
     SET last_continuity_activation_sequence = ?
     WHERE principal_id = ? AND browser_session_id = ? AND device_id = ?
       AND site = ? AND last_continuity_activation_sequence < ?`,
  )
    .bind(
      request.data.sequence,
      request.data.principalId,
      request.data.browserSessionId,
      request.data.deviceId,
      request.data.site,
      request.data.sequence,
    )
    .run();
  if (accepted.meta.changes !== 1) {
    return { ok: false as const, code: "CONTINUITY_ACTIVATION_REPLAYED" };
  }

  const rows = await environment.VILLAGE_DB.prepare(
    `SELECT * FROM continuity_grants
     WHERE principal_id = ? AND site = ? AND state = 'ACTIVE'
       AND expires_at > ?
       AND ((source_device_id = ? AND source_browser_session_id = ?)
         OR (destination_device_id = ? AND destination_browser_session_id = ?))
     ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(
      request.data.principalId,
      request.data.site,
      now,
      request.data.deviceId,
      request.data.browserSessionId,
      request.data.deviceId,
      request.data.browserSessionId,
    )
    .all<ActivationGrantRow>();
  const activations = rows.results.map((row) => {
    const binding: ContinuityBinding = {
      principalId: row.principal_id,
      grantId: row.grant_id,
      sourceDeviceId: row.source_device_id,
      destinationDeviceId: row.destination_device_id,
      sourceBrowserSessionId: row.source_browser_session_id,
      destinationBrowserSessionId: row.destination_browser_session_id,
      site: row.site,
    };
    if (
      row.source_device_id === request.data.deviceId &&
      row.source_browser_session_id === request.data.browserSessionId
    ) {
      return {
        role: "SOURCE" as const,
        binding,
        peerSigningPublicKey: parseRequiredSigningKey(
          row.destination_signing_public_key,
        ),
        destinationEncryptionPublicKey: parseRequiredEncryptionKey(
          row.destination_encryption_public_key,
        ),
      };
    }
    return {
      role: "DESTINATION" as const,
      binding,
      peerSigningPublicKey: parseRequiredSigningKey(
        row.source_signing_public_key,
      ),
    };
  });
  return continuityActivationResponseSchema.parse({ ok: true, activations });
}

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
  const enrolledRecipientKey = await environment.VILLAGE_DB.prepare(
    `SELECT encryption_public_key, device_signing_public_key
     FROM continuity_recipient_keys
     WHERE principal_id = ? AND device_id = ? AND browser_session_id = ?
       AND site = ?`,
  )
    .bind(
      principal.data,
      request.data.destinationDeviceId,
      request.data.destinationBrowserSessionId,
      request.data.site,
    )
    .first<{
      encryption_public_key: string;
      device_signing_public_key: string;
    }>();
  if (!enrolledRecipientKey) {
    return {
      ok: false as const,
      code: "CONTINUITY_RECIPIENT_KEY_NOT_ENROLLED",
    };
  }
  if (
    enrolledRecipientKey.device_signing_public_key !==
    JSON.stringify(destinationKey)
  ) {
    return { ok: false as const, code: "CONTINUITY_RECIPIENT_KEY_STALE" };
  }
  const keyStrings = {
    encryption: enrolledRecipientKey.encryption_public_key,
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

export async function getContinuitySetup(
  environment: Environment,
  principalIdCandidate: unknown,
  now: string,
) {
  const principalId = principalIdSchema.safeParse(principalIdCandidate);
  if (!principalId.success) {
    return { ok: false as const, code: "INVALID_PRINCIPAL" };
  }
  const [sessions, grants] = await Promise.all([
    environment.VILLAGE_DB.prepare(
      `SELECT s.device_id AS deviceId,
              s.browser_session_id AS browserSessionId,
              COALESCE(
                (SELECT p.device_display_name FROM pairing_challenges p
                 WHERE p.principal_id = s.principal_id
                   AND p.device_id = s.device_id AND p.state = 'CONSUMED'
                 ORDER BY p.consumed_at DESC LIMIT 1),
                'Paired Mac'
              ) AS deviceName,
              s.connection_state AS connection,
              CASE
                WHEN r.encryption_public_key IS NULL THEN 'MISSING'
                WHEN r.device_signing_public_key = d.public_key THEN 'READY'
                ELSE 'STALE'
              END AS recipientKeyState
       FROM browser_sessions s
       JOIN devices d ON d.principal_id = s.principal_id
                     AND d.device_id = s.device_id
       LEFT JOIN continuity_recipient_keys r
         ON r.principal_id = s.principal_id
        AND r.device_id = s.device_id
        AND r.browser_session_id = s.browser_session_id
        AND r.site = s.site
       WHERE s.principal_id = ? AND s.site = 'OWNED_FIXTURE'
         AND s.profile_state = 'PRESENT' AND d.credential_status = 'ACTIVE'
         AND d.protocol_version = 1
       ORDER BY deviceName, browserSessionId
       LIMIT 50`,
    )
      .bind(principalId.data)
      .all(),
    environment.VILLAGE_DB.prepare(
      `SELECT grant_id AS grantId, source_device_id AS sourceDeviceId,
              destination_device_id AS destinationDeviceId,
              source_browser_session_id AS sourceBrowserSessionId,
              destination_browser_session_id AS destinationBrowserSessionId,
              site,
              CASE
                WHEN state IN ('PENDING', 'ACTIVE') AND expires_at <= ?
                  THEN 'EXPIRED'
                ELSE state
              END AS state,
              created_at AS createdAt, expires_at AS expiresAt
       FROM continuity_grants
       WHERE principal_id = ?
         AND state IN ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED')
       ORDER BY created_at DESC, grant_id
       LIMIT 100`,
    )
      .bind(now, principalId.data)
      .all(),
  ]);
  return {
    ok: true as const,
    sessions: sessions.results,
    grants: grants.results,
  };
}

export async function enrollContinuityRecipientKey(
  environment: Environment,
  candidate: unknown,
  now: string,
) {
  const enrollment =
    continuityRecipientKeyEnrollmentSchema.safeParse(candidate);
  if (!enrollment.success) {
    return { ok: false as const, code: "INVALID_CONTINUITY_RECIPIENT_KEY" };
  }
  if (
    Date.parse(enrollment.data.issuedAt) > Date.parse(now) + 5_000 ||
    Date.parse(enrollment.data.expiresAt) <= Date.parse(now)
  ) {
    return { ok: false as const, code: "CONTINUITY_RECIPIENT_KEY_EXPIRED" };
  }
  const session = await eligibleSession(
    environment.VILLAGE_DB,
    enrollment.data.principalId,
    enrollment.data.browserSessionId,
  );
  if (
    !session ||
    session.device_id !== enrollment.data.deviceId ||
    session.site !== enrollment.data.site ||
    session.profile_state !== "PRESENT" ||
    session.credential_status !== "ACTIVE"
  ) {
    return { ok: false as const, code: "CONTINUITY_RECIPIENT_NOT_ELIGIBLE" };
  }
  if (session.protocol_version !== 1) {
    return { ok: false as const, code: "PROTOCOL_DOWNGRADE_REJECTED" };
  }
  const signingKey = parseSigningKey(session.public_key);
  if (
    !signingKey ||
    !(await verifyContinuityRecipientKeyEnrollment(enrollment.data, signingKey))
  ) {
    return { ok: false as const, code: "INVALID_DEVICE_SIGNATURE" };
  }
  const encodedKey = JSON.stringify(enrollment.data.encryptionPublicKey);
  const inserted = await environment.VILLAGE_DB.prepare(
    `INSERT INTO continuity_recipient_keys
     (principal_id, device_id, browser_session_id, site, encryption_public_key,
      device_signing_public_key, last_accepted_sequence, enrolled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(principal_id, device_id, browser_session_id, site) DO UPDATE SET
       encryption_public_key = excluded.encryption_public_key,
       last_accepted_sequence = excluded.last_accepted_sequence,
       enrolled_at = excluded.enrolled_at
     WHERE excluded.last_accepted_sequence > continuity_recipient_keys.last_accepted_sequence
       AND excluded.encryption_public_key = continuity_recipient_keys.encryption_public_key`,
  )
    .bind(
      enrollment.data.principalId,
      enrollment.data.deviceId,
      enrollment.data.browserSessionId,
      enrollment.data.site,
      encodedKey,
      JSON.stringify(signingKey),
      enrollment.data.sequence,
      now,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    const current = await environment.VILLAGE_DB.prepare(
      `SELECT encryption_public_key, last_accepted_sequence
       FROM continuity_recipient_keys
       WHERE principal_id = ? AND device_id = ? AND browser_session_id = ?
         AND site = ?`,
    )
      .bind(
        enrollment.data.principalId,
        enrollment.data.deviceId,
        enrollment.data.browserSessionId,
        enrollment.data.site,
      )
      .first<{
        encryption_public_key: string;
        last_accepted_sequence: number;
      }>();
    if (
      current?.last_accepted_sequence === enrollment.data.sequence &&
      current.encryption_public_key === encodedKey
    ) {
      return {
        ok: true as const,
        enrolled: false,
        deviceId: enrollment.data.deviceId,
        browserSessionId: enrollment.data.browserSessionId,
      };
    }
    return { ok: false as const, code: "CONTINUITY_RECIPIENT_KEY_CONFLICT" };
  }
  return {
    ok: true as const,
    enrolled: true,
    deviceId: enrollment.data.deviceId,
    browserSessionId: enrollment.data.browserSessionId,
  };
}

export async function revokeContinuityRecipientKey(
  environment: Environment,
  principalIdCandidate: unknown,
  candidate: unknown,
) {
  const principalId = principalIdSchema.safeParse(principalIdCandidate);
  const target = continuityRecipientKeyRevocationSchema.safeParse(candidate);
  if (!principalId.success || !target.success) {
    return {
      ok: false as const,
      code: "INVALID_CONTINUITY_RECIPIENT_KEY_REVOCATION",
    };
  }
  const activeGrant = await environment.VILLAGE_DB.prepare(
    `SELECT 1 AS present FROM continuity_grants
     WHERE principal_id = ? AND destination_device_id = ?
       AND destination_browser_session_id = ? AND site = ?
       AND state IN ('PENDING', 'ACTIVE') LIMIT 1`,
  )
    .bind(
      principalId.data,
      target.data.deviceId,
      target.data.browserSessionId,
      target.data.site,
    )
    .first<{ present: number }>();
  if (activeGrant) {
    return { ok: false as const, code: "ACTIVE_CONTINUITY_GRANT_EXISTS" };
  }
  const deleted = await environment.VILLAGE_DB.prepare(
    `DELETE FROM continuity_recipient_keys
     WHERE principal_id = ? AND device_id = ? AND browser_session_id = ?
       AND site = ?`,
  )
    .bind(
      principalId.data,
      target.data.deviceId,
      target.data.browserSessionId,
      target.data.site,
    )
    .run();
  return { ok: true as const, revoked: deleted.meta.changes === 1 };
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
      `SELECT s.device_id, s.site, s.profile_state, d.public_key,
              d.credential_status, d.protocol_version
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

function parseRequiredSigningKey(value: string) {
  return deviceCredentialSchema.shape.publicKey.parse(JSON.parse(value));
}

function parseRequiredEncryptionKey(value: string) {
  return x25519PublicKeySchema.parse(JSON.parse(value));
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
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
