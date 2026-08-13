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
});

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
