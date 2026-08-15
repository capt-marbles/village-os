import { describe, expect, it } from "vitest";
import {
  LocalContinuityRelay,
  createEncryptedFixtureRevision,
  generateContinuityEncryptionKeyPair,
  openEncryptedFixtureRevision,
} from "../src/main/site-session-continuity.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  grantId: "cgr_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  sourceBrowserSessionId: "brs_01J00000000000000000000001",
  destinationBrowserSessionId: "brs_01J00000000000000000000002",
  site: "OWNED_FIXTURE" as const,
};

const cookies = [
  {
    name: "fixture_session",
    value: "owner-only-session-value",
    domain: "fixture.village.test" as const,
    path: "/",
    secure: true as const,
    httpOnly: true,
    sameSite: "lax" as const,
    expirationDate: 1_800_000_000,
    hostOnly: true,
  },
];

describe("encrypted Site Session continuity revision", () => {
  it("crosses an opaque relay and opens only on the bound destination", async () => {
    const sourceSigningKeys = await crypto.subtle.generateKey(
      "Ed25519",
      false,
      ["sign", "verify"],
    );
    const destinationEncryptionKeys =
      await generateContinuityEncryptionKeyPair();
    const revision = await createEncryptedFixtureRevision({
      binding,
      revision: 1,
      previousDigest: null,
      cookies,
      issuedAt: "2026-08-15T19:00:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
      sourceSigningKey: sourceSigningKeys.privateKey,
      destinationEncryptionKey: destinationEncryptionKeys.publicKey,
    });
    const relay = new LocalContinuityRelay();

    expect(await relay.publish(revision)).toEqual({ stored: true });
    expect(JSON.stringify(relay.exportState())).not.toContain(
      "owner-only-session-value",
    );
    const delivered = await relay.fetchAfter(binding, 0);
    expect(delivered).not.toBeNull();

    await expect(
      openEncryptedFixtureRevision(delivered, {
        binding,
        now: Date.parse("2026-08-15T19:01:00.000Z"),
        sourceSigningKey: sourceSigningKeys.publicKey,
        destinationEncryptionKey: destinationEncryptionKeys.privateKey,
      }),
    ).resolves.toEqual({ schemaVersion: 1, cookies });

    const wrongDestination = await generateContinuityEncryptionKeyPair();
    await expect(
      openEncryptedFixtureRevision(delivered, {
        binding,
        now: Date.parse("2026-08-15T19:01:00.000Z"),
        sourceSigningKey: sourceSigningKeys.publicKey,
        destinationEncryptionKey: wrongDestination.privateKey,
      }),
    ).rejects.toThrow("CONTINUITY_REVISION_DECRYPTION_FAILED");
  });

  it("rejects ciphertext corruption and stale or broken relay chains", async () => {
    const sourceSigningKeys = await crypto.subtle.generateKey(
      "Ed25519",
      false,
      ["sign", "verify"],
    );
    const destinationEncryptionKeys =
      await generateContinuityEncryptionKeyPair();
    const revision = await createEncryptedFixtureRevision({
      binding,
      revision: 1,
      previousDigest: null,
      cookies,
      issuedAt: "2026-08-15T19:00:00.000Z",
      expiresAt: "2026-08-16T19:00:00.000Z",
      sourceSigningKey: sourceSigningKeys.privateKey,
      destinationEncryptionKey: destinationEncryptionKeys.publicKey,
    });
    const corrupted = {
      ...revision,
      ciphertext: `${revision.ciphertext.slice(0, -1)}${
        revision.ciphertext.endsWith("A") ? "B" : "A"
      }`,
    };

    await expect(
      openEncryptedFixtureRevision(corrupted, {
        binding,
        now: Date.parse("2026-08-15T19:01:00.000Z"),
        sourceSigningKey: sourceSigningKeys.publicKey,
        destinationEncryptionKey: destinationEncryptionKeys.privateKey,
      }),
    ).rejects.toThrow("CONTINUITY_REVISION_UNAUTHENTICATED");

    const relay = new LocalContinuityRelay();
    await expect(relay.publish(revision)).resolves.toEqual({ stored: true });
    await expect(relay.publish(revision)).resolves.toEqual({ stored: false });
    await expect(
      relay.publish({
        ...revision,
        revision: 3,
        previousDigest: revision.digest,
      }),
    ).rejects.toThrow("CONTINUITY_REVISION_CHAIN_INVALID");
  });
});
