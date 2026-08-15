import {
  approveRitualDraft,
  ritualDraftSchema,
  type ApprovedRitualRevision,
  type RitualDraft,
} from "@village/contracts";

export type RitualBuilderPhase =
  | "DESCRIBE_PURPOSE"
  | "CHOOSE_TRIGGER"
  | "CHOOSE_REVIEW"
  | "READY_FOR_APPROVAL"
  | "APPROVED";

export interface RitualBuilderMessage {
  id: string;
  speaker: "OWNER" | "STEWARD";
  text: string;
}

export interface RitualBuilderState {
  phase: RitualBuilderPhase;
  draft: RitualDraft | null;
  approved: ApprovedRitualRevision | null;
  runState: "NOT_STARTED";
  messages: readonly RitualBuilderMessage[];
  error: string | null;
}

export type RitualBuilderEvent =
  | { type: "SUBMIT_PURPOSE"; purpose: string; occurredAt: string }
  | {
      type: "SELECT_TRIGGER";
      trigger: "ON_DEMAND" | "WEEKDAYS" | "EVENT";
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
  | { type: "APPROVE"; expectedRevision: number; occurredAt: string };

const prototypeDraftId = "rtd_01J00000000000000000000000";
const prototypeRitualId = "rtl_01J00000000000000000000000";

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

function nameFromPurpose(purpose: string): string {
  const firstClause = purpose.trim().split(/[.!?]/u)[0]?.trim() ?? "";
  return (firstClause || "New Ritual").slice(0, 80);
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
): RitualDraft {
  return ritualDraftSchema.parse({
    ...draft,
    ...patch,
    revision: draft.revision + 1,
    updatedAt: occurredAt,
  });
}

export function createRitualBuilderState(): RitualBuilderState {
  return {
    phase: "DESCRIBE_PURPOSE",
    draft: null,
    approved: null,
    runState: "NOT_STARTED",
    messages: [
      {
        id: "message-1",
        speaker: "STEWARD",
        text: "What regular work should I take care of? Start with the outcome you want, not the setup.",
      },
    ],
    error: null,
  };
}

export function reduceRitualBuilder(
  state: RitualBuilderState,
  event: RitualBuilderEvent,
): RitualBuilderState {
  switch (event.type) {
    case "SUBMIT_PURPOSE": {
      const purpose = event.purpose.trim();
      if (!purpose) return { ...state, error: "Describe the outcome first." };
      const draft = ritualDraftSchema.parse({
        schemaVersion: 1,
        draftId: prototypeDraftId,
        revision: 1,
        status: "DRAFT",
        name: nameFromPurpose(purpose),
        purpose,
        trigger: {
          kind: "ON_DEMAND",
          summary: "Whenever you ask the Steward",
        },
        steps: [
          {
            stepKey: "gather-current-work",
            title: "Gather the current work",
            description: "Collect only the information needed for this Ritual.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "NONE",
          },
          {
            stepKey: "prepare-reviewed-result",
            title: "Prepare the result",
            description:
              "Organize the outcome and retain evidence for the Receipt.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "NONE",
          },
          {
            stepKey: "present-for-review",
            title: "Present it for Review",
            description:
              "Show the result, uncertainty, and any proposed external effect.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "OWNER_REQUIRED",
          },
        ],
        permissions: ["Read only the sources connected to this Ritual"],
        completion: "A reviewable result and Receipt are ready for the owner.",
        reviewPolicy: {
          ownerReview: "EVERY_RUN",
          learning: "PROPOSE_ONLY",
        },
        updatedAt: event.occurredAt,
      });
      let messages = message(state.messages, "OWNER", purpose);
      messages = message(
        messages,
        "STEWARD",
        "I have started the draft. When should this Ritual begin?",
      );
      return {
        ...state,
        phase: "CHOOSE_TRIGGER",
        draft,
        messages,
        error: null,
      };
    }
    case "SELECT_TRIGGER": {
      if (!state.draft || state.phase === "APPROVED") return state;
      const selected = triggerCopy[event.trigger];
      const draft = revise(state.draft, event.occurredAt, {
        trigger: { kind: selected.kind, summary: selected.summary },
      });
      let messages = message(state.messages, "OWNER", selected.ownerMessage);
      messages = message(
        messages,
        "STEWARD",
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
      if (!state.draft || state.phase === "APPROVED") return state;
      const everyRun = event.ownerReview === "EVERY_RUN";
      const draft = revise(state.draft, event.occurredAt, {
        reviewPolicy: {
          ownerReview: event.ownerReview,
          learning: "PROPOSE_ONLY",
        },
      });
      let messages = message(
        state.messages,
        "OWNER",
        everyRun
          ? "Let me review every Run."
          : "Bring me exceptions and uncertain results.",
      );
      messages = message(
        messages,
        "STEWARD",
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
      if (!state.draft || state.phase === "APPROVED") return state;
      const value = event.value.trim();
      if (!value) {
        return { ...state, error: "Ritual fields cannot be empty." };
      }
      if (state.draft[event.field] === value) return state;
      const draft = revise(state.draft, event.occurredAt, {
        [event.field]: value,
      });
      return {
        ...state,
        draft,
        messages: message(
          state.messages,
          "STEWARD",
          `I updated the ${event.field}. The draft is now revision ${draft.revision}.`,
        ),
        error: null,
      };
    }
    case "APPROVE": {
      if (!state.draft || state.phase !== "READY_FOR_APPROVAL") return state;
      try {
        const approved = approveRitualDraft(state.draft, {
          draftId: state.draft.draftId,
          expectedRevision: event.expectedRevision,
          ritualId: prototypeRitualId,
          approvedAt: event.occurredAt,
        });
        return {
          ...state,
          phase: "APPROVED",
          approved,
          messages: message(
            state.messages,
            "STEWARD",
            "Ritual approved. No Run has started; when you are ready, I can plan a safe first test Run.",
          ),
          error: null,
        };
      } catch (error) {
        if (error instanceof Error && error.message === "STALE_RITUAL_DRAFT") {
          return {
            ...state,
            error:
              "The Ritual changed after this approval view opened. Review the latest revision before approving.",
          };
        }
        throw error;
      }
    }
  }
}
