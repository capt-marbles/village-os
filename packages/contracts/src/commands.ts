import { z } from "zod";
import {
  actionIdSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";
import { browserObservationSchema } from "./redaction.js";

const sessionOpenCommandSchema = z.strictObject({
  capability: z.literal("SESSION_OPEN"),
  site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
});

const navigateCommandSchema = z.strictObject({
  capability: z.literal("NAVIGATE"),
  destination: z.enum(["FIXTURE_SIGN_IN", "LINKEDIN_SIGN_IN"]),
});

const observeCommandSchema = z.strictObject({
  capability: z.literal("OBSERVE"),
  facts: z
    .array(z.enum(["AUTH_STATE", "HUMAN_GATE", "ACTION_POSTCONDITION"]))
    .min(1)
    .max(8),
});

const fixtureInputCommandSchema = z.strictObject({
  capability: z.literal("FIXTURE_INPUT"),
  field: z.enum(["IDENTIFIER", "NON_SECRET_TEXT"]),
  value: z.string().min(1).max(256),
});

const secretFillCommandSchema = z.strictObject({
  capability: z.literal("REQUEST_SECRET_FILL"),
  credentialSlot: z.enum(["SITE_PRIMARY_CREDENTIAL"]),
  field: z.enum(["PASSWORD"]),
});

const humanGateCommandSchema = z.strictObject({
  capability: z.literal("REQUEST_HUMAN_GATE"),
  reason: z.enum([
    "CREDENTIAL",
    "TWO_FACTOR",
    "CAPTCHA",
    "PASSKEY",
    "PASSWORD_RESET",
    "FEDERATED_IDENTITY",
    "TERMS_OR_CONSENT",
    "SECURITY_WARNING",
    "UNKNOWN_CHALLENGE",
  ]),
});

const checkpointCommandSchema = z.strictObject({
  capability: z.literal("CHECKPOINT"),
  reason: z.enum([
    "ACTION_COMPLETE",
    "WAITING_FOR_USER",
    "WAITING_FOR_BROWSER",
  ]),
});

const verifyCommandSchema = z.strictObject({
  capability: z.literal("VERIFY_AUTHENTICATION"),
  predicateVersion: z.string().regex(/^[a-z0-9-]{1,64}$/),
});

export const browserCommandSchema = z.discriminatedUnion("capability", [
  sessionOpenCommandSchema,
  navigateCommandSchema,
  observeCommandSchema,
  fixtureInputCommandSchema,
  secretFillCommandSchema,
  humanGateCommandSchema,
  checkpointCommandSchema,
  verifyCommandSchema,
]);

export const signedCommandEnvelopeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    jobId: jobIdSchema,
    browserSessionId: browserSessionIdSchema,
    actionId: actionIdSchema,
    leaseEpoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    command: browserCommandSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
  })
  .superRefine((envelope, context) => {
    const lifetime =
      Date.parse(envelope.expiresAt) - Date.parse(envelope.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must follow issuedAt",
        path: ["expiresAt"],
      });
    }
  });

export const commandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ACCEPTED") }),
  z.strictObject({
    status: z.literal("REJECTED"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }),
  z.strictObject({ status: z.literal("WAITING_FOR_USER") }),
  z.strictObject({ status: z.literal("RECONCILIATION_REQUIRED") }),
  z.strictObject({
    status: z.literal("OBSERVATION"),
    observation: browserObservationSchema,
  }),
  z.strictObject({
    status: z.literal("VERIFICATION"),
    verification: z.enum([
      "authenticated",
      "confirmed_by_user",
      "not_authenticated",
      "unknown",
    ]),
    predicateVersion: z.string().regex(/^[a-z0-9-]{1,64}$/),
  }),
]);

export const signedResultEnvelopeSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    jobId: jobIdSchema,
    browserSessionId: browserSessionIdSchema,
    actionId: actionIdSchema,
    leaseEpoch: z.number().int().positive(),
    sequence: z.number().int().positive(),
    issuedAt: instantSchema,
    expiresAt: instantSchema,
    result: commandResultSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
  })
  .superRefine((envelope, context) => {
    const lifetime =
      Date.parse(envelope.expiresAt) - Date.parse(envelope.issuedAt);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must follow issuedAt",
        path: ["expiresAt"],
      });
    }
  });

export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export type SignedCommandEnvelope = z.infer<typeof signedCommandEnvelopeSchema>;
export type SignedResultEnvelope = z.infer<typeof signedResultEnvelopeSchema>;

export type Site = "OWNED_FIXTURE" | "LINKEDIN";
export type SiteCommandAuthorization =
  | { ok: true }
  | {
      ok: false;
      code: "SITE_CAPABILITY_DENIED" | "DESTINATION_SITE_MISMATCH";
    };

export function authorizeSiteCommand(
  site: Site,
  candidate: unknown,
): SiteCommandAuthorization {
  const parsed = browserCommandSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  const command = parsed.data;
  if (
    command.capability === "NAVIGATE" &&
    ((site === "LINKEDIN" && command.destination !== "LINKEDIN_SIGN_IN") ||
      (site === "OWNED_FIXTURE" && command.destination !== "FIXTURE_SIGN_IN"))
  ) {
    return { ok: false, code: "DESTINATION_SITE_MISMATCH" };
  }
  if (command.capability === "SESSION_OPEN" && command.site !== site) {
    return { ok: false, code: "DESTINATION_SITE_MISMATCH" };
  }
  if (
    site === "LINKEDIN" &&
    (command.capability === "FIXTURE_INPUT" ||
      command.capability === "REQUEST_SECRET_FILL")
  ) {
    return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  }
  return { ok: true };
}
