import type {
  ApprovedRitualRevision,
  RitualStewardContext,
  RitualStewardResult,
  RitualTestReceipt,
  RitualTestRunControllerResult,
  RitualTestRunRequest,
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
    receipt: RitualTestReceipt | null;
  }>;
  createDraftIdentity(): Promise<RitualBuilderIdentity>;
  draft(context: RitualStewardContext): Promise<RitualStewardResult>;
  approve(ritual: ApprovedRitualRevision): Promise<ApprovedRitualRevision>;
  testRun(
    request: RitualTestRunRequest,
  ): Promise<RitualTestRunControllerResult>;
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
  const testRunInFlight = useRef(false);

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
          setState((current) => {
            const restored = reduceRitualBuilder(current, {
              type: "RESTORE_APPROVED",
              approved: initialized.approved!,
            });
            return initialized.receipt
              ? reduceRitualBuilder(restored, {
                  type: "RESTORE_RECEIPT",
                  receipt: initialized.receipt,
                })
              : restored;
          });
        }
      })
      .catch(() => {
        if (active) setStartupError("Your saved Rituals could not be opened.");
      });
    return () => {
      active = false;
      generation.current += 1;
      testRunInFlight.current = false;
    };
  }, [bridge]);

  const onEvent = (event: RitualBuilderEvent) => {
    if (!bridge || !identity) return;
    if (event.type === "START_NEW_RITUAL") {
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "STARTING_NEW_RITUAL") return;
      const requestGeneration = ++generation.current;
      void bridge
        .createDraftIdentity()
        .then((nextIdentity) => {
          if (generation.current !== requestGeneration) return;
          setIdentity(nextIdentity);
          setState((current) =>
            reduceRitualBuilder(current, { type: "NEW_RITUAL_READY" }),
          );
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, { type: "NEW_RITUAL_FAILED" }),
          );
        });
      return;
    }
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
    if (event.type === "SUBMIT_TEST_SAMPLE") {
      if (testRunInFlight.current) return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "RUNNING_TEST") return;
      testRunInFlight.current = true;
      const requestGeneration = ++generation.current;
      void bridge
        .testRun({
          schemaVersion: 1,
          ritualId: next.approved.ritualId,
          ritualRevision: next.approved.ritualRevision,
          sample: event.sample.trim(),
        })
        .then((result) => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            result.status === "receipt"
              ? reduceRitualBuilder(current, {
                  type: "TEST_RUN_RECEIPT",
                  receipt: result.receipt,
                })
              : reduceRitualBuilder(current, {
                  type: "TEST_RUN_FAILED",
                  message: testRunFailureCopy(result.reason),
                }),
          );
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "TEST_RUN_FAILED",
              message:
                "The safe test could not finish. Your sample was not saved; try again.",
            }),
          );
        })
        .finally(() => {
          testRunInFlight.current = false;
        });
      return;
    }
    setState((current) => reduceRitualBuilder(current, event));
  };

  if (startupError) return <p role="alert">{startupError}</p>;
  if (!identity) return <p role="status">Opening the Steward’s workroom…</p>;
  return <RitualBuilder identity={identity} state={state} onEvent={onEvent} />;
}

function testRunFailureCopy(
  reason: Extract<
    RitualTestRunControllerResult,
    { status: "waiting" }
  >["reason"],
): string {
  switch (reason) {
    case "AUTHENTICATION_REQUIRED":
      return "Sign in to ChatGPT in Village, then run the safe test again.";
    case "TIME_BUDGET_EXHAUSTED":
      return "The safe test took too long. Your sample was not saved; try again.";
    case "MALFORMED_PROVIDER_OUTPUT":
      return "The Steward returned a result Village could not safely validate. Try again.";
    case "STALE_STEWARD_RESULT":
      return "Village ignored an outdated test result. Try again.";
    case "PROVIDER_UNAVAILABLE":
      return "The local ChatGPT provider became unavailable. Try again.";
  }
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
