import {
  BrowserPane,
  type BrowserDiagnosticEntry,
  type BrowserUiAction,
  type BrowserUiSnapshot,
} from "@village/ui";
import { useEffect, useState } from "react";
import {
  ModelProviderAccountOnboarding,
  type ModelProviderAccountBridge,
} from "./ModelProviderAccountCard.js";

export interface VillageDesktopBridge extends ModelProviderAccountBridge {
  getBrowserUiState(): Promise<BrowserUiSnapshot>;
  getBrowserDiagnostics(): Promise<readonly BrowserDiagnosticEntry[]>;
  subscribeBrowserUiState(
    listener: (snapshot: BrowserUiSnapshot) => void,
  ): () => void;
  subscribeBrowserDiagnostics(
    listener: (entries: readonly BrowserDiagnosticEntry[]) => void,
  ): () => void;
  requestTakeover(): Promise<
    "QUIESCED" | "OUTCOME_UNKNOWN" | "RECOVERY_REQUIRED" | "DECLINED"
  >;
  requestReturnControl(): Promise<"RETURNED" | "DECLINED">;
  setBrowserPane(input: {
    visible: boolean;
    splitRatio: number;
  }): Promise<void>;
  recordVerificationDecision(decision: "CONFIRM" | "REJECT"): Promise<void>;
  requestForgetSession(): Promise<
    "STEP_UP_REQUIRED" | "DECLINED" | "COMPLETE" | "PARTIAL_FAILURE"
  >;
  requestObserverIntent(intent: "CANCEL_FUTURE_AUTOMATION"): Promise<void>;
}

export async function dispatchDesktopBrowserAction(
  bridge: VillageDesktopBridge,
  action: BrowserUiAction,
): Promise<void> {
  switch (action) {
    case "TAKE_OVER":
      await bridge.requestTakeover();
      return;
    case "RETURN_TO_AGENT":
      await bridge.requestReturnControl();
      return;
    case "CONFIRM_ACCOUNT":
      await bridge.recordVerificationDecision("CONFIRM");
      return;
    case "REJECT_ACCOUNT":
      await bridge.recordVerificationDecision("REJECT");
      return;
    case "BEGIN_FORGET_SESSION":
    case "RETRY_ERASURE":
      await bridge.requestForgetSession();
      return;
    case "CANCEL_AUTOMATION":
      await bridge.requestObserverIntent("CANCEL_FUTURE_AUTOMATION");
      return;
  }
}

declare global {
  interface Window {
    village?: VillageDesktopBridge;
    villagePairing?: import("./PairingBootstrap.js").VillagePairingBridge;
  }
}

export function DesktopBrowserPane({
  initialSnapshot,
  bridge,
}: {
  initialSnapshot: BrowserUiSnapshot;
  bridge?: VillageDesktopBridge;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.42);
  const [pendingAction, setPendingAction] = useState<BrowserUiAction | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<
    readonly BrowserDiagnosticEntry[]
  >([]);
  const activeBridge = bridge ?? globalThis.window?.village;

  useEffect(() => {
    if (!activeBridge) return;
    let active = true;
    let hasCanonicalSnapshot = false;
    const publish = (next: BrowserUiSnapshot) => {
      if (!active) return;
      setSnapshot((current) => {
        if (!hasCanonicalSnapshot) {
          hasCanonicalSnapshot = true;
          return next;
        }
        return Date.parse(next.lastUpdatedAt) >=
          Date.parse(current.lastUpdatedAt)
          ? next
          : current;
      });
    };
    const unsubscribe = activeBridge.subscribeBrowserUiState(publish);
    void activeBridge
      .getBrowserUiState()
      .then(publish)
      .catch(() => active && setActionError("Browser status is unavailable."));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeBridge]);

  useEffect(() => {
    if (!activeBridge) return;
    let active = true;
    const unsubscribe = activeBridge.subscribeBrowserDiagnostics((entries) => {
      if (active) setDiagnostics(entries);
    });
    void activeBridge
      .getBrowserDiagnostics()
      .then((entries) => active && setDiagnostics(entries))
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeBridge]);

  const handleAction = async (action: BrowserUiAction) => {
    if (!activeBridge || pendingAction) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await dispatchDesktopBrowserAction(activeBridge, action);
    } catch {
      setActionError("The browser action did not complete. Try again safely.");
    } finally {
      setPendingAction(null);
    }
  };

  const handleCollapsedChange = (next: boolean) => {
    setCollapsed(next);
    void activeBridge?.setBrowserPane({
      visible: !next,
      splitRatio,
    });
  };

  const handleSplitRatioChange = (next: number) => {
    setSplitRatio(next);
    void activeBridge?.setBrowserPane({ visible: true, splitRatio: next });
  };

  return (
    <div
      className="desktop-workspace"
      style={{
        width: collapsed
          ? "100%"
          : `${Math.round((1 - splitRatio) * 1_000) / 10}%`,
      }}
    >
      <BrowserPane
        snapshot={snapshot}
        collapsed={collapsed}
        onAction={(action) => void handleAction(action)}
        onCollapsedChange={handleCollapsedChange}
        splitRatio={splitRatio}
        onSplitRatioChange={handleSplitRatioChange}
        actionsDisabled={pendingAction !== null}
        diagnostics={diagnostics}
      />
      {activeBridge ? (
        <ModelProviderAccountOnboarding bridge={activeBridge} />
      ) : null}
      {actionError ? (
        <p role="alert" style={{ margin: ".5rem 1rem", color: "#f1b5aa" }}>
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
