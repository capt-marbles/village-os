import { z } from "zod";
import { actionPhaseSchema } from "./actions.js";
import { browserCommandSchema } from "./commands.js";
import {
  isSetupCommandAllowedForStep,
  ownedFixtureSetupCommandSchema,
} from "./commands.js";
import {
  browserSessionIdSchema,
  effectIdSchema,
  jobIdSchema,
  setupLogicalStepSchema,
  setupObjectiveSchema,
} from "./ids.js";
import { jobStateSchema } from "./jobs.js";
import {
  browserObservationSchema,
  setupObservationSchema,
} from "./redaction.js";

export const sanitizedModelContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobState: jobStateSchema,
  actionPhase: actionPhaseSchema,
  observation: browserObservationSchema,
  objective: z.string().trim().min(1).max(500).optional(),
});

const providerWorkflowBinding = {
  jobId: jobIdSchema,
  jobRevision: z.number().int().positive(),
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
  leaseEpoch: z.number().int().positive(),
};

export const setupModelProviderContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    objective: setupObjectiveSchema,
    browserSessionId: browserSessionIdSchema,
    ...providerWorkflowBinding,
    actionPhase: actionPhaseSchema,
    allowedActions: z.array(ownedFixtureSetupCommandSchema).min(1).max(6),
    completedSteps: z.array(setupLogicalStepSchema).max(4),
    observation: setupObservationSchema,
  })
  .superRefine((context, refinement) => {
    if (
      context.observation.logicalStep !== context.logicalStep ||
      context.observation.effectId !== context.effectId ||
      context.observation.workflowKind !== context.objective.kind ||
      context.observation.workflowVersion !== context.objective.version
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["observation"],
        message: "Observation must match the current durable workflow binding",
      });
    }
    if (
      new Set(context.completedSteps).size !== context.completedSteps.length
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["completedSteps"],
        message: "Completed logical steps must be unique",
      });
    }
    if (
      context.allowedActions.some(
        (action) => !isSetupCommandAllowedForStep(context.logicalStep, action),
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["allowedActions"],
        message: "Advertised actions must belong to the current logical step",
      });
    }
  });

export const setupModelProviderResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("action"),
    ...providerWorkflowBinding,
    command: ownedFixtureSetupCommandSchema,
  }),
  z.strictObject({
    status: z.literal("waiting"),
    ...providerWorkflowBinding,
    reason: z.enum([
      "AUTHENTICATION_REQUIRED",
      "PROVIDER_UNAVAILABLE",
      "MALFORMED_PROVIDER_OUTPUT",
      "HUMAN_GATE_REQUIRED",
      "NO_SAFE_ACTION",
      "SITE_POLICY_DENIED",
      "TURN_BUDGET_EXHAUSTED",
      "TIME_BUDGET_EXHAUSTED",
    ]),
  }),
]);

export function validateSetupModelProviderResult(
  contextCandidate: unknown,
  candidate: unknown,
):
  | z.infer<typeof setupModelProviderResultSchema>
  | {
      status: "waiting";
      reason: "MALFORMED_PROVIDER_OUTPUT" | "STALE_PROVIDER_RESULT";
    } {
  const parsedContext =
    setupModelProviderContextSchema.safeParse(contextCandidate);
  if (!parsedContext.success) {
    return { status: "waiting", reason: "MALFORMED_PROVIDER_OUTPUT" };
  }
  const context = parsedContext.data;
  const parsed = setupModelProviderResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return { status: "waiting", reason: "MALFORMED_PROVIDER_OUTPUT" };
  }
  const result = parsed.data;
  if (
    result.jobId !== context.jobId ||
    result.jobRevision !== context.jobRevision ||
    result.logicalStep !== context.logicalStep ||
    result.effectId !== context.effectId ||
    result.leaseEpoch !== context.leaseEpoch
  ) {
    return { status: "waiting", reason: "STALE_PROVIDER_RESULT" };
  }
  if (
    result.status === "action" &&
    (!isSetupCommandAllowedForStep(context.logicalStep, result.command) ||
      !context.allowedActions.some(
        (allowed) => allowed.capability === result.command.capability,
      ))
  ) {
    return { status: "waiting", reason: "MALFORMED_PROVIDER_OUTPUT" };
  }
  return result;
}

export const personalAgentTaskRequestSchema = z.strictObject({
  task: z.literal("CHECK_LINKEDIN_SIGN_IN"),
});

