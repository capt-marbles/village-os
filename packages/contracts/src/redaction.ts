import { z } from "zod";

export const observationContractStatus =
  "PROVISIONAL_UNTIL_U7_BENCHMARK" as const;

export const canonicalOriginSchema = z
  .string()
  .max(255)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Expected an exact HTTPS origin without path, query, fragment, or credentials");

export const predicateIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

export const observationFactSchema = z.discriminatedUnion("id", [
  z.strictObject({
    id: z.literal("AUTH_STATE"),
    value: z.enum(["SIGNED_OUT", "POSSIBLY_AUTHENTICATED", "UNKNOWN"]),
  }),
  z.strictObject({
    id: z.literal("HUMAN_GATE"),
    value: z.enum([
      "NONE",
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
  }),
  z.strictObject({
    id: z.literal("ACTION_POSTCONDITION"),
    value: z.enum(["SATISFIED", "NOT_SATISFIED", "UNKNOWN"]),
  }),
  z.strictObject({
    id: z.literal("VISIBLE_APPROVED_FIELD_COUNT"),
    value: z.number().int().nonnegative().max(64),
  }),
  z.strictObject({
    id: z.literal("APPROVED_ACTION_AVAILABLE"),
    value: z.boolean(),
  }),
]);

export const browserObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.literal("BROWSER_UNTRUSTED"),
    canonicalOrigin: canonicalOriginSchema,
    predicateIds: z.array(predicateIdSchema).max(16),
    facts: z.array(observationFactSchema).max(16),
  })
  .superRefine((observation, context) => {
    const ids = observation.facts.map((fact) => fact.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["facts"],
        message: "Observation fact identifiers must be unique",
      });
    }
  });

export const browserTaintPolicySchema = z.strictObject({
  source: z.literal("BROWSER_UNTRUSTED"),
  mayGrantAuthority: z.literal(false),
  mayWidenDestinations: z.literal(false),
  mayApproveSecrets: z.literal(false),
  mayAlterPolicy: z.literal(false),
  rawPageContentMayLeaveHost: z.literal(false),
});

export const browserTaintPolicy = browserTaintPolicySchema.parse({
  source: "BROWSER_UNTRUSTED",
  mayGrantAuthority: false,
  mayWidenDestinations: false,
  mayApproveSecrets: false,
  mayAlterPolicy: false,
  rawPageContentMayLeaveHost: false,
});

export type BrowserObservation = z.infer<typeof browserObservationSchema>;

export function serializeBrowserObservation(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new Error("INVALID_BROWSER_OBSERVATION");
  }
  const record = input as Record<string, unknown>;
  const observation = browserObservationSchema.parse({
    schemaVersion: record.schemaVersion,
    source: record.source,
    canonicalOrigin: record.canonicalOrigin,
    predicateIds: record.predicateIds,
    facts: record.facts,
  });
  return JSON.stringify(observation);
}
