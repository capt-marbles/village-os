export const delegatedWorkflowStates = [
  "DISCONNECTED",
  "STARTING",
  "WORKING",
  "TAKEOVER_PENDING",
  "OWNER_CONTROL",
  "RECONCILING",
  "HUMAN_GATE",
  "OFFLINE",
  "CANCEL_PENDING",
  "CANCELLED",
  "FAILED",
  "RECEIPTED_SUCCESS",
] as const;

export type DelegatedWorkflowState = (typeof delegatedWorkflowStates)[number];
export type DelegatedWorkflowTask = "LINKEDIN_PERSONAL" | "VILLAGE_FIXTURE";
export type DelegatedWorkflowAction =
  "START" | "TAKE_OVER" | "HAND_BACK" | "CANCEL" | "RETRY";

export interface DelegatedWorkflowSnapshot {
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
  state: DelegatedWorkflowState;
  logicalStep:
    | "SET_DISPLAY_NAME"
    | "SELECT_ROLE"
    | "SET_PREFERRED_FOCUS"
    | "FINALIZE_SETUP"
    | null;
  controller: "AGENT" | "USER" | "NONE";
  connection: "ONLINE" | "OFFLINE" | "ABSENT";
  actionPhase:
    | "NONE"
    | "ACCEPTED"
    | "DISPATCHED"
    | "EFFECT_OBSERVED"
    | "RECEIPTED"
    | "RECONCILIATION_REQUIRED";
  lastEffectActor: "AGENT" | "OWNER" | null;
  humanGate: string | null;
  inputOwner: "OWNER" | "NONE";
  lastDurableUpdateAt: string;
}

export interface DelegatedWorkflowModel {
  label: string;
  explanation: string;
  tone: "NEUTRAL" | "ACTIVE" | "ATTENTION" | "SUCCESS" | "DANGER";
  primaryAction: DelegatedWorkflowAction | null;
  secondaryActions: readonly DelegatedWorkflowAction[];
  inputOwner: "OWNER" | "NONE";
  actionsDisabled: boolean;
}

type StateCopy = Omit<DelegatedWorkflowModel, "inputOwner">;

const stateCopy: Record<DelegatedWorkflowState, StateCopy> = {
  DISCONNECTED: {
    label: "Connect ChatGPT to begin",
    explanation:
      "Village cannot start the demo while its model provider is disconnected.",
    tone: "ATTENTION",
    primaryAction: null,
    secondaryActions: [],
    actionsDisabled: true,
  },
  STARTING: {
    label: "Starting demo setup…",
    explanation:
      "Village is opening the dedicated fixture and loading durable progress.",
    tone: "ACTIVE",
    primaryAction: null,
    secondaryActions: [],
    actionsDisabled: true,
  },
  WORKING: {
    label: "Village is working",
    explanation:
      "ChatGPT is choosing from the safe actions advertised for this step.",
    tone: "ACTIVE",
    primaryAction: "TAKE_OVER",
    secondaryActions: ["CANCEL"],
    actionsDisabled: false,
  },
  TAKEOVER_PENDING: {
    label: "Taking control safely…",
    explanation:
      "Input stays blocked until the current effect is quiesced or marked for reconciliation.",
    tone: "ACTIVE",
    primaryAction: null,
    secondaryActions: [],
    actionsDisabled: true,
  },
  OWNER_CONTROL: {
    label: "You have control",
    explanation:
      "Automation is fenced. Your valid fixture edits remain authoritative.",
    tone: "SUCCESS",
    primaryAction: "HAND_BACK",
    secondaryActions: ["CANCEL"],
    actionsDisabled: false,
  },
  RECONCILING: {
    label: "Checking your changes…",
    explanation:
      "Village is re-observing the fixture before requesting a fresh automation lease.",
    tone: "ACTIVE",
    primaryAction: null,
    secondaryActions: ["CANCEL"],
    actionsDisabled: true,
  },
  HUMAN_GATE: {
    label: "Your attention is required",
    explanation:
      "Automation is fenced until you resolve this owner-only step locally.",
    tone: "ATTENTION",
    primaryAction: "TAKE_OVER",
    secondaryActions: ["CANCEL"],
    actionsDisabled: false,
  },
  OFFLINE: {
    label: "Offline — automation paused",
    explanation:
      "Village will not dispatch another effect until durable coordinator state is available.",
    tone: "ATTENTION",
    primaryAction: "TAKE_OVER",
    secondaryActions: ["CANCEL"],
    actionsDisabled: false,
  },
  CANCEL_PENDING: {
    label: "Cancelling future automation…",
    explanation:
      "The cancellation is pending durable coordinator acknowledgement.",
    tone: "ACTIVE",
    primaryAction: null,
    secondaryActions: [],
    actionsDisabled: true,
  },
  CANCELLED: {
    label: "Future automation cancelled",
    explanation:
      "No new automated fixture effect can start. Local profile state is preserved.",
    tone: "NEUTRAL",
    primaryAction: null,
    secondaryActions: [],
    actionsDisabled: true,
  },
  FAILED: {
    label: "Demo setup stopped",
    explanation:
      "Village preserved the last durable state. Review it before retrying.",
    tone: "DANGER",
    primaryAction: "RETRY",
    secondaryActions: ["CANCEL"],
    actionsDisabled: false,
  },
  RECEIPTED_SUCCESS: {
    label: "Setup complete",
    explanation:
      "The local complete-profile predicate passed and the final effect was durably receipted.",
    tone: "SUCCESS",
    primaryAction: null,
    secondaryActions: [],
    actionsDisabled: true,
  },
};

export function deriveDelegatedWorkflowModel(
  snapshot: DelegatedWorkflowSnapshot,
): DelegatedWorkflowModel {
  const copy = stateCopy[snapshot.state];
  return {
    ...copy,
    inputOwner: snapshot.state === "OWNER_CONTROL" ? "OWNER" : "NONE",
  };
}

export function delegatedWorkflowActionLabel(
  action: DelegatedWorkflowAction,
): string {
  return {
    START: "Start demo setup",
    TAKE_OVER: "Take control",
    HAND_BACK: "Return control to Village",
    CANCEL: "Cancel future automation",
    RETRY: "Retry safely",
  }[action];
}
