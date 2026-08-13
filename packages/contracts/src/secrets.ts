import { z } from "zod";
import { canonicalOriginSchema } from "./redaction.js";
import {
  actionIdSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  documentIdSchema,
  frameIdSchema,
  humanGateIdSchema,
  instantSchema,
  jobIdSchema,
  nodeIdSchema,
  operationAuthorizationIdSchema,
  principalIdSchema,
  secretFillAuthorizationIdSchema,
  stepUpAuthorizationIdSchema,
} from "./ids.js";

export const humanGateReasonSchema = z.enum([
  "CREDENTIAL",
  "TWO_FACTOR",
  "CAPTCHA",
  "PASSKEY",
  "PASSWORD_RESET",
  "FEDERATED_IDENTITY",
  "TERMS_OR_CONSENT",
  "SECURITY_WARNING",
  "UNKNOWN_CHALLENGE",
]);

export const humanGateSchema = z.strictObject({
  humanGateId: humanGateIdSchema,
  principalId: principalIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  reason: humanGateReasonSchema,
  resolver: z.literal("OWNER_ONLY"),
  state: z.enum(["OPEN", "RESOLVED", "CANCELED"]),
  createdAt: instantSchema,
});

export const credentialFillRequestSchema = z
  .strictObject({
    authorizationId: secretFillAuthorizationIdSchema,
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    jobId: jobIdSchema,
    browserSessionId: browserSessionIdSchema,
    actionId: actionIdSchema,
    leaseEpoch: z.number().int().positive(),
    exactOrigin: canonicalOriginSchema,
    documentId: documentIdSchema,
    mainFrameId: frameIdSchema,
    nodeId: nodeIdSchema,
    fieldSemantic: z.enum(["PASSWORD"]),
    credentialSlot: z.enum(["SITE_PRIMARY_CREDENTIAL"]),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/),
  })
  .superRefine((request, context) => {
    const lifetime =
      Date.parse(request.expiresAt) - Date.parse(request.issuedAt);
    if (lifetime <= 0 || lifetime > 120_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must follow issuedAt",
      });
    }
  });

const authorizationBinding = {
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  stateVersion: z.number().int().positive(),
  issuedAt: instantSchema,
  expiresAt: instantSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
};

export const operationAuthorizationSchema = z
  .strictObject({
    authorizationId: operationAuthorizationIdSchema,
    issuer: z.literal("DESKTOP_MAIN"),
    ...authorizationBinding,
    operation: z.enum(["CONTROL_TRANSFER", "SECRET_USE"]),
  })
  .superRefine((authorization, context) => {
    const lifetime =
      Date.parse(authorization.expiresAt) - Date.parse(authorization.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Operation authorization must expire within 60s",
      });
    }
  });

export const stepUpAuthorizationSchema = z
  .strictObject({
    authorizationId: stepUpAuthorizationIdSchema,
    issuer: z.literal("CONTROL_PLANE"),
    ...authorizationBinding,
    operation: z.literal("FORGET_SITE_SESSION"),
    site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
  })
  .superRefine((authorization, context) => {
    const lifetime =
      Date.parse(authorization.expiresAt) - Date.parse(authorization.issuedAt);
    if (lifetime <= 0 || lifetime > 300_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Step-up authorization must expire within 5 minutes",
      });
    }
  });

export type HumanGate = z.infer<typeof humanGateSchema>;
export type CredentialFillRequest = z.infer<typeof credentialFillRequestSchema>;
