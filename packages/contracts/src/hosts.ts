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

export const siteExecutionPolicies = {
  OWNED_FIXTURE: siteExecutionPolicySchema.parse({
    site: "OWNED_FIXTURE",
    eligibleTrustClasses: ["LOCAL_TRUSTED"],
    eligibleNetworkClasses: ["USER_NETWORK"],
    requiredCapabilities: [
      "VISIBLE_BROWSER",
      "LOCAL_PROFILE",
      "HUMAN_TAKEOVER",
    ],
  }),
  LINKEDIN: siteExecutionPolicySchema.parse({
    site: "LINKEDIN",
    eligibleTrustClasses: ["LOCAL_TRUSTED"],
    eligibleNetworkClasses: ["USER_NETWORK"],
    requiredCapabilities: [
      "VISIBLE_BROWSER",
      "LOCAL_PROFILE",
      "HUMAN_TAKEOVER",
    ],
  }),
} as const;

export function isHostEligibleForSite(
  host: ExecutionHost,
  site: keyof typeof siteExecutionPolicies,
): boolean {
  const parsed = executionHostSchema.safeParse(host);
  if (!parsed.success) return false;
  const policy = siteExecutionPolicies[site];
  return (
    parsed.data.connection === "ONLINE" &&
    policy.eligibleTrustClasses.includes(parsed.data.trustClass as never) &&
    policy.eligibleNetworkClasses.includes(parsed.data.networkClass as never) &&
    policy.requiredCapabilities.every((capability) =>
      parsed.data.capabilities.includes(capability),
    )
  );
}

export const authenticatedQuotaPolicySchema = z.strictObject({
  maxConnectionsPerPrincipal: z.number().int().positive().max(128),
  maxConnectionsPerDevice: z.number().int().positive().max(32),
  maxCommandsPerMinute: z.number().int().positive().max(10_000),
  maxReplayWindow: z.number().int().positive().max(10_000),
  maxNotificationsPerHour: z.number().int().positive().max(1_000),
  maxRetainedEventsPerJob: z.number().int().positive().max(1_000_000),
});

export const ed25519DevicePublicKeySchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

export const p256DevicePublicKeySchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const deviceSigningPublicKeySchema = z.union([
  ed25519DevicePublicKeySchema,
  p256DevicePublicKeySchema,
]);
export type DeviceSigningPublicKey = z.infer<
  typeof deviceSigningPublicKeySchema
>;

export const devicePairingMaterialSchema = z.union([
  z.strictObject({
    publicKey: p256DevicePublicKeySchema,
    protection: z.literal("HARDWARE_NON_EXPORTABLE"),
  }),
  z.strictObject({
    publicKey: ed25519DevicePublicKeySchema,
    protection: z.literal("OS_PROTECTED_FALLBACK"),
  }),
]);
export type DevicePairingMaterial = z.infer<typeof devicePairingMaterialSchema>;

const deviceCredentialFields = {
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  status: z.enum(["ACTIVE", "REVOKED"]),
  createdAt: instantSchema,
};

export const deviceCredentialSchema = z.union([
  z.strictObject({
    ...deviceCredentialFields,
    ...devicePairingMaterialSchema.options[0].shape,
    algorithm: z.literal("ES256"),
  }),
  z.strictObject({
    ...deviceCredentialFields,
    ...devicePairingMaterialSchema.options[1].shape,
    algorithm: z.literal("Ed25519"),
  }),
]);

const publicPairingRequestFields = {
  deviceId: deviceIdSchema,
  deviceDisplayName: z.string().trim().min(1).max(80),
  secretHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};

export const publicPairingRequestSchema = z.union([
  z.strictObject({
    ...publicPairingRequestFields,
    ...devicePairingMaterialSchema.options[0].shape,
  }),
  z.strictObject({
    ...publicPairingRequestFields,
    ...devicePairingMaterialSchema.options[1].shape,
  }),
]);
export type PublicPairingRequest = z.infer<typeof publicPairingRequestSchema>;

export const pairingChallengeSchema = z.strictObject({
  pairingId: pairingIdSchema,
  principalId: principalIdSchema,
  deviceDisplayName: z.string().min(1).max(80),
  publicKey: deviceSigningPublicKeySchema,
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
