import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRevisionAssociatedData,
  canonicalContinuityRevisionBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityFetchEnvelopeSchema,
  continuityRevisionDigestBytes,
  encryptedContinuityRevisionSchema,
} from "@village/contracts";
import type { SiteSessionMailbox } from "../mailbox.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  grantId: "cgr_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  sourceBrowserSessionId: "brs_01J00000000000000000000001",
  destinationBrowserSessionId: "brs_01J00000000000000000000002",
  site: "OWNED_FIXTURE" as const,
};

let sourceKeys: CryptoKeyPair;
let destinationKeys: CryptoKeyPair;

beforeEach(async () => {
  sourceKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  destinationKeys = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
});

function namespace(): DurableObjectNamespace<SiteSessionMailbox> {
  return (
    env as unknown as {
      SITE_SESSION_MAILBOX: DurableObjectNamespace<SiteSessionMailbox>;
    }
  ).SITE_SESSION_MAILBOX;
}

async function publicJwk(key: CryptoKey) {
  const exported = await crypto.subtle.exportKey("jwk", key);
  return { kty: "OKP" as const, crv: "Ed25519" as const, x: exported.x! };
}

async function signedRevision() {
  const ciphertextBytes = new TextEncoder().encode("opaque-fixture-revision");
  const ciphertext = Buffer.from(ciphertextBytes).toString("base64url");
  const partial = {
    protocolVersion: 1 as const,
    ...binding,
    revision: 1,
    previousDigest: null,
    issuedAt: "2026-08-15T19:00:00.000Z",
    expiresAt: "2026-08-16T18:59:59.000Z",
    ephemeralPublicKey: {
      kty: "OKP" as const,
      crv: "X25519" as const,
      x: "a".repeat(43),
    },
    salt: "b".repeat(22),
    iv: "c".repeat(16),
  };
  const associatedData = canonicalContinuityRevisionAssociatedData(partial);
  const digest = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      continuityRevisionDigestBytes(
        associatedData,
        Uint8Array.from(ciphertextBytes).buffer,
      ),
    ),
  ).toString("hex");
  const unsigned = { ...partial, ciphertext, digest };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    sourceKeys.privateKey,
    canonicalContinuityRevisionBytes(unsigned),
  );
  return encryptedContinuityRevisionSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
}

async function signedFetch() {
  const unsigned = {
    protocolVersion: 1 as const,
    ...binding,
    sequence: 1,
    afterRevision: 0,
    issuedAt: "2026-08-15T19:00:30.000Z",
    expiresAt: "2026-08-15T19:01:00.000Z",
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    destinationKeys.privateKey,
    canonicalContinuityFetchBytes(unsigned),
  );
  return continuityFetchEnvelopeSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
}

async function signedAcknowledgement(digest: string) {
  const unsigned = {
    protocolVersion: 1 as const,
    ...binding,
    sequence: 2,
    revision: 1,
    digest,
    issuedAt: "2026-08-15T19:01:00.000Z",
    expiresAt: "2026-08-15T19:01:30.000Z",
  };
  const signature = await crypto.subtle.sign(
    "Ed25519",
    destinationKeys.privateKey,
    canonicalContinuityAcknowledgementBytes(unsigned),
  );
  return continuityAcknowledgementEnvelopeSchema.parse({
    ...unsigned,
    signature: Buffer.from(signature).toString("base64url"),
  });
}

