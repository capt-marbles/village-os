import { z } from "zod";
import { instantSchema } from "./ids.js";

const domainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

const httpsSourceUrlSchema = z
  .string()
  .max(2_048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        context.addIssue({
          code: "custom",
          message: "Research sources require credential-free HTTPS URLs",
        });
      }
    } catch {
      context.addIssue({ code: "custom", message: "Invalid research URL" });
    }
  });

export const webResearchRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  query: z.string().trim().min(3).max(500),
  maxResults: z.number().int().min(1).max(10),
  publishedAfter: instantSchema.optional(),
  includeDomains: z.array(domainSchema).max(20).optional(),
});

export const webResearchSourceSchema = z.strictObject({
  title: z.string().trim().min(1).max(320),
  url: httpsSourceUrlSchema,
  publishedAt: instantSchema.nullable(),
  author: z.string().trim().min(1).max(160).nullable(),
  highlights: z.array(z.string().trim().min(1).max(2_000)).max(8),
  taint: z.literal("UNTRUSTED_WEB"),
});

export const webResearchWaitingReasonSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "CREDITS_EXHAUSTED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_REJECTED",
  "CREDENTIAL_STORE_UNAVAILABLE",
  "MALFORMED_PROVIDER_OUTPUT",
  "TIME_BUDGET_EXHAUSTED",
]);

export const webResearchSuccessSchema = z.strictObject({
  status: z.literal("result"),
  provider: z.literal("EXA"),
  requestId: z.string().trim().min(1).max(200),
  sources: z.array(webResearchSourceSchema).max(10),
});

export const webResearchResultSchema = z.discriminatedUnion("status", [
  webResearchSuccessSchema,
  z.strictObject({
    status: z.literal("waiting"),
    provider: z.literal("EXA"),
    reason: webResearchWaitingReasonSchema,
  }),
]);

export const exaCredentialSnapshotSchema = z.discriminatedUnion("state", [
  z.strictObject({
    provider: z.literal("EXA"),
    state: z.literal("CONFIGURATION_REQUIRED"),
  }),
  z.strictObject({
    provider: z.literal("EXA"),
    state: z.literal("CONFIGURED"),
    version: z.number().int().positive(),
  }),
  z.strictObject({
    provider: z.literal("EXA"),
    state: z.literal("UNAVAILABLE"),
    reason: z.literal("CREDENTIAL_STORE_UNAVAILABLE"),
  }),
]);

export const exaCredentialMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("snapshot"),
      snapshot: exaCredentialSnapshotSchema,
    }),
    z.strictObject({
      status: z.literal("rejected"),
      reason: z.enum([
        "INVALID_API_KEY",
        "CREDENTIAL_CHANGED",
        "CREDENTIAL_STORE_UNAVAILABLE",
      ]),
    }),
  ],
);

export type WebResearchRequest = z.infer<typeof webResearchRequestSchema>;
export type WebResearchSource = z.infer<typeof webResearchSourceSchema>;
export type WebResearchWaitingReason = z.infer<
  typeof webResearchWaitingReasonSchema
>;
export type WebResearchResult = z.infer<typeof webResearchResultSchema>;
export type ExaCredentialSnapshot = z.infer<typeof exaCredentialSnapshotSchema>;
export type ExaCredentialMutationResult = z.infer<
  typeof exaCredentialMutationResultSchema
>;