export const personalAgentTaskActivitySchema = z.strictObject({
  sequence: z.number().int().positive().max(10),
  stage: z.enum([
    "CLASSIFYING_BROWSER",
    "CONSULTING_CHATGPT",
    "VERIFYING_BROWSER",
    "WAITING_FOR_OWNER",
  ]),
});

export const personalAgentTaskResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("COMPLETED"),
    outcome: z.enum(["AUTHENTICATED", "NOT_AUTHENTICATED"]),
    evidence: z.enum(["LOCAL_PREDICATE", "OWNER_CONFIRMED"]),
  }),
  z.strictObject({
    state: z.literal("NEEDS_HUMAN"),
    reason: z.enum(["CHALLENGE", "ACCOUNT_CONFIRMATION", "UNKNOWN_STATE"]),
  }),
  z.strictObject({
    state: z.literal("BLOCKED"),
    reason: z.enum([
      "CHATGPT_AUTH_REQUIRED",
      "PROVIDER_UNAVAILABLE",
      "UNSUPPORTED_TASK",
      "SITE_POLICY_DENIED",
      "SENSITIVE_INPUT_DENIED",
      "TASK_IN_PROGRESS",
    ]),
  }),
]);

export const modelProviderResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("action"),
    command: browserCommandSchema,
  }),
  z.strictObject({
    status: z.literal("waiting"),
    reason: z.enum([
      "AUTHENTICATION_REQUIRED",
      "PROVIDER_UNAVAILABLE",
      "MALFORMED_PROVIDER_OUTPUT",
      "HUMAN_GATE_REQUIRED",
      "NO_SAFE_ACTION",
      "SITE_POLICY_DENIED",
    ]),
  }),
  z.strictObject({ status: z.literal("complete") }),
]);

export const modelProviderAccountSnapshotSchema = z.discriminatedUnion(
  "state",
  [
    z.strictObject({
      provider: z.literal("CHATGPT"),
      state: z.literal("CHECKING"),
    }),
    z.strictObject({
      provider: z.literal("CHATGPT"),
      state: z.literal("AUTHENTICATION_REQUIRED"),
    }),
    z.strictObject({
      provider: z.literal("CHATGPT"),
      state: z.literal("AUTHENTICATING"),
    }),
    z.strictObject({
      provider: z.literal("CHATGPT"),
      state: z.literal("AUTHENTICATED"),
      accountType: z.literal("chatgpt"),
    }),
    z.strictObject({
      provider: z.literal("CHATGPT"),
      state: z.literal("UNAVAILABLE"),
      errorCode: z.enum([
        "PROVIDER_UNAVAILABLE",
        "UNTRUSTED_AUTH_URL",
        "AUTH_BROWSER_UNAVAILABLE",
      ]),
    }),
  ],
);

export type SanitizedModelContext = z.infer<typeof sanitizedModelContextSchema>;
export type ModelProviderResult = z.infer<typeof modelProviderResultSchema>;
export type ModelProviderAccountSnapshot = z.infer<
  typeof modelProviderAccountSnapshotSchema
>;
export type PersonalAgentTaskRequest = z.infer<
  typeof personalAgentTaskRequestSchema
>;
export type PersonalAgentTaskActivity = z.infer<
  typeof personalAgentTaskActivitySchema
>;
export type PersonalAgentTaskResult = z.infer<
  typeof personalAgentTaskResultSchema
>;

export interface ModelProvider {
  readonly id: string;
  nextAction(context: SanitizedModelContext): Promise<ModelProviderResult>;
  close(): Promise<void>;
}

/** Provider responses are hostile input until this closed parser accepts them. */
export function parseModelProviderOutput(
  candidate: unknown,
): ModelProviderResult {
  if (typeof candidate !== "object" || candidate === null) {
    return { status: "waiting", reason: "MALFORMED_PROVIDER_OUTPUT" };
  }
  if ("status" in candidate) {
    const result = modelProviderResultSchema.safeParse(candidate);
    return result.success
      ? result.data
      : { status: "waiting", reason: "MALFORMED_PROVIDER_OUTPUT" };
  }
  const command = browserCommandSchema.safeParse(candidate);
  return command.success
    ? { status: "action", command: command.data }
    : { status: "waiting", reason: "MALFORMED_PROVIDER_OUTPUT" };
}
