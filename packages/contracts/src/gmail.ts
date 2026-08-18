import { z } from "zod";
import { instantSchema } from "./ids.js";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

const reportText = (maximum: number) =>
  boundedText(maximum).refine(
    (value) => !/(?:https?:\/\/|www\.)/i.test(value),
    {
      message: "Gmail priority reports must not contain URLs",
    },
  );

const emailAddressSchema = z.string().trim().email().max(320);

export const gmailOAuthScopeSchema = z.literal(
  "https://www.googleapis.com/auth/gmail.metadata",
);

export const gmailCredentialSnapshotSchema = z.discriminatedUnion("state", [
  z.strictObject({
    provider: z.literal("GMAIL"),
    state: z.literal("CONFIGURATION_REQUIRED"),
    reason: z.literal("OAUTH_CLIENT_ID_REQUIRED"),
  }),
  z.strictObject({
    provider: z.literal("GMAIL"),
    state: z.literal("DISCONNECTED"),
  }),
  z.strictObject({
    provider: z.literal("GMAIL"),
    state: z.literal("CONNECTED"),
    accountEmail: emailAddressSchema,
    version: z.number().int().positive(),
  }),
  z.strictObject({
    provider: z.literal("GMAIL"),
    state: z.literal("UNAVAILABLE"),
    reason: z.literal("CREDENTIAL_STORE_UNAVAILABLE"),
  }),
]);

export const gmailCredentialMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("snapshot"),
      snapshot: gmailCredentialSnapshotSchema,
    }),
    z.strictObject({
      status: z.literal("rejected"),
      reason: z.enum([
        "OAUTH_CANCELED",
        "OAUTH_CONNECT_IN_PROGRESS",
        "OAUTH_STATE_MISMATCH",
        "OAUTH_CALLBACK_INVALID",
        "TOKEN_EXCHANGE_FAILED",
        "CREDENTIAL_STORE_UNAVAILABLE",
        "PROVIDER_UNAVAILABLE",
      ]),
    }),
  ],
);

export const gmailMetadataReviewRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: z.literal("GMAIL"),
  scope: gmailOAuthScopeSchema,
  maxMessages: z.number().int().min(1).max(25),
  lookbackDays: z.number().int().min(1).max(7),
  unreadOnly: z.boolean(),
});

export const gmailMessageMetadataSchema = z.strictObject({
  messageNumber: z.number().int().min(1).max(25),
  from: boundedText(320),
  subject: boundedText(500),
  receivedAt: instantSchema,
  unread: z.boolean(),
  labelIds: z.array(boundedText(128)).max(32),
  taint: z.literal("UNTRUSTED_GMAIL_METADATA"),
});

export const gmailMetadataWaitingReasonSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_REQUEST_REJECTED",
  "CREDENTIAL_STORE_UNAVAILABLE",
  "MALFORMED_PROVIDER_OUTPUT",
  "TIME_BUDGET_EXHAUSTED",
]);

export const gmailMetadataReviewSuccessSchema = z
  .strictObject({
    status: z.literal("result"),
    provider: z.literal("GMAIL"),
    messages: z.array(gmailMessageMetadataSchema).max(25),
  })
  .superRefine((result, context) => {
    if (
      result.messages.some(
        (message, index) => message.messageNumber !== index + 1,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Gmail metadata must use contiguous local message numbers",
      });
    }
  });

export const gmailMetadataReviewResultSchema = z.discriminatedUnion("status", [
  gmailMetadataReviewSuccessSchema,
  z.strictObject({
    status: z.literal("waiting"),
    provider: z.literal("GMAIL"),
    reason: gmailMetadataWaitingReasonSchema,
  }),
]);

export const gmailPriorityReportItemSchema = z.strictObject({
  messageNumber: z.number().int().min(1).max(25),
  from: reportText(320),
  subject: reportText(500),
  receivedAt: instantSchema,
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]),
  reason: reportText(320),
  responseFocus: reportText(320),
  uncertainty: reportText(280).nullable(),
});

export const gmailPriorityReportSchema = z
  .strictObject({
    metadataOnly: z.literal(true),
    reviewedMessageCount: z.number().int().min(0).max(25),
    headline: reportText(160),
    summary: reportText(800),
    priorities: z.array(gmailPriorityReportItemSchema).max(10),
    uncertainties: z.array(reportText(280)).max(6),
  })
  .superRefine((report, context) => {
    const numbers = report.priorities.map((item) => item.messageNumber);
    if (new Set(numbers).size !== numbers.length) {
      context.addIssue({
        code: "custom",
        path: ["priorities"],
        message: "Priority report message references must be unique",
      });
    }
    if (numbers.some((number) => number > report.reviewedMessageCount)) {
      context.addIssue({
        code: "custom",
        path: ["priorities"],
        message: "Priority report references must match reviewed messages",
      });
    }
  });

export type GmailCredentialSnapshot = z.infer<
  typeof gmailCredentialSnapshotSchema
>;
export type GmailCredentialMutationResult = z.infer<
  typeof gmailCredentialMutationResultSchema
>;
export type GmailMetadataReviewRequest = z.infer<
  typeof gmailMetadataReviewRequestSchema
>;
export type GmailMessageMetadata = z.infer<typeof gmailMessageMetadataSchema>;
export type GmailMetadataWaitingReason = z.infer<
  typeof gmailMetadataWaitingReasonSchema
>;
export type GmailMetadataReviewResult = z.infer<
  typeof gmailMetadataReviewResultSchema
>;
export type GmailPriorityReport = z.infer<typeof gmailPriorityReportSchema>;
