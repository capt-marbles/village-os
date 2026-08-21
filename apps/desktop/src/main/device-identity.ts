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
  deviceSigningPublicKeySchema,
  type DeviceSigningPublicKey,
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

export interface DeviceSigner {
  sign(payload: ArrayBuffer): Promise<ArrayBuffer>;
}

export type DeviceSigningKey = CryptoKey | DeviceSigner;
export type DeviceVerificationKey = CryptoKey | DeviceSigningPublicKey;

function isDeviceSigner(key: DeviceSigningKey): key is DeviceSigner {
  return "sign" in key && typeof key.sign === "function";
}

export function signDeviceBytes(
  key: DeviceSigningKey,
  payload: ArrayBuffer,
): Promise<ArrayBuffer> {
  if (isDeviceSigner(key)) return key.sign(payload);
  return crypto.subtle.sign("Ed25519", key, payload);
}

export async function verifyDeviceBytes(
  key: DeviceVerificationKey,
  signature: BufferSource,
  payload: ArrayBuffer,
): Promise<boolean> {
  const imported = await importDeviceVerificationKey(key);
  return crypto.subtle.verify(
    imported.algorithm.name === "ECDSA"
      ? { name: "ECDSA", hash: "SHA-256" }
      : "Ed25519",
    imported,
    signature,
    payload,
  );
}

export async function importDeviceVerificationKey(
  key: DeviceVerificationKey,
): Promise<CryptoKey> {
  if ("type" in key && "algorithm" in key) return key;
  const publicKey = deviceSigningPublicKeySchema.parse(key);
  const p256 = publicKey.kty === "EC";
  return crypto.subtle.importKey(
    "jwk",
    publicKey,
    p256 ? { name: "ECDSA", namedCurve: "P-256" } : "Ed25519",
    false,
    ["verify"],
  );
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
  privateKey: DeviceSigningKey,
): Promise<SignedCommandEnvelope> {
  const signature = await signDeviceBytes(
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
  privateKey: DeviceSigningKey,
): Promise<SignedResultEnvelope> {
  const signature = await signDeviceBytes(
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
  privateKey: DeviceSigningKey,
): Promise<AutomationSyncRequest> {
  const signature = await signDeviceBytes(
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
  privateKey: DeviceSigningKey,
): Promise<WorkflowOperationRequest> {
  const unsigned = unsignedWorkflowOperationRequestSchema.parse(candidate);
  const signature = await signDeviceBytes(
    privateKey,
    canonicalWorkflowOperationRequestBytes(unsigned),
  );
  return workflowOperationRequestSchema.parse({
    ...unsigned,
    signature: encodeBase64Url(new Uint8Array(signature)),
  });
}
