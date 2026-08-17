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
  RitualSchedule,
  RitualSchedulePauseRequest,
  RitualScheduleUpdateRequest,
  RitualInboxItem,
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
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ExaApiKeyCard, type ExaCredentialBridge } from "./ExaApiKeyCard.js";
import { RitualAutomationPanel } from "./RitualAutomationPanel.js";

export interface RitualBuilderBridge extends ExaCredentialBridge {
  initialize(): Promise<{
    identity: RitualBuilderIdentity;
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
    run: RitualRun | null;
    runReceipt: RitualRunReceipt | null;
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }>;
  getAutomationState(): Promise<{
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }>;
  configureSchedule(
    request: RitualScheduleUpdateRequest,
  ): Promise<RitualSchedule>;
  pauseSchedule(request: RitualSchedulePauseRequest): Promise<RitualSchedule>;
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
  const [schedule, setSchedule] = useState<RitualSchedule | null>(null);
  const [inbox, setInbox] = useState<readonly RitualInboxItem[]>([]);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const generation = useRef(0);
  const draftInFlight = useRef(false);
  const testRunInFlight = useRef(false);
  const learningInFlight = useRef(false);
  const runInFlight = useRef(false);
  const cancelRunInFlight = useRef(false);
  const automationMutation = useRef(0);
  const automationInFlight = useRef(false);
  const mounted = useRef(true);
  const refreshAutomation = useCallback(async () => {
    if (!bridge) return;
    const mutation = automationMutation.current;
    const automation = await bridge.getAutomationState();
    if (!mounted.current || mutation !== automationMutation.current) return;
    setSchedule((current) =>
      sameScheduleRevision(current, automation.schedule)
        ? current
        : automation.schedule,
    );
    setInbox((current) =>
      sameInboxRevision(current, automation.inbox) ? current : automation.inbox,
    );
  }, [bridge]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      automationMutation.current += 1;
    };
  }, []);

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
        setSchedule(initialized.schedule ?? null);
        setInbox(initialized.inbox ?? []);
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
      draftInFlight.current = false;
      testRunInFlight.current = false;
      learningInFlight.current = false;
      runInFlight.current = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge || schedule?.state !== "ENABLED") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        if (active) await refreshAutomation();
      } catch {
        // The durable Run view remains usable; the next due-time refresh retries.
      } finally {
        if (active)
          timer = setTimeout(refresh, automationRefreshDelay(schedule));
      }
    };
    timer = setTimeout(refresh, automationRefreshDelay(schedule));
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [bridge, refreshAutomation, schedule]);

  const configureSchedule = (request: RitualScheduleUpdateRequest) => {
    if (!bridge || automationPending || automationInFlight.current) return;
    automationInFlight.current = true;
    const mutation = ++automationMutation.current;
    setAutomationPending(true);
    setAutomationError(null);
    void bridge
      .configureSchedule(request)
      .then((nextSchedule) => {
        if (mutation === automationMutation.current) setSchedule(nextSchedule);
      })
      .catch(() =>
        setAutomationError(
          "The schedule could not be saved. Review the time and try again.",
        ),
      )
      .finally(() => {
        if (mutation === automationMutation.current) {
          automationInFlight.current = false;
          setAutomationPending(false);
        }
      });
  };

  const pauseSchedule = () => {
    if (!bridge || !schedule || automationPending || automationInFlight.current)
      return;
    automationInFlight.current = true;
    const mutation = ++automationMutation.current;
    setAutomationPending(true);
    setAutomationError(null);
    void bridge
      .pauseSchedule({
        schemaVersion: 1,
        ritualId: schedule.ritualId,
        ritualRevision: schedule.ritualRevision,
      })
      .then((nextSchedule) => {
        if (mutation === automationMutation.current) setSchedule(nextSchedule);
      })
      .catch(() =>
        setAutomationError(
          "The schedule could not be paused. Try again before the next Run.",
        ),
      )
      .finally(() => {
        if (mutation === automationMutation.current) {
          automationInFlight.current = false;
          setAutomationPending(false);
        }
      });
  };

  const requestDraft = (
    next: Extract<RitualBuilderState, { phase: "DRAFTING" }>,
  ) => {
    if (!bridge || draftInFlight.current) return;
    draftInFlight.current = true;
    const requestGeneration = ++generation.current;
    const context: RitualStewardContext = {
      schemaVersion: 1,
      draftId: next.pendingDraftId,
      requestRevision: next.pendingRequestRevision,
      ownerPurpose: next.ownerPurpose,
      ...(next.starter ? { starter: next.starter } : {}),
      ...(next.clarifications.length
        ? { clarifications: [...next.clarifications] }
        : {}),
    };
    void bridge
      .draft(context)
      .then((result) => {
        if (generation.current !== requestGeneration) return;
        setState((current) => {
          if (result.status === "proposal") {
            return reduceRitualBuilder(current, {
              type: "STEWARD_PROPOSED",
              proposal: result,
              occurredAt: new Date().toISOString(),
            });
          }
          if (result.status === "question") {
            return reduceRitualBuilder(current, {
              type: "STEWARD_ASKED",
              question: result,
            });
          }
          return reduceRitualBuilder(current, {
            type: "STEWARD_FAILED",
            message: providerFailureCopy(result.reason),
          });
        });
      })
      .catch(() => {
        if (generation.current !== requestGeneration) return;
        setState((current) =>
          reduceRitualBuilder(current, {
            type: "STEWARD_FAILED",
            message: "The Steward could not shape the draft. Try again.",
          }),
        );
      })
      .finally(() => {
        draftInFlight.current = false;
      });
  };

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
    if (event.type === "SUBMIT_PURPOSE" || event.type === "SUBMIT_STARTER") {
      if (draftInFlight.current) return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "DRAFTING") return;
      requestDraft(next);
      return;
    }
    if (event.type === "ANSWER_CLARIFICATION") {
      if (draftInFlight.current) return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "DRAFTING") return;
      requestDraft(next);
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
          void refreshAutomation().catch(() => undefined);
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
          void refreshAutomation().catch(() => undefined);
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
          void refreshAutomation().catch(() => undefined);
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
          receiptId: next.source.receipt.receiptId,
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
          automationMutation.current += 1;
          setState((current) =>
            reduceRitualBuilder(current, { type: "LEARNING_SAVED" }),
          );
          void refreshAutomation().catch(() => undefined);
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
      stewardDesk={
        <RitualAutomationPanel
          approved={state.approved}
          schedule={schedule}
          inbox={inbox}
          pending={automationPending}
          error={automationError}
          onConfigure={configureSchedule}
          onPause={pauseSchedule}
        />
      }
      state={state}
      onEvent={onEvent}
      researchSetup={<ExaApiKeyCard bridge={bridge} />}
    />
  );
}

function sameScheduleRevision(
  left: RitualSchedule | null,
  right: RitualSchedule | null,
): boolean {
  return (
    left?.ritualId === right?.ritualId &&
    left?.ritualRevision === right?.ritualRevision &&
    left?.updatedAt === right?.updatedAt
  );
}

function sameInboxRevision(
  left: readonly RitualInboxItem[],
  right: readonly RitualInboxItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.run.runId === right[index]?.run.runId &&
        item.run.updatedAt === right[index]?.run.updatedAt &&
        item.receipt?.receiptId === right[index]?.receipt?.receiptId &&
        item.attention === right[index]?.attention,
    )
  );
}

function automationRefreshDelay(schedule: RitualSchedule): number {
  const untilDue = Date.parse(schedule.nextRunAt) - Date.now() + 1_000;
  if (untilDue <= 0) return 30_000;
  return Math.max(1_000, Math.min(untilDue, 15 * 60_000));
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
