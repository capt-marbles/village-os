import {
  canonicalCommandEnvelopeBytes,
  canonicalResultEnvelopeBytes,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  type BrowserCommand,
  type SignedCommandEnvelope,
  type SignedResultEnvelope,
  type UnsignedCommandEnvelope,
  type UnsignedResultEnvelope,
} from "@village/contracts";

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function generateDeviceSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
}

export async function exportPublicDeviceJwk(
  publicKey: CryptoKey,
): Promise<JsonWebKey> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("INVALID_DEVICE_PUBLIC_KEY");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

export async function signCommandEnvelope(
  envelope: Omit<UnsignedCommandEnvelope, "command"> & {
    command: BrowserCommand;
  },
  privateKey: CryptoKey,
): Promise<SignedCommandEnvelope> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    canonicalCommandEnvelopeBytes(envelope),
  );
  return signedCommandEnvelopeSchema.parse({
    ...envelope,
    signature: encodeBase64Url(new Uint8Array(signature)),
  });
}

export async function signResultEnvelope(
  envelope: UnsignedResultEnvelope,
  privateKey: CryptoKey,
): Promise<SignedResultEnvelope> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    canonicalResultEnvelopeBytes(envelope),
  );
  return signedResultEnvelopeSchema.parse({
    ...envelope,
    signature: encodeBase64Url(new Uint8Array(signature)),
  });
}
