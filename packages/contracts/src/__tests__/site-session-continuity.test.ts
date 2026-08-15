import { describe, expect, it } from "vitest";
import {
  canonicalContinuityAcknowledgementBytes,
  canonicalContinuityFetchBytes,
  canonicalContinuityRevisionBytes,
  continuityAcknowledgementEnvelopeSchema,
  continuityFetchEnvelopeSchema,
  continuityGrantRequestSchema,
  encryptedContinuityRevisionSchema,
} from "../index.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  grantId: "cgr_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  sourceBrowserSessionId: "brs_01J00000000000000000000001",
  destinationBrowserSessionId: "brs_01J00000000000000000000002",
  site: "OWNED_FIXTURE" as const,
};

const unsignedRevision = {
  protocolVersion: 1 as const,
  ...binding,
  revision: 1,
  previousDigest: null,
  issuedAt: "2026-08-15T19:00:00.000Z",
  expiresAt: "2026-08-16T19:00:00.000Z",
  ephemeralPublicKey: {
    kty: "OKP" as const,
    crv: "X25519" as const,
    x: "a".repeat(43),
  },
  salt: "b".repeat(22),
  iv: "c".repeat(16),
  ciphertext: "opaque-ciphertext",
  digest: "d".repeat(64),
};

describe("Site Session continuity wire contracts", () => {
  it("accepts only bounded opaque revisions and signs every routing field", () => {
    const revision = encryptedContinuityRevisionSchema.parse({
      ...unsignedRevision,
      signature: "e".repeat(86),
    });
    const first = Buffer.from(
      canonicalContinuityRevisionBytes(unsignedRevision),
    );
    const changedDestination = Buffer.from(
      canonicalContinuityRevisionBytes({
        ...unsignedRevision,
        destinationDeviceId: "dev_01J00000000000000000000003",
      }),
    );

    expect(first.equals(changedDestination)).toBe(false);
    expect(
      encryptedContinuityRevisionSchema.safeParse({
        ...revision,
        cookies: [{ name: "fixture_session", value: "plaintext" }],
      }).success,
    ).toBe(false);
    expect(
      encryptedContinuityRevisionSchema.safeParse({
        ...revision,
        ciphertext: "x".repeat(131_073),
      }).success,
    ).toBe(false);
  });

  it("binds destination fetch and acknowledgement requests to short lifetimes", () => {
    const fetch = continuityFetchEnvelopeSchema.parse({
      protocolVersion: 1,
      ...binding,
      sequence: 1,
      afterRevision: 0,
      issuedAt: "2026-08-15T19:00:00.000Z",
      expiresAt: "2026-08-15T19:00:30.000Z",
      signature: "f".repeat(86),
    });
    const acknowledgement = continuityAcknowledgementEnvelopeSchema.parse({
      protocolVersion: 1,
      ...binding,
      sequence: 2,
      revision: 1,
      digest: "d".repeat(64),
      issuedAt: "2026-08-15T19:00:30.000Z",
      expiresAt: "2026-08-15T19:01:00.000Z",
      signature: "g".repeat(86),
    });

    expect(
      Buffer.from(canonicalContinuityFetchBytes(fetch)).length,
    ).toBeGreaterThan(0);
    expect(
      Buffer.from(canonicalContinuityAcknowledgementBytes(acknowledgement))
        .length,
    ).toBeGreaterThan(0);
    expect(
      continuityFetchEnvelopeSchema.safeParse({
        ...fetch,
        expiresAt: "2026-08-15T19:02:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("defines an owner-approved one-way fixture grant without private keys", () => {
    const grant = continuityGrantRequestSchema.parse({
      grantId: binding.grantId,
      sourceDeviceId: binding.sourceDeviceId,
      destinationDeviceId: binding.destinationDeviceId,
      sourceBrowserSessionId: binding.sourceBrowserSessionId,
      destinationBrowserSessionId: binding.destinationBrowserSessionId,
      site: binding.site,
      destinationEncryptionPublicKey: {
        kty: "OKP",
        crv: "X25519",
        x: "h".repeat(43),
      },
      expiresAt: "2026-08-16T19:00:00.000Z",
    });

    expect(grant).not.toHaveProperty("privateKey");
    expect(
      continuityGrantRequestSchema.safeParse({
        ...grant,
        destinationDeviceId: grant.sourceDeviceId,
      }).success,
    ).toBe(false);
    expect(
      continuityGrantRequestSchema.safeParse({
        ...grant,
        site: "LINKEDIN",
      }).success,
    ).toBe(false);
  });
});
