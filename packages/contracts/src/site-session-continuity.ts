import { z } from "zod";
import {
  browserSessionIdSchema,
  continuityGrantIdSchema,
  deviceIdSchema,
  instantSchema,
  principalIdSchema,
} from "./ids.js";
import { deviceCredentialSchema } from "./hosts.js";

export const continuityBindingSchema = z.strictObject({
  principalId: principalIdSchema,
  grantId: continuityGrantIdSchema,
  sourceDeviceId: deviceIdSchema,
  destinationDeviceId: deviceIdSchema,
  sourceBrowserSessionId: browserSessionIdSchema,
  destinationBrowserSessionId: browserSessionIdSchema,
  site: z.literal("OWNED_FIXTURE"),
});

export const x25519PublicKeySchema = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("X25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const continuityGrantRequestSchema = z
  .strictObject({
    grantId: continuityGrantIdSchema,
    sourceDeviceId: deviceIdSchema,
    destinationDeviceId: deviceIdSchema,
    sourceBrowserSessionId: browserSessionIdSchema,
    destinationBrowserSessionId: browserSessionIdSchema,
    site: z.literal("OWNED_FIXTURE"),
    expiresAt: instantSchema,
  })
  .superRefine((grant, context) => {
    if (grant.sourceDeviceId === grant.destinationDeviceId) {
      context.addIssue({
        code: "custom",
        path: ["destinationDeviceId"],
        message: "Source and destination devices must differ",
      });
    }
    if (grant.sourceBrowserSessionId === grant.destinationBrowserSessionId) {
      context.addIssue({
        code: "custom",
        path: ["destinationBrowserSessionId"],
        message: "Source and destination Browser Sessions must differ",
      });
    }
  });

export const continuityRecipientKeyRevocationSchema = z.strictObject({
  deviceId: deviceIdSchema,
  browserSessionId: browserSessionIdSchema,
  site: z.literal("OWNED_FIXTURE"),
});

export const continuitySetupSessionSchema = z.strictObject({
  deviceId: deviceIdSchema,
  browserSessionId: browserSessionIdSchema,
  deviceName: z.string().trim().min(1).max(80),
  connection: z.enum(["ONLINE", "OFFLINE", "ABSENT"]),
  recipientKeyState: z.enum(["READY", "MISSING", "STALE"]),
});

export const continuitySetupGrantSchema = z.strictObject({
  grantId: continuityGrantIdSchema,
  sourceDeviceId: deviceIdSchema,
  destinationDeviceId: deviceIdSchema,
  sourceBrowserSessionId: browserSessionIdSchema,
  destinationBrowserSessionId: browserSessionIdSchema,
  site: z.literal("OWNED_FIXTURE"),
  state: z.enum(["PENDING", "ACTIVE", "REVOKED", "EXPIRED"]),
  createdAt: instantSchema,
  expiresAt: instantSchema,
});

export const continuitySetupResponseSchema = z.strictObject({
  ok: z.literal(true),
  sessions: z.array(continuitySetupSessionSchema).max(50),
  grants: z.array(continuitySetupGrantSchema).max(100),
});

export const continuityGrantCreationResponseSchema = z.strictObject({
  ok: z.literal(true),
  created: z.boolean(),
  grant: continuitySetupGrantSchema,
});

export const continuityGrantRevocationResponseSchema = z.strictObject({
  ok: z.literal(true),
  revoked: z.literal(true),
});

export const continuityGrantDeletionResponseSchema = z.strictObject({
  ok: z.literal(true),
  deleted: z.literal(true),
});

export const continuityGrantStatusResponseSchema = z.strictObject({
  ok: z.literal(true),
  grant: continuitySetupGrantSchema,
  transfer: z.strictObject({
    state: z.enum(["ACTIVE", "REVOKED", "EXPIRED"]),
    publishedRevision: z.number().int().nonnegative(),
    appliedRevision: z.number().int().nonnegative(),
    pendingRevisions: z.number().int().nonnegative(),
  }),
});

export type ContinuitySetupResponse = z.infer<
  typeof continuitySetupResponseSchema
>;
export type ContinuityGrantStatusResponse = z.infer<
  typeof continuityGrantStatusResponseSchema
>;

const unsignedContinuityRevisionSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    ...continuityBindingSchema.shape,
    revision: z.number().int().positive(),
    previousDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    ephemeralPublicKey: x25519PublicKeySchema,
    salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{1,131072}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((revision, context) => {
    const lifetime =
      Date.parse(revision.expiresAt) - Date.parse(revision.issuedAt);
    if (lifetime <= 0 || lifetime > 24 * 60 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Revision lifetime must be between 1ms and 24h",
      });
    }
  });

