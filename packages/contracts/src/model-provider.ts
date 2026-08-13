import { z } from "zod";
import { actionPhaseSchema } from "./actions.js";
import { browserCommandSchema } from "./commands.js";
import { jobStateSchema } from "./jobs.js";
import { browserObservationSchema } from "./redaction.js";

export const sanitizedModelContextSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobState: jobStateSchema,
  actionPhase: actionPhaseSchema,
  observation: browserObservationSchema,
  objective: z.string().trim().min(1).max(500).optional(),
});

export const personalAgentTaskRequestSchema = z.strictObject({
  task: z.literal("CHECK_LINKEDIN_SIGN_IN"),
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
