import { describe, expect, it } from "vitest";
import {
  gmailCredentialSnapshotSchema,
  gmailMetadataReviewRequestSchema,
  gmailMetadataReviewResultSchema,
  gmailOAuthScopeSchema,
  gmailPriorityReportSchema,
} from "../index.js";

describe("Gmail contracts", () => {
  it("pins the least-privilege metadata scope and bounded inbox review", () => {
    expect(
      gmailOAuthScopeSchema.parse(
        "https://www.googleapis.com/auth/gmail.metadata",
      ),
    ).toBe("https://www.googleapis.com/auth/gmail.metadata");
    expect(
      gmailMetadataReviewRequestSchema.parse({
        schemaVersion: 1,
        provider: "GMAIL",
        scope: "https://www.googleapis.com/auth/gmail.metadata",
        maxMessages: 25,
        lookbackDays: 7,
        unreadOnly: true,
      }),
    ).toMatchObject({ maxMessages: 25, lookbackDays: 7 });
    expect(
      gmailMetadataReviewRequestSchema.safeParse({
        schemaVersion: 1,
        provider: "GMAIL",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        maxMessages: 26,
        lookbackDays: 8,
        unreadOnly: true,
      }).success,
    ).toBe(false);
  });

  it("accepts headers-only evidence and rejects bodies, snippets, and URLs", () => {
    const result = {
      status: "result" as const,
      provider: "GMAIL" as const,
      messages: [
        {
          messageNumber: 1,
          from: "Customer <customer@example.com>",
          subject: "Renewal decision needed",
          receivedAt: "2026-08-17T11:00:00.000Z",
          unread: true,
          labelIds: ["INBOX", "UNREAD"],
          taint: "UNTRUSTED_GMAIL_METADATA" as const,
        },
      ],
    };
    expect(gmailMetadataReviewResultSchema.parse(result)).toEqual(result);
    expect(
      gmailMetadataReviewResultSchema.safeParse({
        ...result,
        messages: [{ ...result.messages[0], snippet: "Private body text" }],
      }).success,
    ).toBe(false);
    expect(
      gmailPriorityReportSchema.safeParse({
        metadataOnly: true,
        reviewedMessageCount: 1,
        headline: "One response looks urgent",
        summary: "Review https://mail.google.com now.",
        priorities: [],
        uncertainties: [],
      }).success,
    ).toBe(false);
    expect(
      gmailPriorityReportSchema.parse({
        metadataOnly: true,
        reviewedMessageCount: 1,
        headline: "One response likely needs attention",
        summary: "A recent unread renewal message appears time-sensitive.",
        priorities: [
          {
            messageNumber: 1,
            from: "Customer",
            subject: "Renewal decision needed",
            receivedAt: "2026-08-17T11:00:00.000Z",
            priority: "HIGH",
            reason: "The subject indicates a pending commercial decision.",
            responseFocus: "Confirm the decision owner and expected timing.",
            uncertainty:
              "The body was not read, so the exact request is unknown.",
          },
        ],
        uncertainties: ["No message bodies or attachments were read."],
      }).priorities[0],
    ).toMatchObject({ priority: "HIGH", messageNumber: 1 });
  });

  it("keeps renderer-visible credential state secret-free", () => {
    expect(
      gmailCredentialSnapshotSchema.parse({
        provider: "GMAIL",
        state: "CONNECTED",
        accountEmail: "owner@example.com",
        version: 2,
      }),
    ).toMatchObject({ state: "CONNECTED", version: 2 });
    expect(
      gmailCredentialSnapshotSchema.safeParse({
        provider: "GMAIL",
        state: "CONNECTED",
        accountEmail: "owner@example.com",
        version: 2,
        refreshToken: "secret",
      }).success,
    ).toBe(false);
  });
});