export const encryptedContinuityRevisionSchema =
  unsignedContinuityRevisionSchema.safeExtend({
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  });

const deviceEnvelopeBinding = {
  protocolVersion: z.literal(1),
  ...continuityBindingSchema.shape,
  sequence: z.number().int().positive(),
  issuedAt: instantSchema,
  expiresAt: instantSchema,
};

function boundedDeviceEnvelope<Shape extends z.ZodRawShape>(shape: Shape) {
  return z
    .strictObject({
      ...deviceEnvelopeBinding,
      ...shape,
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .superRefine((envelope, context) => {
      const temporal = envelope as unknown as {
        issuedAt: string;
        expiresAt: string;
      };
      const lifetime =
        Date.parse(temporal.expiresAt) - Date.parse(temporal.issuedAt);
      if (lifetime <= 0 || lifetime > 60_000) {
        context.addIssue({
          code: "custom",
          path: ["expiresAt"],
          message: "Device request lifetime must be between 1ms and 60s",
        });
      }
    });
}

export const continuityFetchEnvelopeSchema = boundedDeviceEnvelope({
  afterRevision: z.number().int().nonnegative(),
});

export const continuityAcknowledgementEnvelopeSchema = boundedDeviceEnvelope({
  revision: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

const unsignedContinuityRecipientKeyEnrollmentSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    browserSessionId: browserSessionIdSchema,
    site: z.literal("OWNED_FIXTURE"),
    sequence: z.number().int().positive(),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    encryptionPublicKey: x25519PublicKeySchema,
  })
  .superRefine((enrollment, context) => {
    const lifetime =
      Date.parse(enrollment.expiresAt) - Date.parse(enrollment.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message:
          "Recipient-key enrollment lifetime must be between 1ms and 60s",
      });
    }
  });

export const continuityRecipientKeyEnrollmentSchema =
  unsignedContinuityRecipientKeyEnrollmentSchema.safeExtend({
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  });

export const continuityActivationIdentitySchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  browserSessionId: browserSessionIdSchema,
  site: z.literal("OWNED_FIXTURE"),
});

const unsignedContinuityActivationRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    ...continuityActivationIdentitySchema.shape,
    sequence: z.number().int().positive(),
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
        message: "Activation request lifetime must be between 1ms and 60s",
      });
    }
  });

export const continuityActivationRequestSchema =
  unsignedContinuityActivationRequestSchema.safeExtend({
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  });

const continuityActivationBase = {
  binding: continuityBindingSchema,
  peerSigningPublicKey: deviceCredentialSchema.shape.publicKey,
};

export const continuityActivationSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("SOURCE"),
    ...continuityActivationBase,
    destinationEncryptionPublicKey: x25519PublicKeySchema,
  }),
  z.strictObject({
    role: z.literal("DESTINATION"),
    ...continuityActivationBase,
  }),
]);

export const continuityActivationResponseSchema = z.strictObject({
  ok: z.literal(true),
  activations: z.array(continuityActivationSchema).max(20),
});

export type ContinuityBinding = z.infer<typeof continuityBindingSchema>;
export type EncryptedContinuityRevision = z.infer<
  typeof encryptedContinuityRevisionSchema
