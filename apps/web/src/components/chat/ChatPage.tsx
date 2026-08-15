import {
  VillageShell,
  type BrowserUiAction,
  type ObserverCancellationState,
} from "@village/ui";
import { useEffect, useMemo, useState } from "react";
import { ObserverBrowserCard } from "../browser/ObserverBrowserCard.js";
import { PairDesktopCard } from "../browser/PairDesktopCard.js";
import {
  ObserverApiClient,
  selectionFromUrl,
  unavailableObserverSnapshot,
  type ObserverSelection,
} from "../browser/observer-client.js";

type ObserverIntent = Extract<BrowserUiAction, "CANCEL_AUTOMATION">;

export function ChatPage({
  client,
  selection,
}: {
  client?: ObserverApiClient;
  selection?: ObserverSelection | null;
} = {}) {
  const activeClient = useMemo(
    () =>
      client ??
      new ObserverApiClient(
        typeof window === "undefined"
          ? "https://village.invalid"
          : window.origin,
      ),
    [client],
  );
  const activeSelection = useMemo(
    () =>
      selection === undefined
        ? typeof window === "undefined"
          ? null
          : selectionFromUrl(new URL(window.location.href))
        : selection,
    [selection],
  );
  const [snapshot, setSnapshot] = useState(unavailableObserverSnapshot);
  const [status, setStatus] = useState<"LOADING" | "READY" | "UNAVAILABLE">(
    activeSelection ? "LOADING" : "UNAVAILABLE",
  );
  const [cancellationState, setCancellationState] =
    useState<ObserverCancellationState>("READY");
  const [intentError, setIntentError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSelection) {
      setSnapshot(unavailableObserverSnapshot());
      setStatus("UNAVAILABLE");
      return;
    }
    const abort = new AbortController();
    let canceled = false;
    const refresh = async () => {
      try {
        const next = await activeClient.loadSnapshot(
          activeSelection,
          abort.signal,
        );
        if (!canceled) {
          setSnapshot((current) =>
            current.jobState === "CANCELED" && next.jobState !== "CANCELED"
              ? current
              : next,
          );
          setStatus("READY");
        }
      } catch {
        if (!canceled && !abort.signal.aborted) setStatus("UNAVAILABLE");
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => {
      canceled = true;
      abort.abort();
      window.clearInterval(interval);
    };
  }, [activeClient, activeSelection]);

  const handleIntent = async (intent: ObserverIntent) => {
    if (!activeSelection || cancellationState === "SUBMITTING") return;
    setCancellationState("SUBMITTING");
    setIntentError(null);
    try {
      const receipt = await activeClient.sendIntent(
        activeSelection,
        intent,
        snapshot.jobRevision,
      );
      if (intent === "CANCEL_AUTOMATION") {
        setSnapshot((current) => ({
          ...current,
          cancellationAcknowledgedAt: receipt.acknowledgedAt,
        }));
        setCancellationState(receipt.state);
      }
    } catch {
      setCancellationState("FAILED");
      setIntentError(
        "The request did not reach the paired desktop. Try again.",
      );
    }
  };

  return (
    <div className="observer-layout">
      <VillageShell />
      <div>
        <PairDesktopCard />
        {status !== "READY" ? (
          <p className="observer-connection" role="status">
            {status === "LOADING"
              ? "Loading paired desktop status..."
              : "Select an available browser session to supervise it."}
          </p>
        ) : null}
        {intentError ? <p role="alert">{intentError}</p> : null}
        <ObserverBrowserCard
          snapshot={snapshot}
          {...(activeSelection && status === "READY"
            ? {
                onIntent: (intent: ObserverIntent) => void handleIntent(intent),
              }
            : {})}
          cancellationState={cancellationState}
        />
      </div>
    </div>
  );
}
