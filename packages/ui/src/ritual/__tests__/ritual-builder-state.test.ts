import { describe, expect, it } from "vitest";
import {
  createRitualBuilderState,
  reduceRitualBuilder,
} from "../ritual-builder-state.js";

const at = "2026-08-15T16:00:00.000Z";
const draftId = "rtd_01J00000000000000000000000";
const ritualId = "rtl_01J00000000000000000000000";

describe("Ritual Builder state", () => {
  it("builds one revisioned draft through focused Steward questions", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Review my sales pipeline and prepare the next follow-ups.",
      occurredAt: at,
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

  it("increments direct edits and rejects approval of a stale displayed revision", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a weekday pipeline review.",
      occurredAt: at,
    });
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
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a weekday pipeline review.",
      occurredAt: at,
    });
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

    expect(state.phase).toBe("APPROVED");
    expect(state.approved).toMatchObject({
      status: "APPROVED",
      approvedDraftRevision: 3,
    });
    expect(state.messages.at(-1)?.text).toContain("No Run has started");
  });

  it("ignores replayed decisions outside their exact phase", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a weekday pipeline review.",
      occurredAt: at,
    });
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
        occurredAt: "2026-08-15T16:01:30.000Z",
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
      occurredAt: at,
    });
    expect(state.phase).toBe("DESCRIBE_PURPOSE");
    expect(state.error).toContain("320");

    state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a pipeline review.",
      occurredAt: at,
    });
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
      occurredAt: at,
    });
    expect(state.phase).toBe("DESCRIBE_PURPOSE");
    expect(state.error).toContain("not valid");

    state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Prepare a pipeline review.",
      occurredAt: at,
    });
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
