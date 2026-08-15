import { describe, expect, it } from "vitest";
import {
  createRitualBuilderState,
  reduceRitualBuilder,
} from "../ritual-builder-state.js";

const at = "2026-08-15T16:00:00.000Z";
const draftId = "rtd_01J00000000000000000000000";
const ritualId = "rtl_01J00000000000000000000000";

function applyStewardProposal(
  state:
    | ReturnType<typeof createRitualBuilderState>
    | ReturnType<typeof reduceRitualBuilder>,
  purpose = "Prepare a weekday pipeline review.",
) {
  const drafting = reduceRitualBuilder(state, {
    type: "SUBMIT_PURPOSE",
    draftId,
    purpose,
  });
  return reduceRitualBuilder(drafting, {
    type: "STEWARD_PROPOSED",
    occurredAt: "2026-08-15T16:00:10.000Z",
    proposal: {
      status: "proposal",
      draftId,
      requestRevision: 1,
      stewardMessage: "I shaped a focused draft. When should it begin?",
      name: "Pipeline review",
      purpose,
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather the bounded information needed for the review.",
          actor: { kind: "STEWARD", role: "Steward" },
          approval: "OWNER_REQUIRED",
        },
      ],
      permissions: ["Read only connected pipeline records"],
      completion: "A reviewable follow-up list is ready.",
    },
  });
}

