import type {
  ApprovedRitualRevision,
  RitualStewardContext,
  RitualStewardResult,
  RitualStewardFollowUpRequest,
  RitualStewardFollowUpResult,
  RitualLearningApprovalRequest,
  RitualLearningFeedbackRequest,
  RitualLearningResult,
  RitualLearningDecisionRequest,
  RitualRunCancelRequest,
  RitualRunControllerResult,
  RitualRunRequest,
  RitualRunStepApprovalRequest,
  RitualSchedule,
  RitualSchedulePauseRequest,
  RitualScheduleUpdateRequest,
  RitualInboxItem,
  RitualTestRunControllerResult,
  RitualTestRunRequest,
  RitualAuditTimeline,
  RitualLatestSnapshot,
  RitualCatalog,
  RitualRevisionRestoreRequest,
} from "@village/contracts";
import {
  RitualBuilder,
  canRestoreRitualRevision,
  createRitualBuilderState,
  reduceRitualBuilder,
  type RitualBuilderEvent,
  type RitualBuilderIdentity,
  type RitualBuilderState,
  type RitualFollowUpMessage,
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
import {
  GmailConnectionCard,
  type GmailConnectionBridge,
} from "./GmailConnectionCard.js";
import { RitualAutomationPanel } from "./RitualAutomationPanel.js";

export interface RitualBuilderBridge
  extends ExaCredentialBridge, GmailConnectionBridge {
  initialize(): Promise<
    RitualLatestSnapshot & {
      identity: RitualBuilderIdentity;
      rituals: RitualCatalog;
      schedule: RitualSchedule | null;
      inbox: readonly RitualInboxItem[];
    }
  >;
  selectRitual(ritualId: string): Promise<
    RitualLatestSnapshot & {
      schedule: RitualSchedule | null;
      inbox: readonly RitualInboxItem[];
    }
  >;
  getRituals(): Promise<RitualCatalog>;
  getAutomationState(): Promise<{
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }>;
  getAuditTimeline(): Promise<RitualAuditTimeline>;
  configureSchedule(
    request: RitualScheduleUpdateRequest,
  ): Promise<RitualSchedule>;
  pauseSchedule(request: RitualSchedulePauseRequest): Promise<RitualSchedule>;
  createDraftIdentity(): Promise<RitualBuilderIdentity>;
  draft(context: RitualStewardContext): Promise<RitualStewardResult>;
  followUp(
    request: RitualStewardFollowUpRequest,
  ): Promise<RitualStewardFollowUpResult>;
  approve(ritual: ApprovedRitualRevision): Promise<ApprovedRitualRevision>;
  restoreRevision(
    request: RitualRevisionRestoreRequest,
  ): Promise<ApprovedRitualRevision>;
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
  decideLearning(request: RitualLearningDecisionRequest): Promise<void>;
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
  const [rituals, setRituals] = useState<RitualCatalog>([]);
  const [ritualSwitchPending, setRitualSwitchPending] = useState(false);
  const [ritualSwitchError, setRitualSwitchError] = useState<string | null>(
    null,
  );
  const [inbox, setInbox] = useState<readonly RitualInboxItem[]>([]);
  const [auditTimeline, setAuditTimeline] = useState<RitualAuditTimeline>([]);
  const [auditTimelineError, setAuditTimelineError] = useState<string | null>(
    null,
  );
  const [restoreRevisionPending, setRestoreRevisionPending] = useState(false);
  const [restoreRevisionError, setRestoreRevisionError] = useState<
    string | null
  >(null);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [draftInputDirty, setDraftInputDirty] = useState(false);
  const [followUpMessages, setFollowUpMessages] = useState<
    readonly RitualFollowUpMessage[]
  >([]);
  const [followUpPending, setFollowUpPending] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const selectedRitualId = state.approved?.ritualId ?? null;
  const hasUnsavedDraft =
    !state.approved && (draftInputDirty || state.phase !== "DESCRIBE_PURPOSE");
  const generation = useRef(0);
  const draftInFlight = useRef(false);
  const testRunInFlight = useRef(false);
  const learningInFlight = useRef(false);
  const runInFlight = useRef(false);
  const cancelRunInFlight = useRef(false);
  const automationMutation = useRef(0);
  const auditTimelineMutation = useRef(0);
  const ritualCatalogMutation = useRef(0);
  const restoreRevisionInFlight = useRef(false);
  const automationInFlight = useRef(false);
  const ritualSwitchInFlight = useRef(false);
  const activeFollowUp = useRef<string | null>(null);
  const mounted = useRef(true);
  const resetFollowUp = useCallback(() => {
    activeFollowUp.current = null;
    setFollowUpMessages([]);
    setFollowUpPending(false);
    setFollowUpError(null);
  }, []);
  const refreshAutomation = useCallback(async () => {
    if (!bridge || ritualSwitchInFlight.current) return;
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
  const refreshAuditTimeline = useCallback(async () => {
    if (!bridge || ritualSwitchInFlight.current) return;
    const mutation = ++auditTimelineMutation.current;
    try {
      const timeline = await bridge.getAuditTimeline();
      if (!mounted.current || mutation !== auditTimelineMutation.current)
        return;
      setAuditTimeline((current) =>
        sameAuditTimeline(current, timeline) ? current : timeline,
      );
      setAuditTimelineError(null);
    } catch {
      if (!mounted.current || mutation !== auditTimelineMutation.current)
        return;
      setAuditTimelineError(
        "Ritual history may be out of date. Refresh it before relying on the audit trail.",
      );
    }
  }, [bridge]);
  const refreshRituals = useCallback(async () => {
    if (!bridge) return;
    const mutation = ++ritualCatalogMutation.current;
    try {
      const catalog = await bridge.getRituals();
      if (!mounted.current || mutation !== ritualCatalogMutation.current)
        return;
      setRituals(catalog);
      setRitualSwitchError(null);
    } catch {
      if (!mounted.current || mutation !== ritualCatalogMutation.current)
        return;
      setRitualSwitchError(
        "The Ritual list may be out of date. Reopen the Steward desk to refresh it.",
      );
    }
  }, [bridge]);
  const restoreRevision = useCallback(
    async (restoreFromRevision: number): Promise<boolean> => {
      const current = state.approved;
      if (
        !bridge ||
        !current ||
        restoreRevisionInFlight.current ||
        restoreFromRevision >= current.ritualRevision
      ) {
        return false;
      }
      restoreRevisionInFlight.current = true;
      const requestGeneration = ++generation.current;
      setRestoreRevisionPending(true);
      setRestoreRevisionError(null);
      try {
        const restored = await bridge.restoreRevision({
          schemaVersion: 1,
          ritualId: current.ritualId,
          expectedCurrentRevision: current.ritualRevision,
          restoreFromRevision,
          restoredAt: new Date().toISOString(),
        });
        if (!mounted.current || requestGeneration !== generation.current) {
          return false;
        }
        resetFollowUp();
        setState((previous) =>
          reduceRitualBuilder(previous, {
            type: "REVISION_RESTORE_SAVED",
            approved: restored,
          }),
        );
        automationMutation.current += 1;
        await Promise.all([
          refreshAutomation().catch(() => {
            if (mounted.current) {
              setAutomationError(
                "The Ritual was restored, but schedule details may be out of date.",
              );
            }
          }),
          refreshAuditTimeline(),
          refreshRituals(),
        ]);
        return true;
      } catch {
        if (mounted.current && requestGeneration === generation.current) {
          setRestoreRevisionError(
            "Village could not restore that revision. Reopen Ritual Builder to refresh its current revision, then try again.",
          );
        }
        return false;
      } finally {
        restoreRevisionInFlight.current = false;
        if (mounted.current) setRestoreRevisionPending(false);
      }
    },
    [
      bridge,
      refreshAuditTimeline,
      refreshAutomation,
      refreshRituals,
      resetFollowUp,
      state.approved,
    ],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      automationMutation.current += 1;
      auditTimelineMutation.current += 1;
      ritualCatalogMutation.current += 1;
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
        setRituals(initialized.rituals ?? []);
        setSchedule(initialized.schedule ?? null);
        setInbox(initialized.inbox ?? []);
        setAuditTimeline(initialized.auditTimeline ?? []);
        setAuditTimelineError(null);
        setState(hydrateRitualSnapshot(initialized));
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

  const selectRitual = useCallback(
    async (ritualId: string) => {
      if (
        !bridge ||
        ritualId === selectedRitualId ||
        ritualSwitchInFlight.current
      )
        return;
      ritualSwitchInFlight.current = true;
      const requestGeneration = ++generation.current;
      automationMutation.current += 1;
      auditTimelineMutation.current += 1;
      setRitualSwitchPending(true);
      setRitualSwitchError(null);
      try {
        const snapshot = await bridge.selectRitual(ritualId);
        if (!mounted.current || requestGeneration !== generation.current)
          return;
        automationMutation.current += 1;
        auditTimelineMutation.current += 1;
        setState(hydrateRitualSnapshot(snapshot));
        setDraftInputDirty(false);
        resetFollowUp();
        setSchedule(snapshot.schedule);
        setInbox(snapshot.inbox);
        setAuditTimeline(snapshot.auditTimeline);
        setAutomationError(null);
        setAuditTimelineError(null);
      } catch {
        if (mounted.current && requestGeneration === generation.current)
          setRitualSwitchError(
            "Village could not open that Ritual. Try again after the current work settles.",
          );
      } finally {
        ritualSwitchInFlight.current = false;
        if (mounted.current) setRitualSwitchPending(false);
      }
    },
    [bridge, resetFollowUp, selectedRitualId],
  );

  const submitFollowUp = useCallback(
    (question: string) => {
      const current = state.approved;
      if (!bridge || !current || activeFollowUp.current) return;
      const requestId = createFollowUpId();
      const requestGeneration = generation.current;
      activeFollowUp.current = requestId;
      setFollowUpPending(true);
      setFollowUpError(null);
      setFollowUpMessages((messages) =>
        appendFollowUpMessage(messages, {
          id: `${requestId}-owner`,
          speaker: "OWNER",
          text: question,
        }),
      );
      void bridge
        .followUp({
          schemaVersion: 1,
          requestId,
          ritualId: current.ritualId,
          ritualRevision: current.ritualRevision,
          question,
        })
        .then((result) => {
          if (
            !mounted.current ||
            requestGeneration !== generation.current ||
            activeFollowUp.current !== requestId
          )
            return;
          if (result.status === "answer") {
            setFollowUpMessages((messages) =>
              appendFollowUpMessage(messages, {
                id: `${requestId}-steward`,
                speaker: "STEWARD",
                text: result.answer,
              }),
            );
            return;
          }
          setFollowUpError(followUpFailureCopy(result.reason));
        })
        .catch(() => {
          if (
            mounted.current &&
            requestGeneration === generation.current &&
            activeFollowUp.current === requestId
          ) {
            setFollowUpError(
              "The Steward could not answer that follow-up. Try again.",
            );
          }
        })
        .finally(() => {
          if (activeFollowUp.current === requestId) {
            activeFollowUp.current = null;
            if (mounted.current) setFollowUpPending(false);
          }
        });
    },
    [bridge, state.approved],
  );

  useEffect(() => {
    if (!bridge || schedule?.state !== "ENABLED") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        if (active) {
          await Promise.all([refreshAutomation(), refreshAuditTimeline()]);
        }
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
  }, [bridge, refreshAuditTimeline, refreshAutomation, schedule]);

  const configureSchedule = (request: RitualScheduleUpdateRequest) => {
    if (
      !bridge ||
      ritualSwitchInFlight.current ||
      automationPending ||
      automationInFlight.current
    )
      return;
    automationInFlight.current = true;
    const mutation = ++automationMutation.current;
    setAutomationPending(true);
    setAutomationError(null);
    void bridge
      .configureSchedule(request)
      .then((nextSchedule) => {
        if (mutation === automationMutation.current) setSchedule(nextSchedule);
      })
      .catch(() => {
        if (mutation === automationMutation.current)
          setAutomationError(
            "The schedule could not be saved. Review the time and try again.",
          );
      })
      .finally(() => {
        automationInFlight.current = false;
        if (mounted.current) setAutomationPending(false);
      });
  };

  const pauseSchedule = () => {
    if (
      !bridge ||
      !schedule ||
      ritualSwitchInFlight.current ||
      automationPending ||
      automationInFlight.current
    )
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
      .catch(() => {
        if (mutation === automationMutation.current)
          setAutomationError(
            "The schedule could not be paused. Try again before the next Run.",
          );
      })
      .finally(() => {
        automationInFlight.current = false;
        if (mounted.current) setAutomationPending(false);
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
    if (restoreRevisionInFlight.current) return;
    if (event.type === "START_NEW_RITUAL") {
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "STARTING_NEW_RITUAL") return;
      const requestGeneration = ++generation.current;
      void bridge
        .createDraftIdentity()
        .then((nextIdentity) => {
          if (generation.current !== requestGeneration) return;
          automationMutation.current += 1;
          auditTimelineMutation.current += 1;
          setSchedule(null);
          setInbox([]);
          setAutomationError(null);
          setAuditTimeline([]);
          setAuditTimelineError(null);
          resetFollowUp();
          setIdentity(nextIdentity);
          setDraftInputDirty(false);
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
            automationMutation.current += 1;
            setState((latest) =>
              reduceRitualBuilder(latest, { type: "APPROVAL_SAVED" }),
            );
            void refreshAutomation().catch(() => undefined);
            void refreshAuditTimeline();
            void refreshRituals();
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
          if (result.status === "receipt") {
            void refreshAuditTimeline();
          }
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
          if (result.status === "receipt") {
            void refreshAuditTimeline();
          }
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
          if (result.status === "receipt") {
            void refreshAuditTimeline();
          }
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
          generation.current += 1;
          resetFollowUp();
          automationMutation.current += 1;
          setState((current) =>
            reduceRitualBuilder(current, { type: "LEARNING_SAVED" }),
          );
          void refreshAutomation().catch(() => undefined);
          void refreshAuditTimeline();
          void refreshRituals();
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
    if (event.type === "REJECT_LEARNING" || event.type === "REVISE_LEARNING") {
      if (learningInFlight.current || state.phase !== "REVIEW_LEARNING") return;
      const next = reduceRitualBuilder(state, event);
      setState(next);
      if (next.phase !== "SAVING_LEARNING_DECISION") return;
      learningInFlight.current = true;
      const requestGeneration = ++generation.current;
      void bridge
        .decideLearning({
          schemaVersion: 1,
          proposalId: next.proposal.proposalId,
          ritualId: next.approved.ritualId,
          expectedFromRevision: next.approved.ritualRevision,
          decision: next.pendingDecision,
        })
        .then(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "LEARNING_DECISION_SAVED",
            }),
          );
          void refreshAuditTimeline();
        })
        .catch(() => {
          if (generation.current !== requestGeneration) return;
          setState((current) =>
            reduceRitualBuilder(current, {
              type: "LEARNING_DECISION_FAILED",
            }),
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
          rituals={rituals}
          selectedRitualId={selectedRitualId}
          switchDisabled={ritualSwitchPending || hasUnsavedDraft}
          switchError={ritualSwitchError}
          onSelectRitual={(ritualId) => void selectRitual(ritualId)}
          approved={state.approved}
          schedule={schedule}
          inbox={inbox}
          pending={automationPending || ritualSwitchPending}
          error={automationError}
          onConfigure={configureSchedule}
          onPause={pauseSchedule}
        />
      }
      state={state}
      onEvent={onEvent}
      onDraftDirtyChange={setDraftInputDirty}
      stewardFollowUp={{
        messages: followUpMessages,
        pending: followUpPending,
        error: followUpError,
        submit: submitFollowUp,
      }}
      auditTimeline={auditTimeline}
      auditTimelineError={auditTimelineError}
      onRefreshAuditTimeline={() => void refreshAuditTimeline()}
      {...(canRestoreRitualRevision(state)
        ? {
            revisionRestore: {
              pending: restoreRevisionPending,
              error: restoreRevisionError,
              submit: restoreRevision,
            },
          }
        : {})}
      researchSetup={
        <>
          <GmailConnectionCard bridge={bridge} />
          <ExaApiKeyCard bridge={bridge} />
        </>
      }
    />
  );
}

function hydrateRitualSnapshot(
  snapshot: RitualLatestSnapshot,
): RitualBuilderState {
  if (!snapshot.approved) return createRitualBuilderState();
  const restored = reduceRitualBuilder(createRitualBuilderState(), {
    type: "HYDRATE_APPROVED_REVISION",
    approved: snapshot.approved,
  });
  if (snapshot.learningReview) {
    return reduceRitualBuilder(restored, {
      type: "RESTORE_LEARNING_REVIEW",
      review: snapshot.learningReview,
    });
  }
  const withTestReceipt = snapshot.receipt
    ? reduceRitualBuilder(restored, {
        type: "RESTORE_RECEIPT",
        receipt: snapshot.receipt,
      })
    : restored;
  const withRun = snapshot.run
    ? reduceRitualBuilder(withTestReceipt, {
        type: "RESTORE_RUN",
        run: snapshot.run,
      })
    : withTestReceipt;
  return snapshot.runReceipt
    ? reduceRitualBuilder(withRun, {
        type: "RESTORE_RUN_RECEIPT",
        receipt: snapshot.runReceipt,
      })
    : withRun;
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

function sameAuditTimeline(
  left: RitualAuditTimeline,
  right: RitualAuditTimeline,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

const followUpIdAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const maximumFollowUpMessages = 20;

function appendFollowUpMessage(
  messages: readonly RitualFollowUpMessage[],
  message: RitualFollowUpMessage,
): readonly RitualFollowUpMessage[] {
  return [...messages, message].slice(-maximumFollowUpMessages);
}

function createFollowUpId(): RitualStewardFollowUpRequest["requestId"] {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `rfu_${[...bytes]
    .map((byte) => followUpIdAlphabet[byte & 31])
    .join("")}`;
}

function followUpFailureCopy(
  reason: Extract<RitualStewardFollowUpResult, { status: "waiting" }>["reason"],
): string {
  switch (reason) {
    case "AUTHENTICATION_REQUIRED":
      return "Connect ChatGPT before asking the Steward a follow-up.";
    case "TIME_BUDGET_EXHAUSTED":
      return "The Steward took too long to answer. Try a narrower question.";
    case "MALFORMED_PROVIDER_OUTPUT":
      return "The Steward returned an answer Village could not safely validate.";
    case "STALE_STEWARD_RESULT":
      return "That answer belonged to an older Ritual selection. Ask again.";
    case "PROVIDER_UNAVAILABLE":
      return "The Steward is unavailable. Try again shortly.";
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
