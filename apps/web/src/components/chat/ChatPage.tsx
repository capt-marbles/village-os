import {
  VillageShell,
  type BrowserUiAction,
  type ObserverCancellationState,
} from "@village/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { ObserverBrowserCard } from "../browser/ObserverBrowserCard.js";
import { PairDesktopCard } from "../browser/PairDesktopCard.js";
import { ContinuitySetupCard } from "../browser/ContinuitySetupCard.js";
import { VillageIdentityGate } from "../identity/VillageIdentityGate.js";
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
  const [attentionPending, setAttentionPending] = useState(false);
  const [attentionStatus, setAttentionStatus] = useState<string | null>(null);
  const attentionInFlight = useRef(false);

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

  const requestAttention = async () => {
    if (!activeSelection || attentionInFlight.current) return;
    attentionInFlight.current = true;
    setAttentionPending(true);
    setAttentionStatus(null);
    try {
      await activeClient.requestDesktopAttention(activeSelection);
      setAttentionStatus("Notification queued for the paired Mac.");
    } catch {
      setAttentionStatus("Village could not notify the paired Mac. Try again.");
    } finally {
      attentionInFlight.current = false;
      setAttentionPending(false);
    }
  };

  return (
    <div className="observer-layout">
      <VillageShell />
      <div>
        <VillageIdentityGate>
          <PairDesktopCard />
          <ContinuitySetupCard />
        </VillageIdentityGate>
        {status !== "READY" ? (
          <p className="observer-connection" role="status">
            {status === "LOADING"
              ? "Loading paired desktop status..."
              : "Select an available browser session to supervise it."}
          </p>
        ) : null}
        {intentError ? <p role="alert">{intentError}</p> : null}
        {attentionStatus ? <p role="status">{attentionStatus}</p> : null}
        <ObserverBrowserCard
          snapshot={snapshot}
          {...(activeSelection && status === "READY"
            ? {
                onIntent: (intent: ObserverIntent) => void handleIntent(intent),
                onRequestAttention: () => void requestAttention(),
              }
            : {})}
          cancellationState={cancellationState}
          attentionPending={attentionPending}
        />
      </div>
    </div>
  );
}
