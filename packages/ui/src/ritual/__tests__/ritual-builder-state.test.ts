import { describe, expect, it } from "vitest";
import {
  createRitualRun,
  createRitualRunReceipt,
  reduceRitualRun,
} from "@village/contracts";
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
  it("restores a pending learning proposal for Review", () => {
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "HYDRATE_APPROVED_REVISION",
      approved: {
        schemaVersion: 1,
        ritualId,
        ritualRevision: 1,
        status: "APPROVED",
        approvedDraftId: draftId,
        approvedDraftRevision: 3,
        name: "Pipeline review",
        purpose: "Prepare a weekday pipeline review.",
        trigger: { kind: "ON_DEMAND", summary: "Whenever I ask" },
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
        reviewPolicy: {
          ownerReview: "EVERY_RUN",
          learning: "PROPOSE_ONLY",
        },
        approvedAt: at,
      },
    });
    const approved = state.phase === "APPROVED" ? state.approved : null;
    if (!approved) throw new Error("expected restored approval");
    const receipt = {
      schemaVersion: 1 as const,
      receiptId: "rcp_01J00000000000000000000000",
      runId: "rrn_01J00000000000000000000000",
      ritualId,
      ritualRevision: 1,
      mode: "TEST" as const,
      outcome: "NEEDS_REVIEW" as const,
      summary: "The review found one priority.",
      evidence: ["The supplied deadline is Friday."],
      uncertainties: [],
      sampleDigest: "a".repeat(64),
      sampleCharacterCount: 42,
      externalEffects: [] as [],
      recordedAt: "2026-08-17T13:00:00.000Z",
    };
    const proposal = {
      status: "proposal" as const,
      proposalId: "rlp_01J00000000000000000000000",
      ritualId,
      fromRevision: 1,
      receiptId: receipt.receiptId,
      ownerFeedback: "Keep the next result to three concise bullets.",
      stewardMessage: "I propose a more concise expected result.",
      rationale: "The owner requested a shorter review.",
      proposedDefinition: {
        name: approved.name,
        purpose: approved.purpose,
        trigger: approved.trigger,
        steps: approved.steps,
        permissions: approved.permissions,
        completion: "Three concise bullets are ready for review.",
        reviewPolicy: approved.reviewPolicy,
      },
    };

    state = reduceRitualBuilder(state, {
      type: "RESTORE_LEARNING_REVIEW",
      review: { kind: "TEST", proposal, receipt },
    });

    expect(state).toMatchObject({
      phase: "REVIEW_LEARNING",
      approved,
      source: { kind: "TEST", receipt },
      proposal,
    });
  });

  it("answers one Steward clarification before creating the draft", () => {
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_PURPOSE",
      draftId,
      purpose: "Review my email and identify the highest priority reply.",
    });
    state = reduceRitualBuilder(state, {
      type: "STEWARD_ASKED",
      question: {
        status: "question",
        draftId,
        requestRevision: 1,
        stewardMessage: "One choice will make this Ritual more useful.",
        questionId: "delivery-rhythm",
        prompt: "When should I prepare the review?",
        options: [
          {
            optionId: "on-demand",
            label: "Only when I ask",
            detail: "Keep it manual while it learns.",
          },
          {
            optionId: "weekdays",
            label: "Every weekday",
            detail: "Prepare it each weekday morning.",
          },
        ],
        allowFreeText: true,
      },
    });
    expect(state.phase).toBe("CLARIFYING");

    state = reduceRitualBuilder(state, {
      type: "ANSWER_CLARIFICATION",
      questionId: "delivery-rhythm",
      selection: { kind: "OPTION", optionId: "weekdays" },
    });
    expect(state).toMatchObject({
      phase: "DRAFTING",
      pendingRequestRevision: 2,
      clarifications: [
        { questionId: "delivery-rhythm", answer: "Every weekday" },
      ],
    });
    expect(state.messages.at(-2)?.text).toBe("Every weekday");
  });

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

  it("restores an approved Ritual ready for an explicit Run", () => {
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
      type: "HYDRATE_APPROVED_REVISION",
      approved,
    });
    expect(state).toMatchObject({ phase: "APPROVED", approved });
    expect(JSON.stringify(state)).not.toContain("RUNNING_RITUAL");
  });

  it("presents durable Run progress, an owner gate, and a Run Receipt", () => {
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
          description: "Gather bounded fixture data for the review.",
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
      type: "HYDRATE_APPROVED_REVISION",
      approved,
    });
    state = reduceRitualBuilder(state, { type: "START_RUN" });
    expect(state.phase).toBe("STARTING_RUN");

    let run = createRitualRun({
      approved,
      request: {
        schemaVersion: 1,
        ritualId,
        ritualRevision: 1,
      },
      runId: "rrn_01J00000000000000000000001",
      createdAt: "2026-08-16T12:00:00.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "START",
      occurredAt: "2026-08-16T12:00:01.000Z",
    });
    state = reduceRitualBuilder(state, { type: "RUN_UPDATED", run });
    expect(state).toMatchObject({
      phase: "RUN_WAITING_FOR_OWNER",
      run: { currentStepKey: "prepare-review" },
    });

    state = reduceRitualBuilder(state, { type: "APPROVE_RUN_STEP" });
    expect(state.phase).toBe("RUN_WAITING_FOR_OWNER");
    state = reduceRitualBuilder(state, {
      type: "RUN_COMMAND_FAILED",
      message: "The approval was not recorded.",
    });
    expect(state).toMatchObject({
      phase: "RUN_WAITING_FOR_OWNER",
      error: "The approval was not recorded.",
    });
    state = reduceRitualBuilder(state, { type: "CANCEL_RUN" });
    expect(state.phase).toBe("RUN_WAITING_FOR_OWNER");
    state = reduceRitualBuilder(state, {
      type: "RUN_COMMAND_FAILED",
      message: "The cancellation was not recorded.",
    });
    expect(state).toMatchObject({
      phase: "RUN_WAITING_FOR_OWNER",
      error: "The cancellation was not recorded.",
    });
    state = reduceRitualBuilder(state, { type: "APPROVE_RUN_STEP" });
    run = reduceRitualRun(run, approved, {
      type: "APPROVE_STEP",
      stepKey: "prepare-review",
      occurredAt: "2026-08-16T12:00:02.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_STEP",
      stepKey: "prepare-review",
      occurredAt: "2026-08-16T12:00:03.000Z",
    });
    run = reduceRitualRun(run, approved, {
      type: "COMPLETE_RUN",
      outcome: "NEEDS_REVIEW",
      occurredAt: "2026-08-16T12:00:04.000Z",
    });
    const runReceipt = createRitualRunReceipt({
      approved,
      run,
      receiptId: "rcp_01J00000000000000000000001",
      summary: "The fixture completed the approved orchestration step.",
      recordedAt: "2026-08-16T12:00:04.000Z",
    });
    let restored = reduceRitualBuilder(createRitualBuilderState(), {
      type: "HYDRATE_APPROVED_REVISION",
      approved,
    });
    restored = reduceRitualBuilder(restored, { type: "RESTORE_RUN", run });
    expect(restored).toMatchObject({
      phase: "RUN_FAILED",
      error: expect.stringContaining("missing its Receipt"),
    });
    restored = reduceRitualBuilder(restored, {
      type: "RESTORE_RUN_RECEIPT",
      receipt: runReceipt,
    });
    expect(restored.phase).toBe("REVIEW_RUN");
    state = reduceRitualBuilder(state, {
      type: "RUN_RECEIPT",
      run,
      receipt: runReceipt,
    });
    expect(state).toMatchObject({
      phase: "REVIEW_RUN",
      run: { status: "NEEDS_REVIEW" },
      runReceipt: { mode: "RUN", externalEffects: [] },
    });

    state = reduceRitualBuilder(state, { type: "START_FEEDBACK" });
    expect(state).toMatchObject({
      phase: "GIVE_FEEDBACK",
      source: {
        kind: "RUN",
        receipt: { mode: "RUN", receiptId: runReceipt.receiptId },
        run: { runId: run.runId },
      },
    });
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_FEEDBACK",
      feedback: "Keep the evidence but make the next result more concise.",
    });
    expect(state).toMatchObject({
      phase: "SHAPING_LEARNING",
      source: {
        kind: "RUN",
        receipt: { mode: "RUN", receiptId: runReceipt.receiptId },
      },
    });
    if (state.phase !== "SHAPING_LEARNING") {
      throw new Error("expected Run-backed learning phase");
    }
    const runProposal = {
      status: "proposal" as const,
      proposalId: "rlp_01J00000000000000000000001",
      ritualId,
      fromRevision: 1,
      receiptId: runReceipt.receiptId,
      ownerFeedback: state.pendingFeedback,
      stewardMessage: "I propose a more concise result.",
      rationale: "The completed Run and owner feedback support this change.",
      proposedDefinition: {
        name: approved.name,
        purpose: approved.purpose,
        trigger: approved.trigger,
        steps: approved.steps,
        permissions: approved.permissions,
        completion: "A concise reviewable result is ready.",
        reviewPolicy: approved.reviewPolicy,
      },
    };
    state = reduceRitualBuilder(state, {
      type: "LEARNING_PROPOSED",
      proposal: runProposal,
    });
    expect(state).toMatchObject({
      phase: "REVIEW_LEARNING",
      source: {
        kind: "RUN",
        receipt: { mode: "RUN", receiptId: runReceipt.receiptId },
      },
    });
    if (state.phase !== "REVIEW_LEARNING") {
      throw new Error("expected Run-backed learning review");
    }
    const learningReview = state;
    if (learningReview.source.kind !== "RUN") {
      throw new Error("expected Run-backed learning source");
    }
    const rejecting = reduceRitualBuilder(state, {
      type: "REJECT_LEARNING",
    });
    expect(rejecting.phase).toBe("SAVING_LEARNING_DECISION");
    const rejected = reduceRitualBuilder(rejecting, {
      type: "LEARNING_DECISION_SAVED",
    });
    expect(rejected.phase).toBe("REVIEW_RUN");
    if (rejected.phase !== "REVIEW_RUN") {
      throw new Error("expected exact Run review after rejection");
    }
    expect(rejected.run).toBe(learningReview.source.run);
    expect(rejected.runReceipt).toBe(learningReview.source.receipt);
    expect(rejected.run).toStrictEqual(run);
    expect(rejected.runReceipt).toStrictEqual(runReceipt);
    state = learningReview;
    state = reduceRitualBuilder(state, {
      type: "APPROVE_LEARNING",
      occurredAt: "2026-08-16T12:05:00.000Z",
    });
    expect(state).toMatchObject({
      phase: "SAVING_LEARNING",
      pendingRevision: {
        ritualRevision: 2,
        learningProposalId: runProposal.proposalId,
        basedOnReceiptId: runReceipt.receiptId,
      },
    });
    state = reduceRitualBuilder(state, { type: "LEARNING_SAVED" });
    expect(state).toMatchObject({
      phase: "APPROVED",
      approved: { ritualRevision: 2 },
      receipt: null,
    });
  });

  it("restores the exact resource wait when a research retry command fails", () => {
    const researchApproved = {
      schemaVersion: 1 as const,
      ritualId,
      ritualRevision: 1 as const,
      status: "APPROVED" as const,
      approvedDraftId: draftId,
      approvedDraftRevision: 3,
      name: "Research review",
      purpose: "Prepare a public-web research review.",
      trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather bounded public-web evidence.",
          actor: { kind: "STEWARD" as const, role: "Steward" },
          approval: "NONE" as const,
        },
      ],
      permissions: ["Read bounded public-web evidence"],
      completion: "A reviewable result is ready.",
      reviewPolicy: {
        ownerReview: "EVERY_RUN" as const,
        learning: "PROPOSE_ONLY" as const,
      },
      approvedAt: "2026-08-15T16:03:00.000Z",
      research: {
        provider: "EXA" as const,
        query: "important AI agent announcements",
        maxResults: 3,
        lookbackDays: 30,
      },
    };
    let run = createRitualRun({
      approved: researchApproved,
      request: {
        schemaVersion: 1,
        ritualId: researchApproved.ritualId,
        ritualRevision: researchApproved.ritualRevision,
      },
      runId: "rrn_01J00000000000000000000009",
      createdAt: "2026-08-16T13:00:00.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "START",
      occurredAt: "2026-08-16T13:00:01.000Z",
    });
    run = reduceRitualRun(run, researchApproved, {
      type: "WAIT_FOR_RESOURCE",
      reason: "AUTHENTICATION_REQUIRED",
      occurredAt: "2026-08-16T13:00:02.000Z",
    });
    let state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "HYDRATE_APPROVED_REVISION",
      approved: researchApproved,
    });
    state = reduceRitualBuilder(state, { type: "RESTORE_RUN", run });
    state = reduceRitualBuilder(state, { type: "START_RUN" });
    expect(state).toMatchObject({ phase: "STARTING_RUN", run });

    state = reduceRitualBuilder(state, {
      type: "RUN_COMMAND_FAILED",
      message: "Research retry could not start.",
    });
    expect(state).toMatchObject({
      phase: "RUN_WAITING_FOR_RESOURCE",
      run,
      error: "Research retry could not start.",
    });
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
      type: "HYDRATE_APPROVED_REVISION",
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

    state = reduceRitualBuilder(state, { type: "START_FEEDBACK" });
    expect(state.phase).toBe("GIVE_FEEDBACK");
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_FEEDBACK",
      feedback: "Keep future results to three concise bullets.",
    });
    expect(state).toMatchObject({
      phase: "SHAPING_LEARNING",
      pendingFeedback: "Keep future results to three concise bullets.",
    });
    if (state.phase !== "SHAPING_LEARNING") {
      throw new Error("expected learning phase");
    }
    const proposal = {
      status: "proposal" as const,
      proposalId: "rlp_01J00000000000000000000000",
      ritualId,
      fromRevision: 1,
      receiptId: state.source.receipt.receiptId,
      ownerFeedback: state.pendingFeedback,
      stewardMessage: "I propose a shorter expected result.",
      rationale: "The owner asked for a more concise review.",
      proposedDefinition: {
        name: state.approved.name,
        purpose: state.approved.purpose,
        trigger: state.approved.trigger,
        steps: state.approved.steps,
        permissions: state.approved.permissions,
        completion: "Three concise follow-up bullets are ready for review.",
        reviewPolicy: state.approved.reviewPolicy,
      },
    };
    state = reduceRitualBuilder(state, {
      type: "LEARNING_PROPOSED",
      proposal,
    });
    expect(state).toMatchObject({
      phase: "REVIEW_LEARNING",
      proposal: { fromRevision: 1 },
    });
    state = reduceRitualBuilder(state, {
      type: "APPROVE_LEARNING",
      occurredAt: "2026-08-15T18:04:00.000Z",
    });
    expect(state).toMatchObject({
      phase: "SAVING_LEARNING",
      pendingRevision: {
        ritualRevision: 2,
        learningProposalId: proposal.proposalId,
      },
    });
    state = reduceRitualBuilder(state, { type: "LEARNING_SAVED" });
    expect(state).toMatchObject({
      phase: "APPROVED",
      approved: { ritualRevision: 2 },
      receipt: null,
    });
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

    state = reduceRitualBuilder(createRitualBuilderState(), {
      type: "SUBMIT_STARTER",
      draftId,
      starter: { kind: "LAST_30_DAYS", topic: "" },
    });
    expect(state.phase).toBe("DESCRIBE_PURPOSE");
    expect(state.error).toContain("starter details are not valid");

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