describe("Site Session ciphertext mailbox", () => {
  it("survives eviction and delivers one ordered opaque revision until ack", async () => {
    const stub = namespace().getByName(
      `${binding.principalId}:${binding.grantId}`,
    );
    await expect(
      stub.initialize({
        binding,
        sourceSigningPublicKey: await publicJwk(sourceKeys.publicKey),
        destinationSigningPublicKey: await publicJwk(destinationKeys.publicKey),
        createdAt: "2026-08-15T18:59:00.000Z",
        expiresAt: "2026-08-16T19:00:00.000Z",
      }),
    ).resolves.toEqual({ ok: true, initialized: true });
    const revision = await signedRevision();
    await expect(
      stub.publish(revision, "2026-08-15T19:00:01.000Z"),
    ).resolves.toEqual({ ok: true, stored: true });

    await evictDurableObject(stub);
    const restarted = namespace().getByName(
      `${binding.principalId}:${binding.grantId}`,
    );
    await expect(
      restarted.fetchAfter(await signedFetch(), "2026-08-15T19:00:31.000Z"),
    ).resolves.toEqual({ ok: true, revision });
    await expect(
      restarted.acknowledge(
        await signedAcknowledgement("0".repeat(64)),
        "2026-08-15T19:01:01.000Z",
      ),
    ).resolves.toEqual({
      ok: false,
      code: "CONTINUITY_ACKNOWLEDGEMENT_INVALID",
    });
    const acknowledgement = await signedAcknowledgement(revision.digest);
    await expect(
      restarted.acknowledge(acknowledgement, "2026-08-15T19:01:01.000Z"),
    ).resolves.toEqual({ ok: true, acknowledged: true });
    await expect(
      restarted.acknowledge(acknowledgement, "2026-08-15T19:01:01.000Z"),
    ).resolves.toEqual({ ok: true, acknowledged: false });

    const diagnostics = await restarted.diagnostics(binding.principalId);
    expect(diagnostics).toEqual({
      ok: true,
      status: "ACTIVE",
      currentRevision: 1,
      acknowledgedRevision: 1,
      retainedRevisionCount: 1,
      retainedCiphertextBytes: Buffer.from(revision.ciphertext, "base64url")
        .byteLength,
      nextExpiryAt: revision.expiresAt,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(
      "opaque-fixture-revision",
    );
  });

  it("revokes either paired device, clears ciphertext, and destroys active storage", async () => {
    const stub = namespace().getByName(
      `${binding.principalId}:${binding.grantId}:revocation`,
    );
    await stub.initialize({
      binding,
      sourceSigningPublicKey: await publicJwk(sourceKeys.publicKey),
      destinationSigningPublicKey: await publicJwk(destinationKeys.publicKey),
      createdAt: "2026-08-15T18:59:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
    });
    const revision = await signedRevision();
    await stub.publish(revision, "2026-08-15T19:00:01.000Z");

    await expect(
      stub.revoke({
        principalId: binding.principalId,
        deviceId: binding.destinationDeviceId,
        revokedAt: "2026-08-15T19:00:20.000Z",
      }),
    ).resolves.toEqual({ ok: true, revoked: true });
    await expect(
      stub.fetchAfter(await signedFetch(), "2026-08-15T19:00:31.000Z"),
    ).resolves.toEqual({ ok: false, code: "MAILBOX_NOT_ACTIVE" });
    await expect(stub.diagnostics(binding.principalId)).resolves.toMatchObject({
      ok: true,
      status: "REVOKED",
      retainedRevisionCount: 0,
      retainedCiphertextBytes: 0,
    });

    await expect(stub.destroy(binding.principalId)).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    await expect(stub.diagnostics(binding.principalId)).resolves.toEqual({
      ok: false,
      code: "MAILBOX_NOT_FOUND",
    });
  });

  it("expires the grant and clears ciphertext through its at-least-once alarm", async () => {
    const stub = namespace().getByName(
      `${binding.principalId}:${binding.grantId}:expiry`,
    );
    await stub.initialize({
      binding,
      sourceSigningPublicKey: await publicJwk(sourceKeys.publicKey),
      destinationSigningPublicKey: await publicJwk(destinationKeys.publicKey),
      createdAt: "2026-08-15T18:59:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE mailbox_metadata SET expires_at = ? WHERE singleton = 1",
        "2026-08-15T00:00:00.000Z",
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(stub.diagnostics(binding.principalId)).resolves.toMatchObject({
      ok: true,
      status: "EXPIRED",
      retainedRevisionCount: 0,
      retainedCiphertextBytes: 0,
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(false);
  });
});
