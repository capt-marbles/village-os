import {
  BrowserStatusCard,
  browserActionLabel,
  deriveBrowserUiModel,
  type BrowserUiAction,
  type BrowserUiSnapshot,
} from "@village/ui";

export function ObserverBrowserCard({
  snapshot,
  onIntent,
  intentPending = false,
}: {
  snapshot: BrowserUiSnapshot;
  onIntent?: (
    intent: Extract<BrowserUiAction, "NOTIFY_DESKTOP" | "CANCEL_AUTOMATION">,
  ) => void;
  intentPending?: boolean;
}) {
  const observerSnapshot = { ...snapshot, surface: "OBSERVER" } as const;
  const model = deriveBrowserUiModel(observerSnapshot);
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
            disabled={!onIntent || intentPending}
            onClick={() => onIntent?.("NOTIFY_DESKTOP")}
          >
            {browserActionLabel.NOTIFY_DESKTOP}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={!onIntent || intentPending}
            onClick={() => onIntent?.("CANCEL_AUTOMATION")}
          >
            {browserActionLabel.CANCEL_AUTOMATION}
          </button>
        </div>
      </div>
    </section>
  );
}
