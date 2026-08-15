import {
  approveRitualDraft,
  RitualApprovalError,
  ritualDraftSchema,
  ritualStewardContextSchema,
  ritualTestReceiptSchema,
  ritualTestRunRequestSchema,
  type ApprovedRitualRevision,
  type RitualDraft,
  type RitualStewardProposal,
  type RitualTestReceipt,
} from "@village/contracts";

export interface RitualBuilderMessage {
  id: string;
  speaker: "OWNER" | "STEWARD" | "SYSTEM";
  text: string;
}

interface RitualBuilderStateBase {
  messages: readonly RitualBuilderMessage[];
  error: string | null;
  requestRevision: number;
}

export type RitualBuilderState =
  | (RitualBuilderStateBase & {
      phase: "DESCRIBE_PURPOSE";
      draft: null;
      approved: null;
    })
  | (RitualBuilderStateBase & {
      phase: "DRAFTING";
      draft: null;
      approved: null;
      pendingDraftId: string;
      pendingRequestRevision: number;
    })
  | (RitualBuilderStateBase & {
      phase: "CHOOSE_TRIGGER" | "CHOOSE_REVIEW" | "READY_FOR_APPROVAL";
      draft: RitualDraft;
      approved: null;
    })
  | (RitualBuilderStateBase & {
      phase: "SAVING_APPROVAL";
      draft: RitualDraft;
      approved: null;
      pendingApproval: ApprovedRitualRevision;
    })
  | (RitualBuilderStateBase & {
      phase: "STARTING_NEW_RITUAL";
      draft: RitualDraft;
      approved: ApprovedRitualRevision;
    })
  | (RitualBuilderStateBase & {
      phase: "APPROVED";
      draft: RitualDraft;
      approved: ApprovedRitualRevision;
      receipt: null;
    })
  | (RitualBuilderStateBase & {
      phase: "PREPARING_TEST" | "RUNNING_TEST";
      draft: RitualDraft;
      approved: ApprovedRitualRevision;
      receipt: RitualTestReceipt | null;
    })
  | (RitualBuilderStateBase & {
      phase: "REVIEW_TEST";
      draft: RitualDraft;
      approved: ApprovedRitualRevision;
      receipt: RitualTestReceipt;
    });

export interface RitualBuilderIdentity {
  draftId: string;
  ritualId: string;
}

export type RitualBuilderEvent =
  | {
      type: "SUBMIT_PURPOSE";
      draftId: string;
      purpose: string;
    }
  | {
      type: "STEWARD_PROPOSED";
      proposal: RitualStewardProposal;
      occurredAt: string;
    }
  | { type: "STEWARD_FAILED"; message: string }
  | { type: "RESTORE_APPROVED"; approved: ApprovedRitualRevision }
  | { type: "RESTORE_RECEIPT"; receipt: RitualTestReceipt }
  | { type: "APPROVAL_SAVED" }
  | { type: "APPROVAL_SAVE_FAILED" }
  | { type: "START_NEW_RITUAL" }
  | { type: "NEW_RITUAL_READY" }
  | { type: "NEW_RITUAL_FAILED" }
  | { type: "START_TEST" }
  | { type: "SUBMIT_TEST_SAMPLE"; sample: string }
  | { type: "TEST_RUN_RECEIPT"; receipt: RitualTestReceipt }
  | { type: "TEST_RUN_FAILED"; message: string }
  | {
      type: "SELECT_TRIGGER";
      trigger: "ON_DEMAND" | "WEEKDAYS" | "EVENT";
      timeZone: string;
      occurredAt: string;
    }
  | {
      type: "SELECT_REVIEW";
      ownerReview: "EVERY_RUN" | "EXCEPTIONS_ONLY";
      occurredAt: string;
    }
  | {
      type: "EDIT_FIELD";
      field: "name" | "purpose" | "completion";
      value: string;
      occurredAt: string;
    }
  | {
      type: "APPROVE";
      ritualId: string;
      expectedRevision: number;
      occurredAt: string;
    };

