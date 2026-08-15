import { describe, expect, it } from "vitest";
import {
  approveRitualDraft,
  RitualApprovalError,
  ritualApprovalRequestSchema,
  ritualDraftSchema,
} from "../index.js";

const draft = {
  schemaVersion: 1 as const,
  draftId: "rtd_01J00000000000000000000000",
  revision: 3,
  status: "DRAFT" as const,
  name: "Weekday pipeline review",
  purpose: "Review new opportunities and prepare a focused follow-up list.",
  trigger: {
    kind: "SCHEDULED" as const,
    summary: "Every weekday at 8:30 AM America/Chicago",
  },
  steps: [
    {
      stepKey: "gather-opportunities",
      title: "Gather current opportunities",
      description: "Collect the records changed since the previous Run.",
      actor: { kind: "STEWARD" as const, role: "Steward" },
      approval: "NONE" as const,
    },
    {
      stepKey: "review-shortlist",
      title: "Review the proposed shortlist",
      description: "Ask the owner before any external follow-up.",
      actor: { kind: "VILLAGER" as const, role: "Reviewer" },
      approval: "OWNER_REQUIRED" as const,
    },
  ],
  permissions: ["Read the connected opportunity source"],
  completion: "A reviewed shortlist is ready with evidence for every item.",
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  updatedAt: "2026-08-15T15:00:00.000Z",
};

describe("Ritual contracts", () => {
  it("accepts one strict, versioned draft without execution authority", () => {
    expect(ritualDraftSchema.parse(draft)).toEqual(draft);
    expect(
      ritualDraftSchema.safeParse({
        ...draft,
        rawPrompt: "silently send every message",
      }).success,
    ).toBe(false);
    expect(
      ritualDraftSchema.safeParse({
        ...draft,
        reviewPolicy: { ownerReview: "NEVER", learning: "AUTONOMOUS" },
      }).success,
    ).toBe(false);
  });

  it("approves only the exact displayed draft revision", () => {
    const request = ritualApprovalRequestSchema.parse({
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: 3,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });

    expect(approveRitualDraft(draft, request)).toMatchObject({
      status: "APPROVED",
      ritualId: request.ritualId,
      ritualRevision: 1,
      approvedDraftId: draft.draftId,
      approvedDraftRevision: 3,
    });
    expect(
      ritualApprovalRequestSchema.safeParse({
        ...request,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    try {
      approveRitualDraft(draft, { ...request, expectedRevision: 2 });
      throw new Error("expected stale approval to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RitualApprovalError);
      expect((error as RitualApprovalError).code).toBe("STALE_RITUAL_DRAFT");
    }
    try {
      approveRitualDraft(draft, {
        ...request,
        draftId: "rtd_01J00000000000000000000001",
      });
      throw new Error("expected mismatched draft to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RitualApprovalError);
      expect((error as RitualApprovalError).code).toBe(
        "RITUAL_DRAFT_ID_MISMATCH",
      );
    }
  });
});
