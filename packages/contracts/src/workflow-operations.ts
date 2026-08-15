import { z } from "zod";
import {
  browserSessionIdSchema,
  deviceIdSchema,
  effectIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  setupLogicalStepSchema,
  setupObjectiveSchema,
} from "./ids.js";
import { actionPhaseSchema, setupActionReceiptSchema } from "./actions.js";
import { setupCheckpointSchema } from "./jobs.js";

const workflowOperationBinding = {
  protocolVersion: z.literal(1),
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  sequence: z.number().int().positive(),
  issuedAt: instantSchema,
  expiresAt: instantSchema,
};

const receiptOperationSchema = z.strictObject({
  ...workflowOperationBinding,
  operation: z.literal("RECORD_RECEIPT"),
  receipt: setupActionReceiptSchema,
  checkpoint: setupCheckpointSchema,
});

const freshLeaseOperationSchema = z.strictObject({
  ...workflowOperationBinding,
  operation: z.literal("CLAIM_FRESH_LEASE"),
  afterLeaseEpoch: z.number().int().positive(),
  cursor: z.number().int().nonnegative(),
  leaseExpiresAt: instantSchema,
});

const takeoverOperationSchema = z.strictObject({
  ...workflowOperationBinding,
  operation: z.literal("TAKEOVER"),
  expectedLeaseEpoch: z.number().int().positive(),
  cursor: z.number().int().nonnegative(),
});

const ownerProgressOperationSchema = z.strictObject({
  ...workflowOperationBinding,
  operation: z.literal("RECORD_OWNER_PROGRESS"),
  objective: setupObjectiveSchema,
  jobRevision: z.number().int().positive(),
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
  actionPhase: actionPhaseSchema,
  leaseEpoch: z.number().int().positive(),
  cursor: z.number().int().nonnegative(),
  actor: z.literal("OWNER"),
  occurredAt: instantSchema,
});

export const unsignedWorkflowOperationRequestSchema = z
  .discriminatedUnion("operation", [
    receiptOperationSchema,
    freshLeaseOperationSchema,
    takeoverOperationSchema,
    ownerProgressOperationSchema,
  ])
  .superRefine((request, context) => {
    const lifetime =
      Date.parse(request.expiresAt) - Date.parse(request.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Envelope lifetime must be between 1ms and 60s",
      });
    }
  });

export const workflowOperationRequestSchema = z
  .union([
    receiptOperationSchema.extend({
      signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
    }),
    freshLeaseOperationSchema.extend({
      signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
    }),
    takeoverOperationSchema.extend({
      signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
    }),
    ownerProgressOperationSchema.extend({
      signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
    }),
  ])
  .superRefine((request, context) => {
    const lifetime =
      Date.parse(request.expiresAt) - Date.parse(request.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Envelope lifetime must be between 1ms and 60s",
      });
    }
  });

export const workflowOperationResponseSchema = z.discriminatedUnion(
  "operation",
  [
    z.strictObject({
      ok: z.literal(true),
      operation: z.literal("RECORD_RECEIPT"),
      cursor: z.number().int().nonnegative(),
    }),
    z.strictObject({
      ok: z.literal(true),
      operation: z.literal("CLAIM_FRESH_LEASE"),
      cursor: z.number().int().nonnegative(),
      leaseEpoch: z.number().int().positive(),
    }),
    z.strictObject({
      ok: z.literal(true),
      operation: z.literal("TAKEOVER"),
      cursor: z.number().int().nonnegative(),
      leaseEpoch: z.number().int().positive(),
    }),
    z.strictObject({
      ok: z.literal(true),
      operation: z.literal("RECORD_OWNER_PROGRESS"),
      cursor: z.number().int().nonnegative(),
    }),
  ],
);

export type UnsignedWorkflowOperationRequest = z.infer<
  typeof unsignedWorkflowOperationRequestSchema
>;
export type WorkflowOperationRequest = z.infer<
  typeof workflowOperationRequestSchema
>;
export type WorkflowOperationResponse = z.infer<
  typeof workflowOperationResponseSchema
>;

export function canonicalWorkflowOperationRequestBytes(
  candidate: UnsignedWorkflowOperationRequest,
): ArrayBuffer {
  const request = unsignedWorkflowOperationRequestSchema.parse(candidate);
  const operation = (() => {
    switch (request.operation) {
      case "RECORD_RECEIPT":
        return [request.operation, request.receipt, request.checkpoint];
      case "CLAIM_FRESH_LEASE":
        return [
          request.operation,
          request.afterLeaseEpoch,
          request.cursor,
          request.leaseExpiresAt,
        ];
      case "TAKEOVER":
        return [request.operation, request.expectedLeaseEpoch, request.cursor];
      case "RECORD_OWNER_PROGRESS":
        return [
          request.operation,
          request.objective,
          request.jobRevision,
          request.logicalStep,
          request.effectId,
          request.actionPhase,
          request.leaseEpoch,
          request.cursor,
          request.actor,
          request.occurredAt,
        ];
    }
  })();
  const binding = [
    request.protocolVersion,
    request.principalId,
    request.deviceId,
    request.jobId,
    request.browserSessionId,
    request.connectionId,
    request.sequence,
    request.issuedAt,
    request.expiresAt,
    ...operation,
  ];
  const bytes = new TextEncoder().encode(JSON.stringify(binding));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
