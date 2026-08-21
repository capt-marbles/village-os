import { DurableObject } from "cloudflare:workers";
import {
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRevisionAssociatedData,
  canonicalContinuityRevisionBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityBindingSchema,
  continuityFetchEnvelopeSchema,
  continuityRevisionDigestBytes,
  deviceIdSchema,
  deviceSigningPublicKeySchema,
  encryptedContinuityRevisionSchema,
  instantSchema,
  principalIdSchema,
  type ContinuityBinding,
  type EncryptedContinuityRevision,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../../env.js";
import { verifyDeviceSignature } from "../browser-control/device-credentials.js";

const initializeSchema = z
  .strictObject({
    binding: continuityBindingSchema,
    sourceSigningPublicKey: deviceSigningPublicKeySchema,
    destinationSigningPublicKey: deviceSigningPublicKeySchema,
    createdAt: instantSchema,
    expiresAt: instantSchema,
  })
  .superRefine((grant, context) => {
    const lifetime = Date.parse(grant.expiresAt) - Date.parse(grant.createdAt);
    if (lifetime <= 0 || lifetime > 30 * 24 * 60 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Mailbox grant lifetime must be between 1ms and 30d",
      });
    }
    if (grant.binding.sourceDeviceId === grant.binding.destinationDeviceId) {
      context.addIssue({
        code: "custom",
        path: ["binding", "destinationDeviceId"],
        message: "Source and destination devices must differ",
      });
    }
  });

const revokeSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  revokedAt: instantSchema,
});

type MetadataRow = {
  binding_json: string;
  source_public_key_json: string;
  destination_public_key_json: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  current_revision: number;
  current_digest: string | null;
  acknowledged_revision: number;
  destination_sequence: number;
  destination_request_digest: string | null;
  expires_at: string;
};

type RevisionRow = {
  revision: number;
  digest: string;
  envelope_json: string;
  ciphertext_bytes: number;
  expires_at: string;
};

export class SiteSessionMailbox extends DurableObject<Environment> {
  private destroyed = false;

