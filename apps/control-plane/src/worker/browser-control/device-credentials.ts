import {
  automationSyncRequestSchema,
  canonicalAutomationSyncRequestBytes,
  canonicalCommandEnvelopeBytes,
  canonicalContinuityRecipientKeyEnrollmentBytes,
  canonicalResultEnvelopeBytes,
  canonicalWorkflowOperationRequestBytes,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  workflowOperationRequestSchema,
  continuityRecipientKeyEnrollmentSchema,
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
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    const { signature, ...unsigned } = parsed.data;
    return crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64Url(signature),
      canonicalResultEnvelopeBytes(unsigned),
    );
  } catch {
    return false;
  }
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
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    const { signature, ...unsigned } = parsed.data;
    return crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64Url(signature),
      canonicalCommandEnvelopeBytes(unsigned),
    );
  } catch {
    return false;
  }
}

export async function verifyAutomationSyncRequest(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = automationSyncRequestSchema.safeParse(candidate);
  if (!parsed.success) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    const { signature, ...unsigned } = parsed.data;
    return crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64Url(signature),
      canonicalAutomationSyncRequestBytes(unsigned),
    );
  } catch {
    return false;
  }
}

export async function verifyWorkflowOperationRequest(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = workflowOperationRequestSchema.safeParse(candidate);
  if (!parsed.success) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    const { signature, ...unsigned } = parsed.data;
    return crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64Url(signature),
      canonicalWorkflowOperationRequestBytes(unsigned),
    );
  } catch {
    return false;
  }
}

export async function verifyContinuityRecipientKeyEnrollment(
  candidate: unknown,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parsed = continuityRecipientKeyEnrollmentSchema.safeParse(candidate);
  if (!parsed.success) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    const { signature, ...unsigned } = parsed.data;
    return crypto.subtle.verify(
      "Ed25519",
      key,
      decodeBase64Url(signature),
      canonicalContinuityRecipientKeyEnrollmentBytes(unsigned),
    );
  } catch {
    return false;
  }
}
