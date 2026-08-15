import { z } from "zod";
import {
  actionIdSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  effectIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  setupLogicalStepSchema,
  setupWorkflowKindSchema,
  setupWorkflowVersionSchema,
} from "./ids.js";
import { verificationStatusSchema } from "./browser.js";
import {
  browserObservationSchema,
  canonicalOriginSchema,
  predicateIdSchema,
  setupObservationSchema,
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

const setupCommandCapabilities = [
  "OBSERVE_SETUP",
  "REPLACE_DISPLAY_NAME",
  "SELECT_ROLE",
  "REPLACE_PREFERRED_FOCUS",
  "FINALIZE_SETUP",
  "VERIFY_SETUP",
] as const;

export const ownedFixtureSetupCommandSchema = z.discriminatedUnion(
  "capability",
  setupCommandCapabilities.map((capability) =>
    z.strictObject({ capability: z.literal(capability) }),
  ) as [
    z.ZodObject<{ capability: z.ZodLiteral<"OBSERVE_SETUP"> }>,
    z.ZodObject<{ capability: z.ZodLiteral<"REPLACE_DISPLAY_NAME"> }>,
    z.ZodObject<{ capability: z.ZodLiteral<"SELECT_ROLE"> }>,
    z.ZodObject<{ capability: z.ZodLiteral<"REPLACE_PREFERRED_FOCUS"> }>,
    z.ZodObject<{ capability: z.ZodLiteral<"FINALIZE_SETUP"> }>,
    z.ZodObject<{ capability: z.ZodLiteral<"VERIFY_SETUP"> }>,
  ],
);

export type OwnedFixtureSetupCommand = z.infer<
  typeof ownedFixtureSetupCommandSchema
>;

const setupStepCapabilities: Record<
  z.infer<typeof setupLogicalStepSchema>,
  ReadonlySet<OwnedFixtureSetupCommand["capability"]>
> = {
  SET_DISPLAY_NAME: new Set([
    "OBSERVE_SETUP",
    "REPLACE_DISPLAY_NAME",
    "VERIFY_SETUP",
  ]),
  SELECT_ROLE: new Set(["OBSERVE_SETUP", "SELECT_ROLE", "VERIFY_SETUP"]),
  SET_PREFERRED_FOCUS: new Set([
    "OBSERVE_SETUP",
    "REPLACE_PREFERRED_FOCUS",
    "VERIFY_SETUP",
  ]),
  FINALIZE_SETUP: new Set(["OBSERVE_SETUP", "FINALIZE_SETUP", "VERIFY_SETUP"]),
};

export function isSetupCommandAllowedForStep(
  logicalStep: z.infer<typeof setupLogicalStepSchema>,
  command: OwnedFixtureSetupCommand,
): boolean {
  return setupStepCapabilities[logicalStep].has(command.capability);
}

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

export const authenticationBrowserCommandSchema = z.discriminatedUnion(
  "capability",
  [
    sessionOpenCommandSchema,
    navigateCommandSchema,
    observeCommandSchema,
    secretFillCommandSchema,
    humanGateCommandSchema,
    checkpointCommandSchema,
    verifyCommandSchema,
  ],
);

export const browserCommandSchema = z.discriminatedUnion("capability", [
  ...authenticationBrowserCommandSchema.options,
  ...ownedFixtureSetupCommandSchema.options,
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

const setupWorkflowEnvelopeBinding = {
  workflowKind: setupWorkflowKindSchema,
  workflowVersion: setupWorkflowVersionSchema,
  jobRevision: z.number().int().positive(),
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
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

const setupSignedCommandEnvelopeSchema = boundedAuthenticatedEnvelope({
  ...setupWorkflowEnvelopeBinding,
  command: ownedFixtureSetupCommandSchema,
}).superRefine((envelope, context) => {
  if (!isSetupCommandAllowedForStep(envelope.logicalStep, envelope.command)) {
    context.addIssue({
      code: "custom",
      path: ["command"],
      message: "Setup command is not available for this logical step",
    });
  }
});

export const signedCommandEnvelopeSchema = z.union([
  boundedAuthenticatedEnvelope({ command: authenticationBrowserCommandSchema }),
  setupSignedCommandEnvelopeSchema,
]);

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

export const setupCommandResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ACCEPTED") }),
  z.strictObject({
    status: z.literal("REJECTED"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }),
  z.strictObject({ status: z.literal("WAITING_FOR_USER") }),
  z.strictObject({ status: z.literal("RECONCILIATION_REQUIRED") }),
  z.strictObject({
    status: z.literal("OBSERVATION"),
    observation: setupObservationSchema,
  }),
  z.strictObject({
    status: z.literal("VERIFICATION"),
    complete: z.boolean(),
    predicateVersion: predicateIdSchema,
  }),
]);

export const signedResultEnvelopeSchema = z.union([
  boundedAuthenticatedEnvelope({ result: commandResultSchema }),
  boundedAuthenticatedEnvelope({
    ...setupWorkflowEnvelopeBinding,
    result: setupCommandResultSchema,
  }),
]);

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
  "OWNED_FIXTURE_SETUP",
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
    "OWNED_FIXTURE_SETUP",
    "REQUEST_SECRET_FILL",
  ]).has(parsedAction.data)
    ? { ok: true }
    : { ok: false, code: "SITE_CAPABILITY_DENIED" };
}

const capabilitySchema = z.enum(
  browserCommandSchema.options.map(
    (option) => option.shape.capability.value,
  ) as [
    z.infer<typeof browserCommandSchema>["capability"],
    ...z.infer<typeof browserCommandSchema>["capability"][],
  ],
);

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
      ...(setupCommandCapabilities.includes(
        capability as (typeof setupCommandCapabilities)[number],
      ) || capability === "REQUEST_SECRET_FILL"
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
