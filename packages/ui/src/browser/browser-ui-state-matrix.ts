import type {
  BrowserControlState,
  HumanGate,
  JobState,
  VerificationResult,
} from "@village/contracts";

export type BrowserUiSurface = "DESKTOP" | "OBSERVER";
export type BrowserJobState = JobState;
export type BrowserController = BrowserControlState["controller"];
export type BrowserConnection = BrowserControlState["connection"];
export type BrowserTakeover = BrowserControlState["takeover"];
export type BrowserPairing =
  | "UNPAIRED"
  | "CONFIRMING"
  | "PAIRED"
  | "EXPIRED"
  | "REJECTED"
  | "REVOKED"
  | "RECOVERING";
export type BrowserVerification = VerificationResult["status"];
export type BrowserProfile = BrowserControlState["profile"];
export type BrowserErasure =
  | "IDLE"
  | "STEP_UP_REQUIRED"
  | "CONFIRMING"
  | "ERASING"
  | "FAILED"
  | "COMPLETE";
export type HumanGateReason = HumanGate["reason"];

export type BrowserUiAction =
  | "TAKE_OVER"
  | "RETURN_TO_AGENT"
  | "NOTIFY_DESKTOP"
  | "CANCEL_AUTOMATION"
  | "CONFIRM_ACCOUNT"
  | "REJECT_ACCOUNT"
  | "BEGIN_FORGET_SESSION"
  | "RETRY_ERASURE";

export interface BrowserUiSnapshot {
  surface: BrowserUiSurface;
  jobState: BrowserJobState;
  controller: BrowserController;
  connection: BrowserConnection;
  takeover: BrowserTakeover;
  pairing: BrowserPairing;
  verification: BrowserVerification;
  profile: BrowserProfile;
  humanGate: HumanGateReason | null;
  erasure: BrowserErasure;
  lastUpdatedAt: string;
}

export interface BrowserUiModel {
  label: string;
  explanation: string;
  tone: "NEUTRAL" | "ACTIVE" | "ATTENTION" | "SUCCESS" | "DANGER";
  primaryAction: BrowserUiAction | null;
  primaryEnabled: boolean;
  secondaryActions: BrowserUiAction[];
  browserInputEnabled: boolean;
  liveBrowserAvailable: boolean;
  destructiveActionRequiresStepUp: boolean;
}

const pairingCopy: Record<
  Exclude<BrowserPairing, "PAIRED">,
  Pick<BrowserUiModel, "label" | "explanation" | "tone">
> = {
  UNPAIRED: {
    label: "Pair this desktop",
    explanation: "Pairing connects this browser host to your Village account.",
    tone: "ATTENTION",
  },
  CONFIRMING: {
    label: "Confirm this desktop",
    explanation: "Check the device name and approve it in the pairing window.",
    tone: "ACTIVE",
  },
  EXPIRED: {
    label: "Pairing expired",
    explanation: "The one-time pairing request expired. Start a new one.",
    tone: "ATTENTION",
  },
  REJECTED: {
    label: "Pairing declined",
    explanation: "This desktop was not added. You can try again safely.",
    tone: "NEUTRAL",
  },
  REVOKED: {
    label: "Desktop access revoked",
    explanation: "This device can no longer receive Village work.",
    tone: "DANGER",
  },
  RECOVERING: {
    label: "Restoring desktop connection…",
    explanation: "Village is checking the paired device before resuming.",
    tone: "ACTIVE",
  },
};

function pairingModel(snapshot: BrowserUiSnapshot): BrowserUiModel | null {
  if (snapshot.pairing === "PAIRED") return null;
  const copy = pairingCopy[snapshot.pairing];
  return {
    ...copy,
    primaryAction: null,
    primaryEnabled: false,
    secondaryActions: [],
    browserInputEnabled: false,
    liveBrowserAvailable: false,
    destructiveActionRequiresStepUp: true,
  };
}

