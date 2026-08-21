import {
  automationSyncRequestSchema,
  canonicalAutomationSyncRequestBytes,
  canonicalCommandEnvelopeBytes,
  canonicalContinuityRecipientKeyEnrollmentBytes,
  canonicalContinuityActivationRequestBytes,
  canonicalResultEnvelopeBytes,
  canonicalWorkflowOperationRequestBytes,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  workflowOperationRequestSchema,
  continuityRecipientKeyEnrollmentSchema,
  continuityActivationRequestSchema,
  deviceSigningPublicKeySchema,
} from "@village/contracts";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function verifyResultEnvelope(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = signedResultEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyDeviceSignature(
    publicJwk,
    signature,
    canonicalResultEnvelopeBytes(unsigned),
  );
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return toArrayBuffer(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export async function verifyCommandEnvelope(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = signedCommandEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyDeviceSignature(
    publicJwk,
    signature,
    canonicalCommandEnvelopeBytes(unsigned),
  );
}

export async function verifyAutomationSyncRequest(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = automationSyncRequestSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyDeviceSignature(
    publicJwk,
    signature,
    canonicalAutomationSyncRequestBytes(unsigned),
  );
}

export async function verifyWorkflowOperationRequest(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = workflowOperationRequestSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyDeviceSignature(
    publicJwk,
    signature,
    canonicalWorkflowOperationRequestBytes(unsigned),
  );
}

export async function verifyContinuityRecipientKeyEnrollment(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = continuityRecipientKeyEnrollmentSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyDeviceSignature(
    publicJwk,
    signature,
    canonicalContinuityRecipientKeyEnrollmentBytes(unsigned),
  );
}

export async function verifyContinuityActivationRequest(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = continuityActivationRequestSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyDeviceSignature(
    publicJwk,
    signature,
    canonicalContinuityActivationRequestBytes(unsigned),
  );
}

export async function verifyDeviceSignature(
  publicJwk: JsonWebKey,
  signature: string,
  payload: ArrayBuffer,
): Promise<boolean> {
  try {
    const parsedKey = deviceSigningPublicKeySchema.parse(
      publicJwk.kty === "EC"
        ? {
            kty: publicJwk.kty,
            crv: publicJwk.crv,
            x: publicJwk.x,
            y: publicJwk.y,
          }
        : { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x },
    );
    const isHardwareKey = parsedKey.kty === "EC";
    const key = await crypto.subtle.importKey(
      "jwk",
      parsedKey,
      isHardwareKey ? { name: "ECDSA", namedCurve: "P-256" } : "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      isHardwareKey ? { name: "ECDSA", hash: "SHA-256" } : "Ed25519",
      key,
      decodeBase64Url(signature),
      payload,
    );
  } catch {
    return false;
  }
}
