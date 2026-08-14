import { z } from "zod";
import {
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";
import { setupActionReceiptSchema } from "./actions.js";
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

export const unsignedWorkflowOperationRequestSchema = z
  .discriminatedUnion("operation", [
    receiptOperationSchema,
    freshLeaseOperationSchema,
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
  const operation =
    request.operation === "RECORD_RECEIPT"
      ? [request.operation, request.receipt, request.checkpoint]
      : [
          request.operation,
          request.afterLeaseEpoch,
          request.cursor,
          request.leaseExpiresAt,
        ];
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
