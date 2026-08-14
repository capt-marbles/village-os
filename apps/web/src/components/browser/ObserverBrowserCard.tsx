import {
  BrowserStatusCard,
  deriveBrowserUiModel,
  deriveObserverCancellationModel,
  type BrowserUiAction,
  type ObserverCancellationState,
} from "@village/ui";
import type { ObserverWorkflowSnapshot } from "./observer-client.js";

export function ObserverBrowserCard({
  snapshot,
  onIntent,
  cancellationState = "READY",
}: {
  snapshot: ObserverWorkflowSnapshot;
  onIntent?: (intent: Extract<BrowserUiAction, "CANCEL_AUTOMATION">) => void;
  cancellationState?: ObserverCancellationState;
}) {
  const observerSnapshot = { ...snapshot, surface: "OBSERVER" } as const;
  const model = deriveBrowserUiModel(observerSnapshot);
  const cancellation = deriveObserverCancellationModel(
    snapshot.terminalEvidence && snapshot.terminalEvidence !== "CANCELLED"
      ? "ALREADY_TERMINAL"
      : snapshot.terminalEvidence === "CANCELLED" &&
          snapshot.connection === "OFFLINE"
        ? "PENDING_DESKTOP_SYNC"
        : snapshot.terminalEvidence === "CANCELLED" && snapshot.automationFenced
          ? "AUTOMATION_FENCED"
          : cancellationState,
  );
  return (
    <section className="observer-card" aria-label="Paired desktop browser">
      <BrowserStatusCard model={model} />
      <div className="observer-card__body">
        <p className="observer-card__eyebrow">PAIRED DESKTOP</p>
        <h2>Browser stays on your paired desktop</h2>
        <p>
          This view shows safe job and controller status. It does not stream
          browser pixels, cookies, page text, or remote control.
        </p>
        <dl className="observer-card__facts">
          <div>
            <dt>Workflow</dt>
            <dd>
              {snapshot.workflowKind} v{snapshot.workflowVersion}
            </dd>
          </div>
          <div>
            <dt>Current step</dt>
            <dd>
              {snapshot.logicalStep?.replaceAll("_", " ").toLowerCase() ??
                "Not started"}
            </dd>
          </div>
          <div>
            <dt>Action phase</dt>
            <dd>
              {snapshot.actionPhase?.replaceAll("_", " ").toLowerCase() ??
                "None"}
            </dd>
          </div>
          <div>
            <dt>Last effect</dt>
            <dd>{snapshot.lastEffectActor ?? "None"}</dd>
          </div>
          <div>
            <dt>Controller</dt>
            <dd>{snapshot.controller.toLowerCase()}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>{snapshot.connection.toLowerCase()}</dd>
          </div>
          <div>
            <dt>Last update</dt>
            <dd>{new Date(snapshot.lastUpdatedAt).toLocaleTimeString()}</dd>
          </div>
        </dl>
        <div className="observer-card__actions">
          <button
            type="button"
            className="button-secondary"
            disabled={!onIntent || cancellation.disabled}
            onClick={() => onIntent?.("CANCEL_AUTOMATION")}
          >
            {cancellation.label}
          </button>
        </div>
        <p role="status">{cancellation.explanation}</p>
        {snapshot.cancellationAcknowledgedAt ? (
          <p>
            Durably acknowledged:{" "}
            <time dateTime={snapshot.cancellationAcknowledgedAt}>
              {snapshot.cancellationAcknowledgedAt}
            </time>
          </p>
        ) : null}
      </div>
    </section>
  );
}
