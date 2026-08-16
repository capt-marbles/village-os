import type {
  ApprovedRitualRevision,
  RitualStewardContext,
  RitualStewardResult,
  RitualLearningApprovalRequest,
  RitualLearningFeedbackRequest,
  RitualLearningResult,
  RitualRun,
  RitualRunCancelRequest,
  RitualRunControllerResult,
  RitualRunReceipt,
  RitualRunRequest,
  RitualRunStepApprovalRequest,
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
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ExaApiKeyCard, type ExaCredentialBridge } from "./ExaApiKeyCard.js";

export interface RitualBuilderBridge extends ExaCredentialBridge {
  initialize(): Promise<{
    identity: RitualBuilderIdentity;
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
    run: RitualRun | null;
    runReceipt: RitualRunReceipt | null;
  }>;
  createDraftIdentity(): Promise<RitualBuilderIdentity>;
  draft(context: RitualStewardContext): Promise<RitualStewardResult>;
  approve(ritual: ApprovedRitualRevision): Promise<ApprovedRitualRevision>;
  testRun(
    request: RitualTestRunRequest,
  ): Promise<RitualTestRunControllerResult>;
  startRun(request: RitualRunRequest): Promise<RitualRunControllerResult>;
  approveRunStep(
    request: RitualRunStepApprovalRequest,
  ): Promise<RitualRunControllerResult>;
  cancelRun(
    request: RitualRunCancelRequest,
  ): Promise<RitualRunControllerResult>;
  proposeLearning(
    request: RitualLearningFeedbackRequest,
  ): Promise<RitualLearningResult>;
  approveLearning(
    request: RitualLearningApprovalRequest,
  ): Promise<ApprovedRitualRevision>;
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
  const learningInFlight = useRef(false);
  const runInFlight = useRef(false);
  const cancelRunInFlight = useRef(false);

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
            const withTestReceipt = initialized.receipt
              ? reduceRitualBuilder(restored, {
                  type: "RESTORE_RECEIPT",
                  receipt: initialized.receipt,
                })
              : restored;
            const withRun = initialized.run
              ? reduceRitualBuilder(withTestReceipt, {
                  type: "RESTORE_RUN",
                  run: initialized.run,
                })
              : withTestReceipt;
            return initialized.runReceipt
              ? reduceRitualBuilder(withRun, {
                  type: "RESTORE_RUN_RECEIPT",
                  receipt: initialized.runReceipt,
                })
              : withRun;
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
      learningInFlight.current = false;
      runInFlight.current = false;
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
    if (event.type === "START_RUN") {
      if (runInFlight.current) return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "STARTING_RUN") return;
      runInFlight.current = true;
      const requestGeneration = ++generation.current;
      void bridge
        .startRun({
          schemaVersion: 1,
          ritualId: next.approved.ritualId,
          ritualRevision: next.approved.ritualRevision,
        })
        .then((result) => {
          if (generation.current !== requestGeneration) return;
          publishRunResult(setState, result);
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "RUN_COMMAND_FAILED",
              message:
                "Village could not confirm the local fixture Run. A local Run record may already exist and will be restored when you reopen this window.",
            }),
          );
        })
        .finally(() => {
          runInFlight.current = false;
        });
      return;
    }
    if (event.type === "APPROVE_RUN_STEP") {
      if (runInFlight.current || state.phase !== "RUN_WAITING_FOR_OWNER") {
        return;
      }
      const stepKey = state.run.currentStepKey;
      if (!stepKey) return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      runInFlight.current = true;
      const requestGeneration = ++generation.current;
      void bridge
        .approveRunStep({
          schemaVersion: 1,
          runId: state.run.runId,
          stepKey,
        })
        .then((result) => {
          if (generation.current !== requestGeneration) return;
          publishRunResult(setState, result);
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "RUN_COMMAND_FAILED",
              message:
                "Village could not record that approval. The Run did not advance.",
            }),
          );
        })
        .finally(() => {
          runInFlight.current = false;
        });
      return;
    }
    if (event.type === "CANCEL_RUN") {
      if (
        cancelRunInFlight.current ||
        (state.phase !== "STARTING_RUN" &&
          state.phase !== "RUNNING_RITUAL" &&
          state.phase !== "RUN_WAITING_FOR_OWNER" &&
          state.phase !== "RUN_WAITING_FOR_RESOURCE")
      ) {
        return;
      }
      const activeRun = state.run;
      if (!activeRun) return;
      const runId = activeRun.runId;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      cancelRunInFlight.current = true;
      const requestGeneration = ++generation.current;
      void bridge
        .cancelRun({ schemaVersion: 1, runId })
        .then((result) => {
          if (generation.current !== requestGeneration) return;
          publishRunResult(setState, result);
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "RUN_COMMAND_FAILED",
              message:
                "Village could not confirm cancellation. Review the restored Run state before retrying.",
            }),
          );
        })
        .finally(() => {
          cancelRunInFlight.current = false;
        });
      return;
    }
    if (event.type === "SUBMIT_FEEDBACK") {
      if (learningInFlight.current || state.phase !== "GIVE_FEEDBACK") return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "SHAPING_LEARNING") return;
      learningInFlight.current = true;
      const requestGeneration = ++generation.current;
      void bridge
        .proposeLearning({
          schemaVersion: 1,
          ritualId: next.approved.ritualId,
          ritualRevision: next.approved.ritualRevision,
          receiptId: next.receipt.receiptId,
          feedback: next.pendingFeedback,
        })
        .then((result) => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            result.status === "proposal"
              ? reduceRitualBuilder(current, {
                  type: "LEARNING_PROPOSED",
                  proposal: result,
                })
              : reduceRitualBuilder(current, {
                  type: "LEARNING_FAILED",
                  message: learningFailureCopy(result.reason),
                }),
          );
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "LEARNING_FAILED",
              message:
                "The Steward could not shape a safe revision. Nothing changed; try again.",
            }),
          );
        })
        .finally(() => {
          learningInFlight.current = false;
        });
      return;
    }
    if (event.type === "APPROVE_LEARNING") {
      if (learningInFlight.current) return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "SAVING_LEARNING") return;
      learningInFlight.current = true;
      void bridge
        .approveLearning({
          schemaVersion: 1,
          proposalId: next.proposal.proposalId,
          ritualId: next.approved.ritualId,
          expectedFromRevision: next.approved.ritualRevision,
          approvedAt: next.pendingRevision.approvedAt,
        })
        .then(() => {
          setState((current) =>
            reduceRitualBuilder(current, { type: "LEARNING_SAVED" }),
          );
        })
        .catch(() => {
          setState((current) =>
            reduceRitualBuilder(current, { type: "LEARNING_SAVE_FAILED" }),
          );
        })
        .finally(() => {
          learningInFlight.current = false;
        });
      return;
    }
    setState((current) => reduceRitualBuilder(current, event));
  };

  if (startupError) return <p role="alert">{startupError}</p>;
  if (!bridge || !identity)
    return <p role="status">Opening the Steward’s workroom…</p>;
  return (
    <RitualBuilder
      identity={identity}
      state={state}
      onEvent={onEvent}
      researchSetup={<ExaApiKeyCard bridge={bridge} />}
    />
  );
}

function publishRunResult(
  setState: Dispatch<SetStateAction<RitualBuilderState>>,
  result: RitualRunControllerResult,
): void {
  setState((current) =>
    result.status === "receipt"
      ? reduceRitualBuilder(current, {
          type: "RUN_RECEIPT",
          run: result.run,
          receipt: result.receipt,
        })
      : reduceRitualBuilder(current, {
          type: "RUN_UPDATED",
          run: result.run,
        }),
  );
}

function learningFailureCopy(
  reason: Extract<RitualLearningResult, { status: "waiting" }>["reason"],
): string {
  switch (reason) {
    case "AUTHENTICATION_REQUIRED":
      return "Sign in to ChatGPT in Village, then ask the Steward again.";
    case "TIME_BUDGET_EXHAUSTED":
      return "The Steward took too long to shape the revision. Nothing changed; try again.";
    case "MALFORMED_PROVIDER_OUTPUT":
      return "The Steward returned a revision Village could not safely validate. Nothing changed.";
    case "STALE_STEWARD_RESULT":
      return "Village ignored an outdated learning proposal. Nothing changed; try again.";
    case "PROVIDER_UNAVAILABLE":
      return "The local ChatGPT provider became unavailable. Nothing changed; try again.";
  }
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