describe("Ritual Builder state", () => {
  it("builds one revisioned draft through focused Steward questions", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Review my sales pipeline and prepare the next follow-ups.",
    });
    expect(state.phase).toBe("DRAFTING");
    state = reduceRitualBuilder(state, {
      type: "STEWARD_PROPOSED",
      occurredAt: "2026-08-15T16:00:10.000Z",
      proposal: {
        status: "proposal",
        draftId,
        requestRevision: 1,
        stewardMessage: "I shaped a focused draft. When should it begin?",
        name: "Pipeline follow-up review",
        purpose: "Review my sales pipeline and prepare the next follow-ups.",
        steps: [
          {
            stepKey: "prepare-review",
            title: "Prepare the review",
            description:
              "Gather the bounded information needed for the review.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "OWNER_REQUIRED",
          },
        ],
        permissions: ["Read only connected pipeline records"],
        completion: "A reviewable follow-up list is ready.",
      },
    });
    expect(state.phase).toBe("CHOOSE_TRIGGER");
    expect(state.draft).toMatchObject({ revision: 1, status: "DRAFT" });
    expect(state.messages.at(-1)?.speaker).toBe("STEWARD");

    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "WEEKDAYS",
      timeZone: "Europe/London",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    expect(state.phase).toBe("CHOOSE_REVIEW");
    expect(state.draft?.revision).toBe(2);
    expect(state.draft?.trigger.kind).toBe("SCHEDULED");
    expect(state.draft?.trigger.summary).toContain("Europe/London");

    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    expect(state.phase).toBe("READY_FOR_APPROVAL");
    expect(state.draft?.revision).toBe(3);
    expect(state.draft?.reviewPolicy.learning).toBe("PROPOSE_ONLY");
  });

  it("restores an approved Ritual without exposing a Run action", () => {
    const approved = {
      schemaVersion: 1 as const,
      ritualId,
      ritualRevision: 1 as const,
      status: "APPROVED" as const,
      approvedDraftId: draftId,
      approvedDraftRevision: 3,
      name: "Pipeline review",
      purpose: "Prepare a weekday pipeline review.",
      trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather the bounded information needed for the review.",
          actor: { kind: "STEWARD" as const, role: "Steward" },
          approval: "OWNER_REQUIRED" as const,
        },
      ],
      permissions: ["Read only connected records"],
      completion: "A reviewable result is ready.",
      reviewPolicy: {
        ownerReview: "EVERY_RUN" as const,
        learning: "PROPOSE_ONLY" as const,
      },
      approvedAt: "2026-08-15T16:03:00.000Z",
    };
    const state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "RESTORE_APPROVED",
      approved,
    });
    expect(state).toMatchObject({ phase: "APPROVED", approved });
    expect(JSON.stringify(state)).not.toContain("RUN_RITUAL");
  });

  it("returns an approved Ritual to a clean purpose prompt for another Ritual", () => {
    const approved = {
      schemaVersion: 1 as const,
      ritualId,
      ritualRevision: 1 as const,
      status: "APPROVED" as const,
      approvedDraftId: draftId,
      approvedDraftRevision: 3,
      name: "Pipeline review",
      purpose: "Prepare a weekday pipeline review.",
      trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather the bounded information needed for the review.",
          actor: { kind: "STEWARD" as const, role: "Steward" },
          approval: "OWNER_REQUIRED" as const,
        },
      ],
      permissions: ["Read only connected records"],
      completion: "A reviewable result is ready.",
      reviewPolicy: {
        ownerReview: "EVERY_RUN" as const,
        learning: "PROPOSE_ONLY" as const,
      },
      approvedAt: "2026-08-15T16:03:00.000Z",
    };
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "RESTORE_APPROVED",
      approved,
    });

    state = reduceRitualBuilder(state, { type: "START_NEW_RITUAL" });
    expect(state.phase).toBe("STARTING_NEW_RITUAL");
    state = reduceRitualBuilder(state, { type: "NEW_RITUAL_READY" });

    expect(state).toMatchObject({
      phase: "DESCRIBE_PURPOSE",
      draft: null,
      approved: null,
      requestRevision: 0,
    });
    expect(state.messages[0]?.text).toContain("Pipeline review remains saved");
    expect(state.messages.at(-1)?.speaker).toBe("STEWARD");
  });

  it("returns a failed local save to the exact draft for retry", () => {
    let state = applyStewardProposal(createRitualBuilderState());
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "APPROVE",
      ritualId,
      expectedRevision: 3,
      occurredAt: "2026-08-15T16:03:00.000Z",
    });
    state = reduceRitualBuilder(state, { type: "APPROVAL_SAVE_FAILED" });
    expect(state).toMatchObject({
      phase: "READY_FOR_APPROVAL",
      approved: null,
      draft: { revision: 3 },
    });
    expect(state.error).toBeNull();
    expect(state.messages.at(-1)?.text).toContain("saved locally");
  });

  it("increments Steward request revisions across retries", () => {
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a weekday pipeline review.",
    });
    expect(state).toMatchObject({
      phase: "DRAFTING",
      pendingRequestRevision: 1,
    });

    state = reduceRitualBuilder(state, {
      type: "STEWARD_FAILED",
      message: "The Steward could not shape the draft. Try again.",
    });
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a weekday pipeline review.",
    });
    expect(state).toMatchObject({
      phase: "DRAFTING",
      pendingRequestRevision: 2,
    });
  });

  it("returns rejected Steward output to a retryable purpose form", () => {
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a weekday pipeline review.",
    });
    state = reduceRitualBuilder(state, {
      type: "STEWARD_PROPOSED",
      occurredAt: at,
      proposal: {
        status: "proposal",
        draftId,
        requestRevision: 99,
        stewardMessage: "Outdated result",
        name: "Pipeline review",
        purpose: "Prepare a weekday pipeline review.",
        steps: [],
        permissions: [],
        completion: "A review is ready.",
      },
    });

    expect(state.phase).toBe("DESCRIBE_PURPOSE");
    expect(state.error).toContain("outdated");
  });

  it("increments direct edits and rejects approval of a stale displayed revision", () => {
    let state = applyStewardProposal(createRitualBuilderState());
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:00:30.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:00:45.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "EDIT_FIELD",
      field: "name",
      value: "Morning pipeline briefing",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    expect(state.draft?.revision).toBe(4);

    state = reduceRitualBuilder(state, {
      type: "APPROVE",
      ritualId,
      expectedRevision: 3,
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    expect(state.phase).not.toBe("APPROVED");
    expect(state.error).toContain("changed");
  });

  it("approves the exact draft without starting a Run", () => {
    let state = applyStewardProposal(createRitualBuilderState());
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EXCEPTIONS_ONLY",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "APPROVE",
      ritualId,
      expectedRevision: 3,
      occurredAt: "2026-08-15T16:03:00.000Z",
    });
    expect(state.phase).toBe("SAVING_APPROVAL");
    state = reduceRitualBuilder(state, { type: "APPROVAL_SAVED" });

    expect(state.phase).toBe("APPROVED");
    expect(state.approved).toMatchObject({
      status: "APPROVED",
      approvedDraftRevision: 3,
    });
    expect(state.messages.at(-1)?.text).toContain("No Run has started");
  });

  it("runs an approved Ritual only after sample review and presents a Receipt", () => {
    let state = applyStewardProposal(createRitualBuilderState());
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "APPROVE",
      ritualId,
      expectedRevision: 3,
      occurredAt: "2026-08-15T16:03:00.000Z",
    });
    state = reduceRitualBuilder(state, { type: "APPROVAL_SAVED" });
    state = reduceRitualBuilder(state, { type: "START_TEST" });
    expect(state.phase).toBe("PREPARING_TEST");

    const unchanged = reduceRitualBuilder(state, {
      type: "SUBMIT_TEST_SAMPLE",
      sample: "   ",
    });
    expect(unchanged.phase).toBe("PREPARING_TEST");
    expect(unchanged.error).toContain("sample");

    const tooShort = reduceRitualBuilder(state, {
      type: "SUBMIT_TEST_SAMPLE",
      sample: "Too short",
    });
    expect(tooShort.phase).toBe("PREPARING_TEST");
    expect(tooShort.error).toContain("16 characters");

    state = reduceRitualBuilder(state, {
      type: "SUBMIT_TEST_SAMPLE",
      sample: "Customer A needs an answer before Friday.",
    });
    expect(state.phase).toBe("RUNNING_TEST");
    state = reduceRitualBuilder(state, {
      type: "TEST_RUN_RECEIPT",
      receipt: {
        schemaVersion: 1,
        receiptId: "rcp_01J00000000000000000000000",
        runId: "rrn_01J00000000000000000000000",
        ritualId,
        ritualRevision: 1,
        mode: "TEST",
        outcome: "NEEDS_REVIEW",
        summary: "Customer A should receive the first response.",
        evidence: ["The supplied deadline is Friday."],
        uncertainties: ["Commercial impact was not supplied."],
        sampleDigest: "a".repeat(64),
        sampleCharacterCount: 42,
        externalEffects: [],
        recordedAt: "2026-08-15T18:03:00.000Z",
      },
    });
    expect(state).toMatchObject({
      phase: "REVIEW_TEST",
      receipt: { outcome: "NEEDS_REVIEW", externalEffects: [] },
    });
    expect(JSON.stringify(state)).not.toContain(
      "Customer A needs an answer before Friday.",
    );
  });

  it("ignores replayed decisions outside their exact phase", () => {
    let state = applyStewardProposal(createRitualBuilderState());
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "WEEKDAYS",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    const afterTrigger = state;

    expect(
      reduceRitualBuilder(state, {
        type: "SELECT_TRIGGER",
        trigger: "EVENT",
        timeZone: "America/Chicago",
        occurredAt: "2026-08-15T16:01:30.000Z",
      }),
    ).toBe(afterTrigger);
    expect(
      reduceRitualBuilder(state, {
        type: "SUBMIT_PURPOSE",
        draftId,
        purpose: "Replace the original purpose.",
      }),
    ).toBe(afterTrigger);
    if (state.phase !== "CHOOSE_REVIEW") throw new Error("unexpected phase");
    expect(state.draft.revision).toBe(2);
  });

  it("reports bounded input errors without throwing or changing the draft", () => {
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "x".repeat(321),
    });
    expect(state.phase).toBe("DESCRIBE_PURPOSE");
    expect(state.error).toContain("320");

    state = applyStewardProposal(
      createRitualBuilderState(),
      "Prepare a pipeline review.",
    );
    const beforeEdit = state.draft;
    state = reduceRitualBuilder(state, {
      type: "EDIT_FIELD",
      field: "name",
      value: "x".repeat(81),
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    expect(state.draft).toBe(beforeEdit);
    expect(state.error).toContain("80");
  });

  it("fails closed for malformed prototype identities", () => {
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId: "not-a-draft-id",
      purpose: "Prepare a pipeline review.",
    });
    expect(state.phase).toBe("DESCRIBE_PURPOSE");
    expect(state.error).toContain("not valid");

    state = applyStewardProposal(
      createRitualBuilderState(),
      "Prepare a pipeline review.",
    );
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "APPROVE",
      ritualId: "not-a-ritual-id",
      expectedRevision: 3,
      occurredAt: "2026-08-15T16:03:00.000Z",
    });
    expect(state.phase).toBe("READY_FOR_APPROVAL");
    expect(state.error).toContain("identity is not valid");
  });
});
