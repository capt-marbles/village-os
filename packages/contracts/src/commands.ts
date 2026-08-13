import { z } from "zod";
import {
  actionIdSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
} from "./ids.js";
import { verificationStatusSchema } from "./browser.js";
import {
  browserObservationSchema,
  canonicalOriginSchema,
  predicateIdSchema,
} from "./redaction.js";
import { humanGateReasonSchema } from "./secrets.js";

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
  reason: humanGateReasonSchema,
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
  predicateVersion: predicateIdSchema,
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

/** JSON Schema advertised to model providers; local Zod parsing remains authoritative. */
export const browserCommandJsonSchema = z.toJSONSchema(browserCommandSchema);

const authenticatedEnvelopeBinding = {
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
  signature: z.string().regex(/^[A-Za-z0-9_-]{8,2048}$/),
};

function boundedAuthenticatedEnvelope<Shape extends z.ZodRawShape>(
  payload: Shape,
) {
  return z
    .strictObject({ ...authenticatedEnvelopeBinding, ...payload })
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
          message: "Envelope lifetime must be between 1ms and 60s",
          path: ["expiresAt"],
        });
      }
    });
}

export const signedCommandEnvelopeSchema = boundedAuthenticatedEnvelope({
  command: browserCommandSchema,
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
    verification: verificationStatusSchema,
    predicateVersion: predicateIdSchema,
  }),
]);

export const signedResultEnvelopeSchema = boundedAuthenticatedEnvelope({
  result: commandResultSchema,
});

export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export type SignedCommandEnvelope = z.infer<typeof signedCommandEnvelopeSchema>;
export type SignedResultEnvelope = z.infer<typeof signedResultEnvelopeSchema>;

export const siteSchema = z.enum(["OWNED_FIXTURE", "LINKEDIN"]);
export type Site = z.infer<typeof siteSchema>;

export const browserSiteActionSchema = z.enum([
  "OPEN_SIGN_IN",
  "HUMAN_TAKEOVER",
  "VERIFY_AUTHENTICATION",
  "OWNER_CONFIRMED_SIGN_OUT",
  "FORGET_SESSION",
  "AUTOMATED_INPUT",
  "SCRAPE",
  "MESSAGE",
  "POST",
  "REACT",
  "CONNECT",
  "FIXTURE_INPUT",
  "REQUEST_SECRET_FILL",
  "RAW_CDP",
]);

export type BrowserSiteAction = z.infer<typeof browserSiteActionSchema>;
export type BrowserSiteActionAuthorization =
  | { ok: true }
  | {
      ok: false;
      code:
        | "LINKEDIN_HUMAN_ONLY"
        | "STEP_UP_LIFECYCLE_REQUIRED"
        | "SITE_CAPABILITY_DENIED";
    };

const linkedInHumanActions = new Set<BrowserSiteAction>([
  "OPEN_SIGN_IN",
  "HUMAN_TAKEOVER",
  "VERIFY_AUTHENTICATION",
  "OWNER_CONFIRMED_SIGN_OUT",
]);

export function authorizeBrowserSiteAction(
  site: unknown,
  action: unknown,
): BrowserSiteActionAuthorization {
  const parsedSite = siteSchema.safeParse(site);
  const parsedAction = browserSiteActionSchema.safeParse(action);
  if (!parsedSite.success || !parsedAction.success) {
    return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  }
  if (parsedAction.data === "FORGET_SESSION") {
    return { ok: false, code: "STEP_UP_LIFECYCLE_REQUIRED" };
  }
  if (parsedSite.data === "LINKEDIN") {
    return linkedInHumanActions.has(parsedAction.data)
      ? { ok: true }
      : { ok: false, code: "LINKEDIN_HUMAN_ONLY" };
  }
  return new Set<BrowserSiteAction>([
    "OPEN_SIGN_IN",
    "HUMAN_TAKEOVER",
    "VERIFY_AUTHENTICATION",
    "OWNER_CONFIRMED_SIGN_OUT",
    "FIXTURE_INPUT",
    "REQUEST_SECRET_FILL",
  ]).has(parsedAction.data)
    ? { ok: true }
    : { ok: false, code: "SITE_CAPABILITY_DENIED" };
}

const capabilitySchema = browserCommandSchema.options[0].shape.capability
  .or(browserCommandSchema.options[1].shape.capability)
  .or(browserCommandSchema.options[2].shape.capability)
  .or(browserCommandSchema.options[3].shape.capability)
  .or(browserCommandSchema.options[4].shape.capability)
  .or(browserCommandSchema.options[5].shape.capability)
  .or(browserCommandSchema.options[6].shape.capability)
  .or(browserCommandSchema.options[7].shape.capability);

