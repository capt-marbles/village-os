import type {
  ApprovedRitualRevision,
  RitualStewardContext,
  RitualStewardResult,
} from "@village/contracts";
import {
  RitualBuilder,
  createRitualBuilderState,
  reduceRitualBuilder,
  type RitualBuilderEvent,
  type RitualBuilderIdentity,
  type RitualBuilderState,
} from "@village/ui";
import { useEffect, useRef, useState } from "react";

export interface RitualBuilderBridge {
  initialize(): Promise<{
    identity: RitualBuilderIdentity;
    approved: ApprovedRitualRevision | null;
  }>;
  draft(context: RitualStewardContext): Promise<RitualStewardResult>;
  approve(ritual: ApprovedRitualRevision): Promise<ApprovedRitualRevision>;
}

declare global {
  interface Window {
    villageRitualBuilder?: RitualBuilderBridge;
  }
}

export function RitualBuilderWorkspace({
  bridge = globalThis.window?.villageRitualBuilder,
}: {
  bridge?: RitualBuilderBridge;
}) {
  const [identity, setIdentity] = useState<RitualBuilderIdentity | null>(null);
  const [state, setState] = useState<RitualBuilderState>(
    createRitualBuilderState,
  );
  const [startupError, setStartupError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!bridge) {
      setStartupError("The local Ritual service is unavailable.");
      return;
    }
    let active = true;
    void bridge
      .initialize()
      .then((initialized) => {
        if (!active) return;
        setIdentity(initialized.identity);
        if (initialized.approved) {
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "RESTORE_APPROVED",
              approved: initialized.approved!,
            }),
          );
        }
      })
      .catch(() => {
        if (active) setStartupError("Your saved Rituals could not be opened.");
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [bridge]);

  const onEvent = (event: RitualBuilderEvent) => {
    if (!bridge || !identity) return;
    if (event.type === "SUBMIT_PURPOSE") {
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "DRAFTING") return;
      const requestGeneration = ++generation.current;
      void bridge
        .draft({
          schemaVersion: 1,
          draftId: next.pendingDraftId,
          requestRevision: next.pendingRequestRevision,
          ownerPurpose: event.purpose.trim(),
        })
        .then((result) => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            result.status === "proposal"
              ? reduceRitualBuilder(current, {
                  type: "STEWARD_PROPOSED",
                  proposal: result,
                  occurredAt: new Date().toISOString(),
                })
              : reduceRitualBuilder(current, {
                  type: "STEWARD_FAILED",
                  message: providerFailureCopy(result.reason),
                }),
          );
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "STEWARD_FAILED",
              message: "The Steward could not shape the draft. Try again.",
            }),
          );
        });
      return;
    }
    if (event.type === "APPROVE") {
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase === "SAVING_APPROVAL") {
        void bridge
          .approve(next.pendingApproval)
          .then(() => {
            setState((latest) =>
              reduceRitualBuilder(latest, { type: "APPROVAL_SAVED" }),
            );
          })
          .catch(() => {
            setState((latest) =>
              reduceRitualBuilder(latest, { type: "APPROVAL_SAVE_FAILED" }),
            );
          });
      }
      return;
    }
    setState((current) => reduceRitualBuilder(current, event));
  };

  if (startupError) return <p role="alert">{startupError}</p>;
  if (!identity) return <p role="status">Opening the Steward’s workroom…</p>;
  return <RitualBuilder identity={identity} state={state} onEvent={onEvent} />;
}

function providerFailureCopy(
  reason: Extract<RitualStewardResult, { status: "waiting" }>["reason"],
): string {
  switch (reason) {
    case "AUTHENTICATION_REQUIRED":
      return "Sign in to ChatGPT in Village, then ask the Steward again.";
    case "TIME_BUDGET_EXHAUSTED":
      return "The Steward took too long to shape the draft. Try again.";
    case "MALFORMED_PROVIDER_OUTPUT":
      return "The Steward returned a draft Village could not safely validate. Try again.";
    case "STALE_STEWARD_RESULT":
      return "Village ignored an outdated Steward draft. Try again.";
    case "PROVIDER_UNAVAILABLE":
      return "The local ChatGPT provider became unavailable. Try again.";
  }
}
