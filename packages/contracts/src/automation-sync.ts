import { z } from "zod";
import {
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";
import { connectionStateSchema, controllerSchema } from "./browser.js";

const unsignedAutomationSyncRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    browserSessionId: browserSessionIdSchema,
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    sequence: z.number().int().positive(),
    cursor: z.number().int().nonnegative(),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
  })
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

export const automationSyncRequestSchema =
  unsignedAutomationSyncRequestSchema.safeExtend({
    signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
  });

export const automationSyncResponseSchema = z.strictObject({
  ok: z.literal(true),
  cursor: z.number().int().nonnegative(),
  jobId: jobIdSchema,
  controller: controllerSchema,
  connection: connectionStateSchema,
  leaseEpoch: z.number().int().nonnegative(),
  automationBlocked: z.boolean(),
});

export type UnsignedAutomationSyncRequest = z.infer<
  typeof unsignedAutomationSyncRequestSchema
>;
export type AutomationSyncRequest = z.infer<typeof automationSyncRequestSchema>;
export type AutomationSyncResponse = z.infer<
  typeof automationSyncResponseSchema
>;

export function canonicalAutomationSyncRequestBytes(
  request: UnsignedAutomationSyncRequest,
): ArrayBuffer {
  const canonical = {
    browserSessionId: request.browserSessionId,
    connectionId: request.connectionId,
    cursor: request.cursor,
    deviceId: request.deviceId,
    expiresAt: request.expiresAt,
    issuedAt: request.issuedAt,
    principalId: request.principalId,
    protocolVersion: request.protocolVersion,
    sequence: request.sequence,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
