import { describe, expect, it } from "vitest";
import type { SignedCommandEnvelope } from "@village/contracts";
import {
  canonicalCommandEnvelopeBytes,
  signedCommandEnvelopeSchema,
} from "@village/contracts";
import { verifyCommandEnvelope } from "../device-credentials.js";

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
} satisfies Omit<SignedCommandEnvelope, "signature">;

describe("device command credentials", () => {
  it("signs the complete canonical binding and rejects tampering", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      canonicalCommandEnvelopeBytes(unsigned),
    );
    const signed = signedCommandEnvelopeSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });

    expect(await verifyCommandEnvelope(signed, publicKey)).toBe(true);
    expect(
      await verifyCommandEnvelope(
        { ...signed, leaseEpoch: 2 } as SignedCommandEnvelope,
        publicKey,
      ),
    ).toBe(false);
    expect(
      await verifyCommandEnvelope(
        { ...signed, signature: "c2lnbmF0dXJl" },
        publicKey,
      ),
    ).toBe(false);
  });

  it("verifies an ES256 command from a P-256 device public key", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      canonicalCommandEnvelopeBytes(unsigned),
    );
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const signed = signedCommandEnvelopeSchema.parse({
      ...unsigned,
      signature: Buffer.from(signature).toString("base64url"),
    });

    expect(
      await verifyCommandEnvelope(signed, {
        kty: "EC",
        crv: "P-256",
        x: publicKey.x!,
        y: publicKey.y!,
      }),
    ).toBe(true);
  });
});