  constructor(ctx: DurableObjectState, environment: Environment) {
    super(ctx, environment);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mailbox_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
          source_public_key_json TEXT NOT NULL CHECK (json_valid(source_public_key_json)),
          destination_public_key_json TEXT NOT NULL CHECK (json_valid(destination_public_key_json)),
          status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
          current_revision INTEGER NOT NULL DEFAULT 0,
          current_digest TEXT,
          acknowledged_revision INTEGER NOT NULL DEFAULT 0,
          destination_sequence INTEGER NOT NULL DEFAULT 0,
          destination_request_digest TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS encrypted_revisions (
          revision INTEGER PRIMARY KEY,
          digest TEXT NOT NULL UNIQUE,
          previous_digest TEXT,
          envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
          ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes > 0),
          expires_at TEXT NOT NULL,
          acknowledged_at TEXT
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, datetime('now'));
      `);
    });
  }

  async initialize(candidate: unknown) {
    if (this.destroyed) {
      return { ok: false as const, code: "MAILBOX_DELETED" };
    }
    const parsed = initializeSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false as const, code: "INVALID_MAILBOX_INITIALIZATION" };
    }
    const existing = this.metadata();
    if (existing) {
      if (!metadataMatchesInitialization(existing, parsed.data)) {
        return { ok: false as const, code: "MAILBOX_ALREADY_INITIALIZED" };
      }
      await this.scheduleNextAlarm();
      return { ok: true as const, initialized: false as const };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO mailbox_metadata
       (singleton, binding_json, source_public_key_json,
        destination_public_key_json, status, current_revision,
        current_digest, acknowledged_revision, destination_sequence,
        destination_request_digest, created_at, expires_at)
       VALUES (1, ?, ?, ?, 'ACTIVE', 0, NULL, 0, 0, NULL, ?, ?)`,
      JSON.stringify(parsed.data.binding),
      JSON.stringify(parsed.data.sourceSigningPublicKey),
      JSON.stringify(parsed.data.destinationSigningPublicKey),
      parsed.data.createdAt,
      parsed.data.expiresAt,
    );
    await this.scheduleNextAlarm();
    return { ok: true as const, initialized: true as const };
  }

  async publish(candidate: unknown, now: unknown) {
    const revision = encryptedContinuityRevisionSchema.safeParse(candidate);
    const parsedNow = instantSchema.safeParse(now);
    if (!revision.success || !parsedNow.success) {
      return { ok: false as const, code: "INVALID_CONTINUITY_REVISION" };
    }
    const metadata = this.activeMetadata(parsedNow.data);
    if (!metadata.ok) return metadata;
    if (!sameBinding(revision.data, metadata.binding)) {
      return { ok: false as const, code: "MAILBOX_BINDING_MISMATCH" };
    }
    if (
      Date.parse(revision.data.issuedAt) > Date.parse(parsedNow.data) + 5_000 ||
      revision.data.expiresAt <= parsedNow.data
    ) {
      return { ok: false as const, code: "CONTINUITY_REVISION_EXPIRED" };
    }
    if (!(await this.verifyRevision(revision.data, metadata.row))) {
      return {
        ok: false as const,
        code: "CONTINUITY_REVISION_UNAUTHENTICATED",
      };
    }
    if (!(await revisionDigestMatches(revision.data))) {
      return {
        ok: false as const,
        code: "CONTINUITY_REVISION_DIGEST_MISMATCH",
      };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const current = this.metadata();
      if (!current || current.status !== "ACTIVE") {
        return { ok: false as const, code: "MAILBOX_NOT_ACTIVE" };
      }
      if (
        revision.data.revision === current.current_revision &&
        revision.data.digest === current.current_digest
      ) {
        return { ok: true as const, stored: false as const };
      }
      if (
        revision.data.revision !== current.current_revision + 1 ||
        revision.data.previousDigest !== current.current_digest
      ) {
        return {
          ok: false as const,
          code: "CONTINUITY_REVISION_CHAIN_INVALID",
        };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO encrypted_revisions
         (revision, digest, previous_digest, envelope_json, ciphertext_bytes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        revision.data.revision,
        revision.data.digest,
        revision.data.previousDigest,
        JSON.stringify(revision.data),
        decodeBase64Url(revision.data.ciphertext).byteLength,
        revision.data.expiresAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE mailbox_metadata
         SET current_revision = ?, current_digest = ? WHERE singleton = 1`,
        revision.data.revision,
        revision.data.digest,
      );
      return { ok: true as const, stored: true as const };
    });
    if (result.ok) await this.scheduleNextAlarm();
    return result;
  }

  async fetchAfter(candidate: unknown, now: unknown) {
    const request = continuityFetchEnvelopeSchema.safeParse(candidate);
    const parsedNow = instantSchema.safeParse(now);
    if (!request.success || !parsedNow.success) {
      return { ok: false as const, code: "INVALID_CONTINUITY_FETCH" };
    }
    const metadata = this.activeMetadata(parsedNow.data);
    if (!metadata.ok) return metadata;
    if (!sameBinding(request.data, metadata.binding)) {
      return { ok: false as const, code: "MAILBOX_BINDING_MISMATCH" };
    }
    if (!requestIsCurrent(request.data, parsedNow.data)) {
      return { ok: false as const, code: "CONTINUITY_REQUEST_EXPIRED" };
    }
    if (
      !(await verifySignedRequest(
        request.data,
        metadata.row.destination_public_key_json,
        canonicalContinuityFetchBytes,
      ))
    ) {
      return { ok: false as const, code: "CONTINUITY_REQUEST_UNAUTHENTICATED" };
    }
    const requestDigest = await sha256Hex(
      canonicalContinuityFetchBytes(withoutSignature(request.data)),
    );
    const accepted = this.acceptDestinationSequence(
      request.data.sequence,
      requestDigest,
    );
    if (!accepted.ok) return accepted;
    const row = this.ctx.storage.sql
      .exec<RevisionRow>(
        `SELECT revision, digest, envelope_json, ciphertext_bytes, expires_at
         FROM encrypted_revisions
         WHERE revision > ? AND expires_at > ?
         ORDER BY revision ASC LIMIT 1`,
        request.data.afterRevision,
        parsedNow.data,
      )
      .toArray()[0];
    return {
      ok: true as const,
      revision: row
        ? encryptedContinuityRevisionSchema.parse(JSON.parse(row.envelope_json))
        : null,
    };
  }

  async acknowledge(candidate: unknown, now: unknown) {
    const request =
      continuityAcknowledgementEnvelopeSchema.safeParse(candidate);
    const parsedNow = instantSchema.safeParse(now);
    if (!request.success || !parsedNow.success) {
      return { ok: false as const, code: "INVALID_CONTINUITY_ACKNOWLEDGEMENT" };
    }
    const metadata = this.activeMetadata(parsedNow.data);
    if (!metadata.ok) return metadata;
    if (!sameBinding(request.data, metadata.binding)) {
      return { ok: false as const, code: "MAILBOX_BINDING_MISMATCH" };
    }
    if (!requestIsCurrent(request.data, parsedNow.data)) {
      return { ok: false as const, code: "CONTINUITY_REQUEST_EXPIRED" };
    }
    if (
      !(await verifySignedRequest(
        request.data,
        metadata.row.destination_public_key_json,
        canonicalContinuityAcknowledgementBytes,
      ))
    ) {
      return { ok: false as const, code: "CONTINUITY_REQUEST_UNAUTHENTICATED" };
    }
    const requestDigest = await sha256Hex(
      canonicalContinuityAcknowledgementBytes(withoutSignature(request.data)),
    );
    const result = this.ctx.storage.transactionSync(() => {
      const current = this.metadata();
      if (!current || current.status !== "ACTIVE") {
        return { ok: false as const, code: "MAILBOX_NOT_ACTIVE" };
      }
      const revision = this.ctx.storage.sql
        .exec<{ digest: string }>(
          "SELECT digest FROM encrypted_revisions WHERE revision = ?",
          request.data.revision,
        )
        .toArray()[0];
      if (!revision || revision.digest !== request.data.digest) {
        return {
          ok: false as const,
          code: "CONTINUITY_ACKNOWLEDGEMENT_INVALID",
        };
      }
      const sequence = this.acceptDestinationSequenceInTransaction(
        current,
        request.data.sequence,
        requestDigest,
      );
      if (!sequence.ok) return sequence;
      if (request.data.revision <= current.acknowledged_revision) {
        return { ok: true as const, acknowledged: false as const };
      }
      if (request.data.revision !== current.acknowledged_revision + 1) {
        return {
          ok: false as const,
          code: "CONTINUITY_ACKNOWLEDGEMENT_OUT_OF_ORDER",
        };
      }
      this.ctx.storage.sql.exec(
        "UPDATE encrypted_revisions SET acknowledged_at = ? WHERE revision = ?",
        parsedNow.data,
        request.data.revision,
      );
      this.ctx.storage.sql.exec(
        "UPDATE mailbox_metadata SET acknowledged_revision = ? WHERE singleton = 1",
        request.data.revision,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM encrypted_revisions WHERE revision < ?",
        request.data.revision,
      );
      return { ok: true as const, acknowledged: true as const };
    });
    if (result.ok) await this.scheduleNextAlarm();
    return result;
  }

  async revoke(candidate: unknown) {
    const parsed = revokeSchema.safeParse(candidate);
    const metadata = this.metadata();
    if (!parsed.success || !metadata) {
      return { ok: false as const, code: "INVALID_MAILBOX_REVOCATION" };
    }
    const binding = continuityBindingSchema.parse(
      JSON.parse(metadata.binding_json),
    );
    if (
      binding.principalId !== parsed.data.principalId ||
      (binding.sourceDeviceId !== parsed.data.deviceId &&
        binding.destinationDeviceId !== parsed.data.deviceId)
    ) {
      return { ok: false as const, code: "MAILBOX_BINDING_MISMATCH" };
    }
    if (metadata.status !== "ACTIVE") {
      return { ok: true as const, revoked: false as const };
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE mailbox_metadata SET status = 'REVOKED' WHERE singleton = 1",
      );
      this.ctx.storage.sql.exec("DELETE FROM encrypted_revisions");
    });
    await this.ctx.storage.deleteAlarm();
    return { ok: true as const, revoked: true as const };
  }

  async destroy(principalId: unknown) {
    const principal = principalIdSchema.safeParse(principalId);
    const metadata = this.metadata();
    if (!principal.success || !metadata) {
      return { ok: false as const, code: "MAILBOX_NOT_FOUND" };
    }
    const binding = continuityBindingSchema.parse(
      JSON.parse(metadata.binding_json),
    );
    if (binding.principalId !== principal.data) {
      return { ok: false as const, code: "MAILBOX_NOT_FOUND" };
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.destroyed = true;
    return { ok: true as const, deleted: true as const };
  }

  diagnostics(principalId: unknown) {
    const principal = principalIdSchema.safeParse(principalId);
    const metadata = this.metadata();
    if (!principal.success || !metadata) {
      return { ok: false as const, code: "MAILBOX_NOT_FOUND" };
    }
    const binding = continuityBindingSchema.parse(
      JSON.parse(metadata.binding_json),
    );
    if (binding.principalId !== principal.data) {
      return { ok: false as const, code: "MAILBOX_NOT_FOUND" };
    }
    const retained = this.ctx.storage.sql
      .exec<{
        retainedRevisionCount: number;
        retainedCiphertextBytes: number;
        nextExpiryAt: string | null;
      }>(
        `SELECT COUNT(*) AS retainedRevisionCount,
                COALESCE(SUM(ciphertext_bytes), 0) AS retainedCiphertextBytes,
                MIN(expires_at) AS nextExpiryAt
         FROM encrypted_revisions`,
      )
      .one();
    return {
      ok: true as const,
      status: metadata.status,
      currentRevision: metadata.current_revision,
      acknowledgedRevision: metadata.acknowledged_revision,
      ...retained,
    };
  }

  override async alarm(): Promise<void> {
    if (this.destroyed) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "DELETE FROM encrypted_revisions WHERE expires_at <= ?",
      now,
    );
    const metadata = this.metadata();
    if (metadata && metadata.expires_at <= now) {
      this.ctx.storage.sql.exec(
        "UPDATE mailbox_metadata SET status = 'EXPIRED' WHERE singleton = 1",
      );
      this.ctx.storage.sql.exec("DELETE FROM encrypted_revisions");
    }
    await this.scheduleNextAlarm();
  }

  private metadata(): MetadataRow | undefined {
    if (this.destroyed) return undefined;
    return this.ctx.storage.sql
      .exec<MetadataRow>("SELECT * FROM mailbox_metadata WHERE singleton = 1")
      .toArray()[0];
  }

  private activeMetadata(
    now: string,
  ):
    | { ok: true; row: MetadataRow; binding: ContinuityBinding }
    | { ok: false; code: string } {
    const row = this.metadata();
    if (!row) return { ok: false, code: "MAILBOX_NOT_FOUND" };
    if (row.status !== "ACTIVE" || row.expires_at <= now) {
      return { ok: false, code: "MAILBOX_NOT_ACTIVE" };
    }
    return {
      ok: true,
      row,
      binding: continuityBindingSchema.parse(JSON.parse(row.binding_json)),
    };
  }

  private async verifyRevision(
    revision: EncryptedContinuityRevision,
    metadata: MetadataRow,
  ): Promise<boolean> {
    try {
      const { signature, ...unsigned } = revision;
      return verifyDeviceSignature(
        JSON.parse(metadata.source_public_key_json),
        signature,
        canonicalContinuityRevisionBytes(unsigned),
      );
    } catch {
      return false;
    }
  }

  private acceptDestinationSequence(sequence: number, digest: string) {
    return this.ctx.storage.transactionSync(() => {
      const metadata = this.metadata();
      if (!metadata || metadata.status !== "ACTIVE") {
        return { ok: false as const, code: "MAILBOX_NOT_ACTIVE" };
      }
      return this.acceptDestinationSequenceInTransaction(
        metadata,
        sequence,
        digest,
      );
    });
  }

  private acceptDestinationSequenceInTransaction(
    metadata: MetadataRow,
    sequence: number,
    digest: string,
  ) {
    if (
      sequence === metadata.destination_sequence &&
      digest === metadata.destination_request_digest
    ) {
      return { ok: true as const, replayed: true as const };
    }
    if (sequence !== metadata.destination_sequence + 1) {
      return { ok: false as const, code: "CONTINUITY_REQUEST_REPLAYED" };
    }
    this.ctx.storage.sql.exec(
      `UPDATE mailbox_metadata
       SET destination_sequence = ?, destination_request_digest = ?
       WHERE singleton = 1`,
      sequence,
      digest,
    );
    return { ok: true as const, replayed: false as const };
  }

  private async scheduleNextAlarm(): Promise<void> {
    const metadata = this.metadata();
    if (!metadata || metadata.status !== "ACTIVE") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const row = this.ctx.storage.sql
      .exec<{ expiresAt: string | null }>(
        "SELECT MIN(expires_at) AS expiresAt FROM encrypted_revisions",
      )
      .one();
    const next = Math.min(
      Date.parse(metadata.expires_at),
      row.expiresAt ? Date.parse(row.expiresAt) : Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}

function metadataMatchesInitialization(
  metadata: MetadataRow,
  initialization: z.infer<typeof initializeSchema>,
): boolean {
  return (
    metadata.binding_json === JSON.stringify(initialization.binding) &&
    metadata.source_public_key_json ===
      JSON.stringify(initialization.sourceSigningPublicKey) &&
    metadata.destination_public_key_json ===
      JSON.stringify(initialization.destinationSigningPublicKey) &&
    metadata.expires_at === initialization.expiresAt
  );
}

function sameBinding(left: ContinuityBinding, right: ContinuityBinding) {
  return (
    left.principalId === right.principalId &&
    left.grantId === right.grantId &&
    left.sourceDeviceId === right.sourceDeviceId &&
    left.destinationDeviceId === right.destinationDeviceId &&
    left.sourceBrowserSessionId === right.sourceBrowserSessionId &&
    left.destinationBrowserSessionId === right.destinationBrowserSessionId &&
    left.site === right.site
  );
}

function requestIsCurrent(
  request: { issuedAt: string; expiresAt: string },
  now: string,
): boolean {
  const current = Date.parse(now);
  return (
    Date.parse(request.issuedAt) <= current + 5_000 &&
    Date.parse(request.expiresAt) > current
  );
}

function withoutSignature<T extends { signature: string }>(
  request: T,
): Omit<T, "signature"> {
  const { signature: _, ...unsigned } = request;
  return unsigned;
}

async function verifySignedRequest<T extends { signature: string }>(
  request: T,
  publicKeyJson: string,
  canonicalize: (request: Omit<T, "signature">) => ArrayBuffer,
): Promise<boolean> {
  try {
    return verifyDeviceSignature(
      JSON.parse(publicKeyJson),
      request.signature,
      canonicalize(withoutSignature(request)),
    );
  } catch {
    return false;
  }
}

async function revisionDigestMatches(
  revision: EncryptedContinuityRevision,
): Promise<boolean> {
  const { signature: _, ciphertext, digest, ...associated } = revision;
  const calculated = await sha256Hex(
    continuityRevisionDigestBytes(
      canonicalContinuityRevisionAssociatedData(associated),
      decodeBase64Url(ciphertext),
    ),
  );
  return calculated === digest;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
