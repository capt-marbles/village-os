import { z } from "zod";

export const observationContractStatus =
  "PROVISIONAL_UNTIL_U7_BENCHMARK" as const;

const boundedKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,63}$/);
const boundedStateSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

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

export const browserObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.literal("BROWSER_UNTRUSTED"),
    canonicalOrigin: canonicalOriginSchema,
    predicateIds: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(16),
    flags: z.record(boundedKeySchema, z.boolean()),
    states: z.record(boundedKeySchema, boundedStateSchema),
    counts: z.record(
      boundedKeySchema,
      z.number().int().nonnegative().max(10_000),
    ),
  })
  .superRefine((observation, context) => {
    for (const [name, values] of [
      ["flags", observation.flags],
      ["states", observation.states],
      ["counts", observation.counts],
    ] as const) {
      if (Object.keys(values).length > 32) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} exceeds 32 facts`,
        });
      }
    }
  });

export type BrowserObservation = z.infer<typeof browserObservationSchema>;
