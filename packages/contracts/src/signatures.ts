import type { BrowserCommand, SignedResultEnvelope } from "./commands.js";

interface UnsignedEnvelopeBinding {
  protocolVersion: 1;
  principalId: string;
  deviceId: string;
  jobId: string;
  browserSessionId: string;
  actionId: string;
  leaseEpoch: number;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  workflowKind?: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
  workflowVersion?: 1;
  jobRevision?: number;
  logicalStep?:
    | "SET_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "SET_PREFERRED_FOCUS"
    | "FINALIZE_SETUP";
  effectId?: string;
}

export type UnsignedCommandEnvelope = UnsignedEnvelopeBinding & {
  command: BrowserCommand;
};
export type UnsignedResultEnvelope = UnsignedEnvelopeBinding & {
  result: SignedResultEnvelope["result"];
};

function workflowSignatureBinding(
  envelope: UnsignedCommandEnvelope | UnsignedResultEnvelope,
) {
  const candidate = envelope as unknown as Record<string, unknown>;
  return candidate.workflowKind !== undefined
    ? [
        candidate.workflowKind,
        candidate.workflowVersion,
        candidate.jobRevision,
        candidate.logicalStep,
        candidate.effectId,
      ]
    : [];
}

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
    ...workflowSignatureBinding(envelope),
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
    ...workflowSignatureBinding(envelope),
    envelope.result,
  ] as const;
  const bytes = new TextEncoder().encode(JSON.stringify(binding));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