export const commandCapabilityPolicySchema = z.strictObject({
  capability: capabilitySchema,
  approvalClass: z.enum(["AUTOMATIC", "OWNER_APPROVAL", "OWNER_ONLY"]),
  preconditions: z
    .array(
      z.enum(["ACTIVE_LEASE", "EXACT_SITE", "OWNED_FIXTURE", "OWNER_PRESENT"]),
    )
    .max(8),
  postconditions: z
    .array(
      z.enum(["NONE", "ORIGIN_MATCHES", "FACTS_BOUNDED", "RECEIPT_REQUIRED"]),
    )
    .max(8),
  budget: z.strictObject({
    maxArgumentBytes: z.number().int().positive().max(4096),
    maxCallsPerMinute: z.number().int().positive().max(600),
  }),
});

export const siteCommandPolicySchema = z.strictObject({
  site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
  allowedOrigins: z.array(canonicalOriginSchema).min(1).max(4),
  capabilities: z.array(commandCapabilityPolicySchema).min(1).max(16),
});

const allCapabilities = browserCommandSchema.options.map(
  (option) => option.shape.capability.value,
);
export const OWNED_FIXTURE_ORIGIN = "https://fixture.village.test" as const;

function capabilityPolicy(capability: (typeof allCapabilities)[number]) {
  const ownerOnly = capability === "REQUEST_SECRET_FILL";
  return {
    capability,
    approvalClass: ownerOnly ? "OWNER_ONLY" : "AUTOMATIC",
    preconditions: [
      "ACTIVE_LEASE",
      "EXACT_SITE",
      ...(capability === "FIXTURE_INPUT" || capability === "REQUEST_SECRET_FILL"
        ? (["OWNED_FIXTURE"] as const)
        : []),
    ],
    postconditions: [
      capability === "OBSERVE" ? "FACTS_BOUNDED" : "RECEIPT_REQUIRED",
    ],
    budget: { maxArgumentBytes: 512, maxCallsPerMinute: 120 },
  } as const;
}

const siteCommandPolicies = {
  OWNED_FIXTURE: siteCommandPolicySchema.parse({
    site: "OWNED_FIXTURE",
    allowedOrigins: [OWNED_FIXTURE_ORIGIN],
    capabilities: allCapabilities.map(capabilityPolicy),
  }),
  LINKEDIN: siteCommandPolicySchema.parse({
    site: "LINKEDIN",
    allowedOrigins: ["https://www.linkedin.com"],
    capabilities: allCapabilities.map(capabilityPolicy),
  }),
};

export function commandPolicyFor(site: Site) {
  return siteCommandPolicies[site];
}
export type SiteCommandAuthorization =
  | { ok: true }
  | {
      ok: false;
      code:
        | "SITE_CAPABILITY_DENIED"
        | "DESTINATION_SITE_MISMATCH"
        | "OWNER_APPROVAL_REQUIRED";
    };

export interface SiteCommandAuthorizationContext {
  ownerPresent?: boolean;
}

export function authorizeSiteCommand(
  site: Site,
  candidate: unknown,
  context: SiteCommandAuthorizationContext = {},
): SiteCommandAuthorization {
  const parsed = browserCommandSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  const command = parsed.data;
  if (site === "LINKEDIN") {
    return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  }
  const policy = commandPolicyFor(site);
  const capabilityPolicy = policy.capabilities.find(
    (entry) => entry.capability === command.capability,
  );
  if (!capabilityPolicy) {
    return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  }
  if (
    JSON.stringify(command).length > capabilityPolicy.budget.maxArgumentBytes
  ) {
    return { ok: false, code: "SITE_CAPABILITY_DENIED" };
  }
  if (capabilityPolicy.approvalClass !== "AUTOMATIC" && !context.ownerPresent) {
    return { ok: false, code: "OWNER_APPROVAL_REQUIRED" };
  }
  if (
    command.capability === "NAVIGATE" &&
    command.destination !== "FIXTURE_SIGN_IN"
  ) {
    return { ok: false, code: "DESTINATION_SITE_MISMATCH" };
  }
  if (command.capability === "SESSION_OPEN" && command.site !== site) {
    return { ok: false, code: "DESTINATION_SITE_MISMATCH" };
  }
  return { ok: true };
}
