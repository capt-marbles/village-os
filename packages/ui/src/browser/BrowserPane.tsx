import { BrowserStatusCard } from "./BrowserStatusCard.js";
import { BrowserToolbar } from "./BrowserToolbar.js";
import {
  BrowserDiagnostics,
  type BrowserDiagnosticEntry,
} from "./BrowserDiagnostics.js";
import { ForgetSessionFlow } from "./ForgetSessionFlow.js";
import { HumanGateCard } from "./HumanGateCard.js";
import { PairingFlow } from "./PairingFlow.js";
import { VerificationPrompt } from "./VerificationPrompt.js";
import {
  deriveBrowserUiModel,
  type BrowserUiAction,
  type BrowserUiSnapshot,
} from "./browser-ui-state-matrix.js";

export function BrowserPane({
  snapshot,
  collapsed,
  onAction,
  onCollapsedChange,
  splitRatio,
  onSplitRatioChange,
  actionsDisabled,
  diagnostics = [],
}: {
  snapshot: BrowserUiSnapshot;
  collapsed: boolean;
  onAction?: (action: BrowserUiAction) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  splitRatio?: number;
  onSplitRatioChange?: (splitRatio: number) => void;
  actionsDisabled?: boolean;
  diagnostics?: readonly BrowserDiagnosticEntry[];
}) {
  const model = deriveBrowserUiModel(snapshot);
  return (
    <aside
      aria-label={
        collapsed ? "Local browser status" : "Local browser status and controls"
      }
      style={
        collapsed
          ? undefined
          : {
              minWidth: 0,
              height: "100%",
              color: "#eef3eb",
              background: "#131914",
            }
      }
    >
      <BrowserToolbar
        model={model}
        collapsed={collapsed}
        {...(onAction ? { onAction } : {})}
        {...(onCollapsedChange ? { onCollapsedChange } : {})}
        {...(splitRatio === undefined ? {} : { splitRatio })}
        {...(onSplitRatioChange ? { onSplitRatioChange } : {})}
        {...(actionsDisabled === undefined ? {} : { actionsDisabled })}
      />
      {!collapsed ? (
        <>
          <BrowserStatusCard model={model} />
          <PairingFlow state={snapshot.pairing} />
          {snapshot.humanGate ? (
            <HumanGateCard reason={snapshot.humanGate} />
          ) : null}
          {snapshot.jobState === "VERIFYING" &&
          snapshot.verification === "unknown" ? (
            <VerificationPrompt {...(onAction ? { onAction } : {})} />
          ) : null}
          <ForgetSessionFlow
            state={snapshot.erasure}
            {...(onAction ? { onAction } : {})}
          />
          <BrowserDiagnostics entries={diagnostics} />
          <div
            id="village-browser-surface"
            role="region"
            aria-label="Live local browser appears in the adjacent native pane"
            style={{ padding: "1rem", color: "#879187", fontSize: ".85rem" }}
          >
            Live browser pixels stay on this desktop.
          </div>
        </>
      ) : null}
    </aside>
  );
}