export function deriveBrowserUiModel(
  snapshot: BrowserUiSnapshot,
): BrowserUiModel {
  const pairing = pairingModel(snapshot);
  if (pairing) return pairing;

  const secondaryActions: BrowserUiAction[] = ["CANCEL_AUTOMATION"];
  if (snapshot.surface === "DESKTOP" && snapshot.profile !== "ABSENT") {
    secondaryActions.push(
      snapshot.erasure === "FAILED" ? "RETRY_ERASURE" : "BEGIN_FORGET_SESSION",
    );
  }

  if (snapshot.profile === "ERASURE_FAILED" || snapshot.erasure === "FAILED") {
    return makeModel(
      "Session removal needs attention",
      "Some local session data could not be removed. Retry to finish safely.",
      "DANGER",
      snapshot.surface === "DESKTOP" ? "RETRY_ERASURE" : "NOTIFY_DESKTOP",
      true,
      secondaryActions,
      snapshot,
      false,
    );
  }
  if (snapshot.profile === "FORGETTING" || snapshot.erasure === "ERASING") {
    return makeModel(
      "Removing local session…",
      "The browser is closed while Village clears only this site profile.",
      "ACTIVE",
      null,
      false,
      [],
      snapshot,
      false,
    );
  }
  if (
    snapshot.connection === "ABSENT" ||
    snapshot.jobState === "WAITING_FOR_BROWSER"
  ) {
    return makeModel(
      "Desktop browser unavailable",
      "Work is paused. Village will not start a remote browser automatically.",
      "ATTENTION",
      snapshot.surface === "OBSERVER" ? "NOTIFY_DESKTOP" : null,
      snapshot.surface === "OBSERVER",
      secondaryActions,
      snapshot,
      false,
    );
  }
  if (snapshot.takeover === "QUIESCING") {
    return makeModel(
      "Taking control safely…",
      "Waiting for the current browser action to stop or reconcile.",
      "ACTIVE",
      null,
      false,
      [],
      snapshot,
      false,
    );
  }
  if (snapshot.takeover === "RECONCILING") {
    return makeModel(
      "Reconciling before hand-back…",
      "Village is checking the last browser effect before automation resumes.",
      "ACTIVE",
      null,
      false,
      secondaryActions,
      snapshot,
      false,
    );
  }
  if (snapshot.controller === "USER") {
    const offline = snapshot.connection === "OFFLINE";
    return makeModel(
      offline ? "You have local control — offline" : "You have control",
      offline
        ? "Manual browsing can continue, but agent hand-back waits for reconnection."
        : "Village automation is fenced until you return control.",
      offline ? "ATTENTION" : "SUCCESS",
      snapshot.surface === "OBSERVER" ? "NOTIFY_DESKTOP" : "RETURN_TO_AGENT",
      snapshot.surface === "OBSERVER" || !offline,
      secondaryActions,
      snapshot,
      snapshot.surface === "DESKTOP",
    );
  }
  if (snapshot.verification === "authenticated") {
    return makeModel(
      "Signed in",
      "The local verification predicate found an authenticated session.",
      "SUCCESS",
      snapshot.surface === "OBSERVER" ? "NOTIFY_DESKTOP" : null,
      snapshot.surface === "OBSERVER",
      secondaryActions,
      snapshot,
      false,
    );
  }
  if (snapshot.jobState === "SUCCEEDED") {
    return makeModel(
      "Completed",
      "The job finished and the local browser profile remains on this device.",
      "SUCCESS",
      null,
      false,
      secondaryActions,
      snapshot,
      false,
    );
  }
  if (snapshot.jobState === "FAILED") {
    return makeModel(
      "Browser work stopped",
      "Review the last safe event before retrying.",
      "DANGER",
      snapshot.surface === "OBSERVER" ? "NOTIFY_DESKTOP" : null,
      snapshot.surface === "OBSERVER",
      secondaryActions,
      snapshot,
      false,
    );
  }
  if (snapshot.jobState === "CANCELED") {
    return makeModel(
      "Future automation canceled",
      "No new automated browser action will start. The local profile is preserved.",
      "NEUTRAL",
      snapshot.surface === "OBSERVER" ? "NOTIFY_DESKTOP" : null,
      snapshot.surface === "OBSERVER",
      snapshot.surface === "DESKTOP" ? ["BEGIN_FORGET_SESSION"] : [],
      snapshot,
      false,
    );
  }

  return makeModel(
    snapshot.humanGate ? "Needs your attention" : "Agent has control",
    snapshot.humanGate
      ? "Take over on the paired desktop to complete the human-only step."
      : "Village can act in the visible local browser. You can interrupt at any time.",
    snapshot.humanGate ? "ATTENTION" : "ACTIVE",
    snapshot.surface === "OBSERVER" ? "NOTIFY_DESKTOP" : "TAKE_OVER",
    true,
    secondaryActions,
    snapshot,
    false,
  );
}

function makeModel(
  label: string,
  explanation: string,
  tone: BrowserUiModel["tone"],
  primaryAction: BrowserUiAction | null,
  primaryEnabled: boolean,
  secondaryActions: BrowserUiAction[],
  snapshot: BrowserUiSnapshot,
  browserInputEnabled: boolean,
): BrowserUiModel {
  return {
    label,
    explanation,
    tone,
    primaryAction,
    primaryEnabled,
    secondaryActions,
    browserInputEnabled,
    liveBrowserAvailable: snapshot.surface === "DESKTOP",
    destructiveActionRequiresStepUp: true,
  };
}

export const browserActionLabel: Record<BrowserUiAction, string> = {
  TAKE_OVER: "Take control",
  RETURN_TO_AGENT: "Return control to Village",
  NOTIFY_DESKTOP: "Notify desktop",
  CANCEL_AUTOMATION: "Cancel future automation",
  CONFIRM_ACCOUNT: "Yes, this is my account",
  REJECT_ACCOUNT: "No, keep status unknown",
  BEGIN_FORGET_SESSION: "Forget local session",
  RETRY_ERASURE: "Retry session removal",
};
