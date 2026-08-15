import { describe, expect, it } from "vitest";
import {
  approveRitualDraft,
  RitualApprovalError,
  ritualApprovalRequestSchema,
  ritualDraftSchema,
  ritualStewardContextSchema,
  ritualStewardProposalSchema,
  ritualTestRunRequestSchema,
  ritualTestRunResultSchema,
  createRitualTestReceipt,
  validateRitualStewardResult,
  validateRitualTestRunResult,
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
  it("keeps the Steward drafting boundary bounded and rejects stale proposals", () => {
    const context = ritualStewardContextSchema.parse({
      schemaVersion: 1,
      draftId: draft.draftId,
      requestRevision: 1,
      ownerPurpose: "Review my sales pipeline and prepare the next follow-ups.",
    });
    const proposal = ritualStewardProposalSchema.parse({
      status: "proposal",
      draftId: draft.draftId,
      requestRevision: 1,
      stewardMessage: "I have shaped a focused draft for you to review.",
      name: "Pipeline follow-up review",
      purpose: context.ownerPurpose,
      steps: draft.steps,
      permissions: draft.permissions,
      completion: draft.completion,
    });

    expect(validateRitualStewardResult(context, proposal)).toEqual(proposal);
    expect(
      validateRitualStewardResult(context, {
        ...proposal,
        requestRevision: 2,
      }),
    ).toMatchObject({ status: "waiting", reason: "STALE_STEWARD_RESULT" });
    expect(
      ritualStewardContextSchema.safeParse({
        ...context,
        rawPageContent: "must never cross the provider boundary",
      }).success,
    ).toBe(false);
  });

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

  it("binds a sample-only Test Run Receipt to the exact approved Ritual", () => {
    const approved = approveRitualDraft(draft, {
      schemaVersion: 1,
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      ritualId: "rtl_01J00000000000000000000000",
      approvedAt: "2026-08-15T15:01:00.000Z",
    });
    const request = ritualTestRunRequestSchema.parse({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      sample: "Customer A needs an answer before Friday.",
    });
    const result = ritualTestRunResultSchema.parse({
      status: "result",
      runId: "rrn_01J00000000000000000000000",
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      summary: "Customer A is the highest-priority response.",
      evidence: ["The supplied deadline is Friday."],
      uncertainties: ["The commercial impact was not supplied."],
    });
    if (result.status !== "result") throw new Error("expected test result");

    const receipt = createRitualTestReceipt({
      approved,
      request,
      result,
      receiptId: "rcp_01J00000000000000000000000",
      sampleDigest: "a".repeat(64),
      recordedAt: "2026-08-15T15:02:00.000Z",
    });

    expect(receipt).toMatchObject({
      mode: "TEST",
      outcome: "NEEDS_REVIEW",
      externalEffects: [],
      sampleCharacterCount: request.sample.length,
    });
    expect(JSON.stringify(receipt)).not.toContain(request.sample);
    expect(
      ritualTestRunRequestSchema.safeParse({
        ...request,
        rawCredentials: "must not cross the boundary",
      }).success,
    ).toBe(false);
    expect(() =>
      createRitualTestReceipt({
        approved,
        request,
        result: { ...result, ritualRevision: 2 },
        receiptId: "rcp_01J00000000000000000000000",
        sampleDigest: "a".repeat(64),
        recordedAt: "2026-08-15T15:02:00.000Z",
      }),
    ).toThrow("STALE_RITUAL_TEST_RUN");

    expect(
      ritualTestRunResultSchema.safeParse({
        ...result,
        evidence: [],
        uncertainties: [],
      }).success,
    ).toBe(false);

    expect(
      validateRitualTestRunResult(
        {
          schemaVersion: 1,
          runId: result.runId,
          ritual: approved,
          sample: request.sample,
        },
        {
          ...result,
          summary: `Highest priority: ${request.sample}`,
        },
      ),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });

    const shortSample = "Deadline is Friday";
    expect(
      validateRitualTestRunResult(
        {
          schemaVersion: 1,
          runId: result.runId,
          ritual: approved,
          sample: shortSample,
        },
        {
          ...result,
          summary: `Highest priority: ${shortSample}`,
        },
      ),
    ).toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });
});
