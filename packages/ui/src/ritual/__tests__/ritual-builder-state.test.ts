import { describe, expect, it } from "vitest";
import {
  createRitualBuilderState,
  reduceRitualBuilder,
} from "../ritual-builder-state.js";

const at = "2026-08-15T16:00:00.000Z";

describe("Ritual Builder state", () => {
  it("builds one revisioned draft through focused Steward questions", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      purpose: "Review my sales pipeline and prepare the next follow-ups.",
      occurredAt: at,
    });
    expect(state.phase).toBe("CHOOSE_TRIGGER");
    expect(state.draft).toMatchObject({ revision: 1, status: "DRAFT" });
    expect(state.messages.at(-1)?.speaker).toBe("STEWARD");

    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "WEEKDAYS",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    expect(state.phase).toBe("CHOOSE_REVIEW");
    expect(state.draft?.revision).toBe(2);
    expect(state.draft?.trigger.kind).toBe("SCHEDULED");

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
      purpose: "Prepare a weekday pipeline review.",
      occurredAt: at,
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
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
      purpose: "Prepare a weekday pipeline review.",
      occurredAt: at,
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "ON_DEMAND",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EXCEPTIONS_ONLY",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "APPROVE",
      expectedRevision: 3,
      occurredAt: "2026-08-15T16:03:00.000Z",
    });

    expect(state.phase).toBe("APPROVED");
    expect(state.approved).toMatchObject({
      status: "APPROVED",
      approvedDraftRevision: 3,
    });
    expect(state.runState).toBe("NOT_STARTED");
  });
});
