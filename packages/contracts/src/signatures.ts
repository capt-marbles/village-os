import type {
  SignedCommandEnvelope,
  SignedResultEnvelope,
} from "./commands.js";

export type UnsignedCommandEnvelope = Omit<SignedCommandEnvelope, "signature">;
export type UnsignedResultEnvelope = Omit<SignedResultEnvelope, "signature">;

export function canonicalCommandEnvelopeBytes(
  envelope: UnsignedCommandEnvelope,
): ArrayBuffer {
  const binding = [
    envelope.protocolVersion,
    envelope.principalId,
    envelope.deviceId,
    envelope.jobId,
    envelope.browserSessionId,
    envelope.actionId,
    envelope.leaseEpoch,
    envelope.sequence,
    envelope.issuedAt,
    envelope.expiresAt,
    envelope.command,
  ] as const;
  const bytes = new TextEncoder().encode(JSON.stringify(binding));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function canonicalResultEnvelopeBytes(
  envelope: UnsignedResultEnvelope,
): ArrayBuffer {
  const binding = [
    envelope.protocolVersion,
    envelope.principalId,
    envelope.deviceId,
    envelope.jobId,
    envelope.browserSessionId,
    envelope.actionId,
    envelope.leaseEpoch,
    envelope.sequence,
    envelope.issuedAt,
    envelope.expiresAt,
    envelope.result,
  ] as const;
  const bytes = new TextEncoder().encode(JSON.stringify(binding));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
