import { describe, expect, it } from "vitest";
import { canonicalCommandEnvelopeBytes } from "@village/contracts";
import {
  exportPublicDeviceJwk,
  generateDeviceSigningKey,
  signCommandEnvelope,
} from "../src/main/device-identity.js";

describe("desktop device identity", () => {
  it("keeps the private key non-exportable and emits a verifiable command", async () => {
    const keys = await generateDeviceSigningKey();
    expect(keys.privateKey.extractable).toBe(false);
    const publicJwk = await exportPublicDeviceJwk(keys.publicKey);
    const unsigned = {
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      sequence: 1,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:30.000Z",
      command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
    } as const;
    const signed = await signCommandEnvelope(
      { ...unsigned, command: { ...unsigned.command, facts: ["AUTH_STATE"] } },
      keys.privateKey,
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Buffer.from(signed.signature, "base64url"),
        canonicalCommandEnvelopeBytes(unsigned),
      ),
    ).toBe(true);
  });

  it("signs through a hardware-backed ES256 signer without exposing a private key", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const unsigned = {
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      sequence: 1,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:30.000Z",
      command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
    } as const;
    const signer = {
      sign: (payload: ArrayBuffer) =>
        crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          payload,
        ),
    };

    const signed = await signCommandEnvelope(unsigned, signer);
    expect(signer).not.toHaveProperty("privateKey");
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        Buffer.from(signed.signature, "base64url"),
        canonicalCommandEnvelopeBytes(unsigned),
      ),
    ).toBe(true);
    expect(publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });
});
