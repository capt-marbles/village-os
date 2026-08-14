import {
  automationSyncRequestSchema,
  canonicalAutomationSyncRequestBytes,
  canonicalCommandEnvelopeBytes,
  canonicalResultEnvelopeBytes,
  canonicalWorkflowOperationRequestBytes,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  unsignedWorkflowOperationRequestSchema,
  workflowOperationRequestSchema,
  type BrowserCommand,
  type AutomationSyncRequest,
  type UnsignedAutomationSyncRequest,
  type SignedCommandEnvelope,
  type SignedResultEnvelope,
  type UnsignedCommandEnvelope,
  type UnsignedResultEnvelope,
  type WorkflowOperationRequest,
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

export async function signAutomationSyncRequest(
  request: UnsignedAutomationSyncRequest,
  privateKey: CryptoKey,
): Promise<AutomationSyncRequest> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    canonicalAutomationSyncRequestBytes(request),
  );
  return automationSyncRequestSchema.parse({
    ...request,
    signature: encodeBase64Url(new Uint8Array(signature)),
  });
}

export async function signWorkflowOperationRequest(
  candidate: unknown,
  privateKey: CryptoKey,
): Promise<WorkflowOperationRequest> {
  const unsigned = unsignedWorkflowOperationRequestSchema.parse(candidate);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    canonicalWorkflowOperationRequestBytes(unsigned),
  );
  return workflowOperationRequestSchema.parse({
    ...unsigned,
    signature: encodeBase64Url(new Uint8Array(signature)),
  });
}
