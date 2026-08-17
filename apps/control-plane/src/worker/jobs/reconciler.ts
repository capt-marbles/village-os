import {
  browserControlStateSchema,
  resolveActionReconciliation,
  type BrowserAction,
  type BrowserControlState,
} from "@village/contracts";

export type ReconciledAction = {
  actionId: BrowserAction["actionId"];
  phase: BrowserAction["phase"];
  disposition: "RECEIPTED" | "RETRY_ALLOWED" | "WAITING_FOR_USER";
};

export type BrowserRecoveryResult = {
  control: BrowserControlState;
  actions: readonly ReconciledAction[];
  continuation:
    | { status: "NONE" }
    | { status: "RETRY_ALLOWED"; actionId: BrowserAction["actionId"] }
    | { status: "WAITING_FOR_USER"; actionId: BrowserAction["actionId"] };
};

type BrowserRecoveryInput = {
  state: BrowserControlState;
  actions: readonly BrowserAction[];
  now: string;
};

/**
 * Converts an interrupted cloud view into a fenced reconciliation state. It
 * identifies one possible idempotent continuation but never dispatches it.
 */
export function reconcileBrowserRecovery(
  input: BrowserRecoveryInput,
): BrowserRecoveryResult {
  const state = browserControlStateSchema.parse(input.state);
  const hasOrphan = input.actions.some(
    (action) => action.phase !== "RECEIPTED",
  );
  const leaseExpired =
    state.controller === "AGENT" &&
    state.leaseExpiresAt !== null &&
    Date.parse(state.leaseExpiresAt) <= Date.parse(input.now);
  const control =
    hasOrphan || leaseExpired ? fenceForReconciliation(state) : state;
  const actions = input.actions
    .map(reconcileAction)
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
  const waiting = actions.find(
    (action) => action.disposition === "WAITING_FOR_USER",
  );
  if (waiting) {
    return {
      control,
      actions,
      continuation: { status: "WAITING_FOR_USER", actionId: waiting.actionId },
    };
  }
  const retryable = actions.find(
    (action) => action.disposition === "RETRY_ALLOWED",
  );
  return {
    control,
    actions,
    continuation: retryable
      ? { status: "RETRY_ALLOWED", actionId: retryable.actionId }
      : { status: "NONE" },
  };
}

function fenceForReconciliation(
  state: BrowserControlState,
): BrowserControlState {
  if (state.connection !== "ONLINE" || state.controller === "USER") {
    return state;
  }
  return browserControlStateSchema.parse({
    ...state,
    controller: "NONE",
    leaseEpoch: state.leaseEpoch + (state.controller === "AGENT" ? 1 : 0),
    leaseExpiresAt: null,
    automationBlocked: true,
    takeover: "RECONCILING",
  });
}

function reconcileAction(action: BrowserAction): ReconciledAction {
  if (action.phase === "RECEIPTED") {
    return {
      actionId: action.actionId,
      phase: "RECEIPTED",
      disposition: "RECEIPTED",
    };
  }
  if (action.phase === "ACCEPTED") {
    return {
      actionId: action.actionId,
      phase: "ACCEPTED",
      disposition: "RETRY_ALLOWED",
    };
  }
  const resolution = resolveActionReconciliation(
    action.mutationClass,
    action.postcondition === "UNOBSERVED" ? "UNKNOWN" : action.postcondition,
  );
  return {
    actionId: action.actionId,
    phase: resolution === "RECEIPTED" ? "RECEIPTED" : "RECONCILIATION_REQUIRED",
    disposition:
      resolution === "RECEIPTED"
        ? "RECEIPTED"
        : resolution === "RETRY_ALLOWED"
          ? "RETRY_ALLOWED"
          : "WAITING_FOR_USER",
  };
}