>;
export type ContinuityFetchEnvelope = z.infer<
  typeof continuityFetchEnvelopeSchema
>;
export type ContinuityAcknowledgementEnvelope = z.infer<
  typeof continuityAcknowledgementEnvelopeSchema
>;
export type UnsignedContinuityRevision = z.infer<
  typeof unsignedContinuityRevisionSchema
>;
export type ContinuityRecipientKeyEnrollment = z.infer<
  typeof continuityRecipientKeyEnrollmentSchema
>;
export type ContinuityActivation = z.infer<typeof continuityActivationSchema>;
export type ContinuityActivationIdentity = z.infer<
  typeof continuityActivationIdentitySchema
>;

function canonicalBytes(values: readonly unknown[]): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bindingValues(binding: ContinuityBinding): readonly unknown[] {
  return [
    binding.principalId,
    binding.grantId,
    binding.sourceDeviceId,
    binding.destinationDeviceId,
    binding.sourceBrowserSessionId,
    binding.destinationBrowserSessionId,
    binding.site,
  ];
}

export function canonicalContinuityRevisionBytes(
  revision: UnsignedContinuityRevision,
): ArrayBuffer {
  return canonicalBytes([
    ...JSON.parse(
      new TextDecoder().decode(
        canonicalContinuityRevisionAssociatedData(revision),
      ),
    ),
    revision.ciphertext,
    revision.digest,
  ]);
}

export function canonicalContinuityRevisionAssociatedData(
  revision: Omit<UnsignedContinuityRevision, "ciphertext" | "digest">,
): ArrayBuffer {
  return canonicalBytes([
    revision.protocolVersion,
    ...bindingValues(revision),
    revision.revision,
    revision.previousDigest,
    revision.issuedAt,
    revision.expiresAt,
    revision.ephemeralPublicKey,
    revision.salt,
    revision.iv,
  ]);
}

export function continuityRevisionDigestBytes(
  associatedData: ArrayBuffer,
  ciphertext: ArrayBuffer,
): ArrayBuffer {
  const bytes = new Uint8Array(
    associatedData.byteLength + ciphertext.byteLength,
  );
  bytes.set(new Uint8Array(associatedData));
  bytes.set(new Uint8Array(ciphertext), associatedData.byteLength);
  return bytes.buffer;
}

export function canonicalContinuityFetchBytes(
  request: Omit<ContinuityFetchEnvelope, "signature">,
): ArrayBuffer {
  return canonicalBytes([
    request.protocolVersion,
    ...bindingValues(request),
    request.sequence,
    request.afterRevision,
    request.issuedAt,
    request.expiresAt,
  ]);
}

export function canonicalContinuityAcknowledgementBytes(
  request: Omit<ContinuityAcknowledgementEnvelope, "signature">,
): ArrayBuffer {
  return canonicalBytes([
    request.protocolVersion,
    ...bindingValues(request),
    request.sequence,
    request.revision,
    request.digest,
    request.issuedAt,
    request.expiresAt,
  ]);
}

export function canonicalContinuityRecipientKeyEnrollmentBytes(
  enrollment: Omit<ContinuityRecipientKeyEnrollment, "signature">,
): ArrayBuffer {
  return canonicalBytes([
    enrollment.protocolVersion,
    enrollment.principalId,
    enrollment.deviceId,
    enrollment.browserSessionId,
    enrollment.site,
    enrollment.sequence,
    enrollment.issuedAt,
    enrollment.expiresAt,
    enrollment.encryptionPublicKey,
  ]);
}

export function canonicalContinuityActivationRequestBytes(
  request: Omit<z.infer<typeof continuityActivationRequestSchema>, "signature">,
): ArrayBuffer {
  return canonicalBytes([
    request.protocolVersion,
    request.principalId,
    request.deviceId,
    request.browserSessionId,
    request.site,
    request.sequence,
    request.issuedAt,
    request.expiresAt,
  ]);
}
