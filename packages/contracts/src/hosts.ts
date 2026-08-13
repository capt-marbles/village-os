import { z } from "zod";
import {
  deviceIdSchema,
  hostIdSchema,
  instantSchema,
  pairingIdSchema,
  principalIdSchema,
} from "./ids.js";

export const hostCapabilitySchema = z.enum([
  "VISIBLE_BROWSER",
  "LOCAL_PROFILE",
  "HUMAN_TAKEOVER",
  "SECRET_BROKER",
  "REMOTE_SUPERVISION",
]);

export const executionHostSchema = z.strictObject({
  hostId: hostIdSchema,
  principalId: principalIdSchema,
  deviceId: deviceIdSchema.nullable(),
  trustClass: z.enum(["LOCAL_TRUSTED", "REMOTE_ISOLATED"]),
  networkClass: z.enum(["USER_NETWORK", "DATACENTER"]),
  connection: z.enum(["ONLINE", "OFFLINE", "ABSENT"]),
  capabilities: z.array(hostCapabilitySchema).max(8),
});

export const siteExecutionPolicySchema = z.strictObject({
  site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
  eligibleTrustClasses: z
    .array(z.enum(["LOCAL_TRUSTED", "REMOTE_ISOLATED"]))
    .min(1)
    .max(2),
  eligibleNetworkClasses: z
    .array(z.enum(["USER_NETWORK", "DATACENTER"]))
    .min(1)
    .max(2),
  requiredCapabilities: z.array(hostCapabilitySchema).max(8),
});

export const authenticatedQuotaPolicySchema = z.strictObject({
  maxConnectionsPerPrincipal: z.number().int().positive().max(128),
  maxConnectionsPerDevice: z.number().int().positive().max(32),
  maxCommandsPerMinute: z.number().int().positive().max(10_000),
  maxReplayWindow: z.number().int().positive().max(10_000),
  maxNotificationsPerHour: z.number().int().positive().max(1_000),
  maxRetainedEventsPerJob: z.number().int().positive().max(1_000_000),
});

export const deviceCredentialSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  algorithm: z.literal("Ed25519"),
  publicKey: z.strictObject({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  }),
  protection: z.enum(["HARDWARE_NON_EXPORTABLE", "OS_PROTECTED_FALLBACK"]),
  status: z.enum(["ACTIVE", "REVOKED"]),
  createdAt: instantSchema,
});

export const pairingChallengeSchema = z.strictObject({
  pairingId: pairingIdSchema,
  principalId: principalIdSchema,
  deviceDisplayName: z.string().min(1).max(80),
  publicKey: deviceCredentialSchema.shape.publicKey,
  expiresAt: instantSchema,
  attemptsRemaining: z.number().int().nonnegative().max(10),
  state: z.enum([
    "PENDING_CONFIRMATION",
    "CONFIRMED",
    "EXPIRED",
    "REJECTED",
    "CONSUMED",
  ]),
});

export type ExecutionHost = z.infer<typeof executionHostSchema>;