const triggerCopy = {
  ON_DEMAND: {
    kind: "ON_DEMAND" as const,
    summary: "Whenever you ask the Steward",
    ownerMessage: "Start it only when I ask.",
  },
  WEEKDAYS: {
    kind: "SCHEDULED" as const,
    summary: "Every weekday at 8:30 AM America/Chicago",
    ownerMessage: "Prepare it every weekday morning.",
  },
  EVENT: {
    kind: "EVENT" as const,
    summary: "When new work arrives in the connected source",
    ownerMessage: "Start when new work arrives.",
  },
};

function message(
  messages: readonly RitualBuilderMessage[],
  speaker: RitualBuilderMessage["speaker"],
  text: string,
): readonly RitualBuilderMessage[] {
  return [...messages, { id: `message-${messages.length + 1}`, speaker, text }];
}

function revise(
  draft: RitualDraft,
  occurredAt: string,
  patch: Partial<
    Pick<
      RitualDraft,
      "name" | "purpose" | "completion" | "trigger" | "reviewPolicy"
    >
  >,
): RitualDraft | null {
  const result = ritualDraftSchema.safeParse({
    ...draft,
    ...patch,
    revision: draft.revision + 1,
    updatedAt: occurredAt,
  });
  return result.success ? result.data : null;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function createRitualBuilderState(): RitualBuilderState {
  return {
    phase: "DESCRIBE_PURPOSE",
    draft: null,
    approved: null,
    messages: [
      {
        id: "message-1",
        speaker: "STEWARD",
        text: "What regular work should I take care of? Start with the outcome you want, not the setup.",
      },
    ],
    error: null,
    requestRevision: 0,
  };
}

export function reduceRitualBuilder(
  state: RitualBuilderState,
  event: RitualBuilderEvent,
): RitualBuilderState {
  switch (event.type) {
    case "SUBMIT_PURPOSE": {
      if (state.phase !== "DESCRIBE_PURPOSE") return state;
      const purpose = event.purpose.trim();
      if (!purpose) return { ...state, error: "Describe the outcome first." };
      if (purpose.length > 320) {
        return {
          ...state,
          error: "Keep the Ritual outcome to 320 characters or fewer.",
        };
      }
      const requestRevision = state.requestRevision + 1;
      if (
        !ritualStewardContextSchema.safeParse({
          schemaVersion: 1,
          draftId: event.draftId,
          requestRevision,
          ownerPurpose: purpose,
        }).success
      ) {
        return {
          ...state,
          error:
            "The Ritual draft details are not valid. Review them and try again.",
        };
      }
      let messages = message(state.messages, "OWNER", purpose);
      messages = message(
        messages,
        "STEWARD",
        "I’m shaping a concise Ritual draft from that outcome.",
      );
      return {
        ...state,
        phase: "DRAFTING",
        pendingDraftId: event.draftId,
        pendingRequestRevision: requestRevision,
        requestRevision,
        messages,
        error: null,
      };
    }
    case "STEWARD_PROPOSED": {
      if (state.phase !== "DRAFTING") return state;
      if (
        event.proposal.draftId !== state.pendingDraftId ||
        event.proposal.requestRevision !== state.pendingRequestRevision
      ) {
        const error = "The Steward returned an outdated draft. Try again.";
        return {
          phase: "DESCRIBE_PURPOSE",
          draft: null,
          approved: null,
          messages: message(state.messages, "SYSTEM", error),
          error,
          requestRevision: state.requestRevision,
        };
      }
      const parsedDraft = ritualDraftSchema.safeParse({
        schemaVersion: 1,
        draftId: state.pendingDraftId,
        revision: 1,
        status: "DRAFT",
        name: event.proposal.name,
        purpose: event.proposal.purpose,
        trigger: {
          kind: triggerCopy.ON_DEMAND.kind,
          summary: triggerCopy.ON_DEMAND.summary,
        },
        steps: event.proposal.steps,
        permissions: event.proposal.permissions,
        completion: event.proposal.completion,
        reviewPolicy: {
          ownerReview: "EVERY_RUN",
          learning: "PROPOSE_ONLY",
        },
        updatedAt: event.occurredAt,
      });
      if (!parsedDraft.success) {
        const error =
          "The Ritual draft details are not valid. Review them and try again.";
        return {
          phase: "DESCRIBE_PURPOSE",
          draft: null,
          approved: null,
          messages: message(state.messages, "SYSTEM", error),
          error,
          requestRevision: state.requestRevision,
        };
      }
      const draft = parsedDraft.data;
      return {
        ...state,
        phase: "CHOOSE_TRIGGER",
        draft,
        messages: message(
          state.messages,
          "STEWARD",
          event.proposal.stewardMessage,
        ),
        error: null,
      };
    }
    case "STEWARD_FAILED": {
      if (state.phase !== "DRAFTING") return state;
      return {
        phase: "DESCRIBE_PURPOSE",
        draft: null,
        approved: null,
        messages: message(state.messages, "SYSTEM", event.message),
        error: event.message,
        requestRevision: state.requestRevision,
      };
    }
    case "RESTORE_APPROVED": {
      if (state.phase !== "DESCRIBE_PURPOSE") return state;
      const approved = event.approved;
      const draft = ritualDraftSchema.parse({
        schemaVersion: 1,
        draftId: approved.approvedDraftId,
        revision: approved.approvedDraftRevision,
        status: "DRAFT",
        name: approved.name,
        purpose: approved.purpose,
        trigger: approved.trigger,
        steps: approved.steps,
        permissions: approved.permissions,
        completion: approved.completion,
        reviewPolicy: approved.reviewPolicy,
        updatedAt: approved.approvedAt,
      });
      return {
        phase: "APPROVED",
        draft,
        approved,
        receipt: null,
        messages: message(
          state.messages,
          "SYSTEM",
          `Restored the approved ${approved.name} Ritual. No Run has started.`,
        ),
        error: null,
        requestRevision: state.requestRevision,
      };
    }
    case "RESTORE_RECEIPT": {
      if (state.phase !== "APPROVED") return state;
      const receipt = ritualTestReceiptSchema.safeParse(event.receipt);
      if (
        !receipt.success ||
        receipt.data.ritualId !== state.approved.ritualId ||
        receipt.data.ritualRevision !== state.approved.ritualRevision
      ) {
        return {
          ...state,
          error: "The saved Receipt did not match this Ritual.",
        };
      }
      return {
        ...state,
        phase: "REVIEW_TEST",
        receipt: receipt.data,
        messages: message(
          state.messages,
          "SYSTEM",
          "Restored the latest test Receipt for Review.",
        ),
        error: null,
      };
    }
    case "APPROVAL_SAVE_FAILED": {
      if (state.phase !== "SAVING_APPROVAL") return state;
      return {
        phase: "READY_FOR_APPROVAL",
        draft: state.draft,
        approved: null,
        messages: message(
          state.messages,
          "SYSTEM",
          "The approval could not be saved locally. Nothing ran; review the draft and try again.",
        ),
        error: null,
        requestRevision: state.requestRevision,
      };
    }
    case "APPROVAL_SAVED": {
      if (state.phase !== "SAVING_APPROVAL") return state;
      return {
        phase: "APPROVED",
        draft: state.draft,
        approved: state.pendingApproval,
        receipt: null,
        messages: message(
          state.messages,
          "SYSTEM",
          "Ritual approved and saved. No Run has started; the Steward can plan a safe first test Run when you are ready.",
        ),
        error: null,
        requestRevision: state.requestRevision,
      };
    }
    case "START_NEW_RITUAL": {
      if (state.phase !== "APPROVED" && state.phase !== "REVIEW_TEST") {
        return state;
      }
      return {
        phase: "STARTING_NEW_RITUAL",
        draft: state.draft,
        approved: state.approved,
        messages: message(
          state.messages,
          "SYSTEM",
          `Preparing a new Ritual. ${state.approved.name} remains saved.`,
        ),
        error: null,
        requestRevision: state.requestRevision,
      };
    }
    case "NEW_RITUAL_READY": {
      if (state.phase !== "STARTING_NEW_RITUAL") return state;
      return {
        phase: "DESCRIBE_PURPOSE",
        draft: null,
        approved: null,
        messages: [
          {
            id: "message-1",
            speaker: "SYSTEM",
            text: `${state.approved.name} remains saved.`,
          },
          {
            id: "message-2",
            speaker: "STEWARD",
            text: "What other regular work should I take care of? Start with the outcome you want.",
          },
        ],
        error: null,
        requestRevision: 0,
      };
    }
    case "NEW_RITUAL_FAILED": {
      if (state.phase !== "STARTING_NEW_RITUAL") return state;
      const error = "Village could not prepare another Ritual. Try again.";
      return {
        ...state,
        phase: "APPROVED",
        receipt: null,
        messages: message(state.messages, "SYSTEM", error),
        error,
      };
    }
    case "START_TEST": {
      if (state.phase !== "APPROVED" && state.phase !== "REVIEW_TEST") {
        return state;
      }
      return {
        ...state,
        phase: "PREPARING_TEST",
        receipt: state.phase === "REVIEW_TEST" ? state.receipt : null,
        messages: message(
          state.messages,
          "STEWARD",
          "Give me a representative sample. I’ll test the approved Ritual against only that material, with no external effects.",
        ),
        error: null,
      };
    }
    case "SUBMIT_TEST_SAMPLE": {
      if (state.phase !== "PREPARING_TEST") return state;
      const sample = event.sample.trim();
      const request = ritualTestRunRequestSchema.safeParse({
        schemaVersion: 1,
        ritualId: state.approved.ritualId,
        ritualRevision: state.approved.ritualRevision,
        sample,
      });
      if (!request.success) {
        return {
          ...state,
          error: !sample
            ? "Add a representative sample first."
            : sample.length < 16
              ? "Use at least 16 characters so the test has meaningful context."
              : "Keep the test sample to 4,000 characters or fewer.",
        };
      }
      return {
        ...state,
        phase: "RUNNING_TEST",
        messages: message(
          state.messages,
          "STEWARD",
          "I’m applying the approved Ritual to that sample now.",
        ),
        error: null,
      };
    }
    case "TEST_RUN_RECEIPT": {
      if (state.phase !== "RUNNING_TEST") return state;
      const receipt = ritualTestReceiptSchema.safeParse(event.receipt);
      if (
        !receipt.success ||
        receipt.data.ritualId !== state.approved.ritualId ||
        receipt.data.ritualRevision !== state.approved.ritualRevision
      ) {
        return {
          ...state,
          phase: "PREPARING_TEST",
          error: "Village rejected a Receipt that did not match this Ritual.",
        };
      }
      return {
        ...state,
        phase: "REVIEW_TEST",
        receipt: receipt.data,
        messages: message(
          state.messages,
          "STEWARD",
          "The test is complete. Review the result and its evidence in the Receipt.",
        ),
        error: null,
      };
    }
    case "TEST_RUN_FAILED": {
      if (state.phase !== "RUNNING_TEST") return state;
      return {
        ...state,
        phase: "PREPARING_TEST",
        messages: message(state.messages, "SYSTEM", event.message),
        error: event.message,
      };
    }
    case "SELECT_TRIGGER": {
      if (state.phase !== "CHOOSE_TRIGGER") return state;
      const selected = triggerCopy[event.trigger];
      if (event.trigger === "WEEKDAYS" && !isValidTimeZone(event.timeZone)) {
        return { ...state, error: "Choose a valid local timezone." };
      }
      const summary =
        event.trigger === "WEEKDAYS"
          ? `Every weekday at 8:30 AM ${event.timeZone}`
          : selected.summary;
      const draft = revise(state.draft, event.occurredAt, {
        trigger: { kind: selected.kind, summary },
      });
      if (!draft) {
        return { ...state, error: "The trigger could not be saved." };
      }
      let messages = message(state.messages, "OWNER", selected.ownerMessage);
      messages = message(
        messages,
        "SYSTEM",
        "How closely should I involve you when a Run finishes?",
      );
      return {
        ...state,
        phase: "CHOOSE_REVIEW",
        draft,
        messages,
        error: null,
      };
    }
    case "SELECT_REVIEW": {
      if (state.phase !== "CHOOSE_REVIEW") return state;
      const everyRun = event.ownerReview === "EVERY_RUN";
      const draft = revise(state.draft, event.occurredAt, {
        reviewPolicy: {
          ownerReview: event.ownerReview,
          learning: "PROPOSE_ONLY",
        },
      });
      if (!draft) {
        return { ...state, error: "The Review policy could not be saved." };
      }
      let messages = message(
        state.messages,
        "OWNER",
        everyRun
          ? "Let me review every Run."
          : "Bring me exceptions and uncertain results.",
      );
      messages = message(
        messages,
        "SYSTEM",
        "The Ritual is ready to inspect. You can change the supported fields directly in the draft. Nothing runs until you approve it.",
      );
      return {
        ...state,
        phase: "READY_FOR_APPROVAL",
        draft,
        messages,
        error: null,
      };
    }
    case "EDIT_FIELD": {
      if (
        state.phase !== "CHOOSE_TRIGGER" &&
        state.phase !== "CHOOSE_REVIEW" &&
        state.phase !== "READY_FOR_APPROVAL"
      )
        return state;
      const value = event.value.trim();
      if (!value) {
        return { ...state, error: "Ritual fields cannot be empty." };
      }
      const maximumLength = event.field === "name" ? 80 : 320;
      if (value.length > maximumLength) {
        return {
          ...state,
          error: `Keep the Ritual ${event.field} to ${maximumLength} characters or fewer.`,
        };
      }
      if (state.draft[event.field] === value) return state;
      const draft = revise(state.draft, event.occurredAt, {
        [event.field]: value,
      });
      if (!draft) {
        return { ...state, error: `The Ritual ${event.field} is not valid.` };
      }
      return {
        ...state,
        draft,
        messages: message(
          state.messages,
          "SYSTEM",
          `Updated the ${event.field}. The draft is now revision ${draft.revision}.`,
        ),
        error: null,
      };
    }
    case "APPROVE": {
      if (!state.draft || state.phase !== "READY_FOR_APPROVAL") return state;
      try {
        const approved = approveRitualDraft(state.draft, {
          schemaVersion: 1,
          draftId: state.draft.draftId,
          expectedRevision: event.expectedRevision,
          ritualId: event.ritualId,
          approvedAt: event.occurredAt,
        });
        return {
          ...state,
          phase: "SAVING_APPROVAL",
          approved: null,
          pendingApproval: approved,
          messages: message(
            state.messages,
            "SYSTEM",
            "Approval received. I’m saving the exact Ritual revision locally; no Run has started.",
          ),
          error: null,
        };
      } catch (error) {
        if (
          error instanceof RitualApprovalError &&
          error.code === "STALE_RITUAL_DRAFT"
        ) {
          return {
            ...state,
            error:
              "The Ritual changed after this approval view opened. Review the latest revision before approving.",
          };
        }
        return {
          ...state,
          error:
            "The Ritual identity is not valid. Reopen the draft and try again.",
        };
      }
    }
  }
}
