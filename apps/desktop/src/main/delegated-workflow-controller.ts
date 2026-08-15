import {
  type AutomationSyncResponse,
  isSetupCommandAllowedForStep,
  setupObservationSchema,
  validateSetupModelProviderResult,
  type OwnedFixtureSetupCommand,
} from "@village/contracts";
import {
  isWorkflowJournalEntry,
  type ActionJournal,
  type WorkflowActionJournalEntry,
} from "../browser/action-journal.js";
import { LocalActionExecutor } from "../browser/local-action-executor.js";

export type SetupLogicalStep =
  "SET_DISPLAY_NAME" | "SELECT_ROLE" | "SET_PREFERRED_FOCUS" | "FINALIZE_SETUP";

export interface WorkflowRuntimeBinding {
  principalId: string;
  deviceId: string;
  jobId: string;
  browserSessionId: string;
  objective: {
    kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1";
    version: 1;
  };
  jobRevision: number;
  logicalStep: SetupLogicalStep;
  effectId: string;
  leaseEpoch: number;
}

export interface CoordinatorSnapshot extends WorkflowRuntimeBinding {
  authenticated: boolean;
  cursor: number;
  connection: "ONLINE" | "OFFLINE";
  controller: "AGENT" | "USER" | "NONE";
  automationBlocked: boolean;
  canceled: boolean;
  completedEffects: readonly {
    logicalStep: SetupLogicalStep;
    effectId: string;
  }[];
  actionPhase:
    | "ACCEPTED"
    | "DISPATCHED"
    | "EFFECT_OBSERVED"
    | "RECEIPTED"
    | "RECONCILIATION_REQUIRED";
  outstandingAction: {
    actionId: string;
    logicalStep: SetupLogicalStep;
    effectId: string;
    leaseEpoch: number;
    capability?: OwnedFixtureSetupCommand["capability"];
  } | null;
}

export interface AuthenticatedWorkflowCoordinator {
  synchronize(input: {
    principalId: string;
    deviceId: string;
    jobId: string;
    browserSessionId: string;
    cursor: number;
  }): Promise<CoordinatorSnapshot>;
  acceptAction(
    input: WorkflowRuntimeBinding & {
      actionId: string;
      command: OwnedFixtureSetupCommand;
    },
  ): Promise<
    { ok: true; actionId: string; cursor: number } | { ok: false; code: string }
  >;
  recordReceipt(input: {
    receipt: Record<string, unknown>;
    checkpoint: Record<string, unknown>;
  }): Promise<{ ok: true; cursor: number } | { ok: false; code: string }>;
  recordOwnerProgress?(
    input: WorkflowRuntimeBinding & {
      cursor: number;
      actor: "OWNER";
      actionPhase: CoordinatorSnapshot["actionPhase"];
      occurredAt: string;
    },
  ): Promise<{ ok: true; cursor: number } | { ok: false; code: string }>;
  claimFreshLease(input: {
    principalId: string;
    deviceId: string;
    jobId: string;
    browserSessionId: string;
    afterLeaseEpoch: number;
    cursor: number;
  }): Promise<
    | { ok: true; leaseEpoch: number; cursor: number }
    | { ok: false; code: string }
  >;
  takeover?(input: {
    principalId: string;
    deviceId: string;
    jobId: string;
    browserSessionId: string;
    expectedLeaseEpoch: number;
    cursor: number;
  }): Promise<
    | { ok: true; leaseEpoch: number; cursor: number }
    | { ok: false; code: string }
  >;
}

export interface AuthenticatedAutomationFence {
  synchronize(input: {
    principalId: string;
    deviceId: string;
    browserSessionId: string;
  }): Promise<AutomationSyncResponse>;
}

type SetupObservation = ReturnType<typeof setupObservationSchema.parse>;

export interface OwnedFixtureRuntime {
  captureOwnerState?(
    binding: WorkflowRuntimeBinding,
  ): Promise<SetupObservation>;
  observe(binding: WorkflowRuntimeBinding): Promise<SetupObservation>;
  execute(
    input: WorkflowRuntimeBinding & {
      actionId: string;
      command: OwnedFixtureSetupCommand;
    },
  ): Promise<{
    postcondition: "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN";
  }>;
}

type ProviderResult = Parameters<typeof validateSetupModelProviderResult>[1];
type ProviderContext = Parameters<typeof validateSetupModelProviderResult>[0];

export interface DelegatedWorkflowControllerOptions {
  binding: WorkflowRuntimeBinding;
  coordinator: AuthenticatedWorkflowCoordinator;
  automationFence: AuthenticatedAutomationFence;
  fixture: OwnedFixtureRuntime;
  journal: ActionJournal;
  provider(context: ProviderContext): Promise<ProviderResult>;
  createActionId(): string;
  createReceiptId(): string;
  createCheckpointId(): string;
  now?: () => number;
  budgets?: {
    maxReconciliations: number;
    maxProviderTurns: number;
    maxDurationMs: number;
  };
}

export type WorkflowRuntimeResult =
  | { status: "RECEIPTED"; actionId: string; effectId: string }
  | { status: "OWNER_STATE_ACCEPTED"; leaseEpoch: number }
  | {
      status: "OWNER_CONTROL";
      outcome: "QUIESCED" | "OUTCOME_UNKNOWN";
      coordinatorSynchronized: boolean;
    }
  | {
      status: "FENCED";
      reason: "COORDINATOR_UNAVAILABLE" | "AUTOMATION_UNAVAILABLE" | "CANCELED";
    }
  | {
      status: "WAITING_FOR_USER";
      reason:
        | "STALE_PROVIDER_RESULT"
        | "INVALID_OWNER_EDIT"
        | "HUMAN_GATE_REQUIRED"
        | "OUTCOME_UNKNOWN"
        | "JOURNAL_CORRUPT"
        | "RECONCILIATION_BUDGET_EXHAUSTED"
        | "TURN_BUDGET_EXHAUSTED"
        | "TIME_BUDGET_EXHAUSTED"
        | "AUTHENTICATION_REQUIRED"
        | "PROVIDER_UNAVAILABLE"
        | "MALFORMED_PROVIDER_OUTPUT"
        | "NO_SAFE_ACTION"
        | "SITE_POLICY_DENIED"
        | "NON_CONVERGENT";
      gate?: string;
    };

const mutationCapability: Record<
  SetupLogicalStep,
  OwnedFixtureSetupCommand["capability"]
> = {
  SET_DISPLAY_NAME: "REPLACE_DISPLAY_NAME",
  SELECT_ROLE: "SELECT_ROLE",
  SET_PREFERRED_FOCUS: "REPLACE_PREFERRED_FOCUS",
  FINALIZE_SETUP: "FINALIZE_SETUP",
};

export function postconditionFor(
  observation: SetupObservation,
): "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN" {
  const fact = observation.facts.find(
    (candidate) => candidate.id !== "HUMAN_GATE",
  );
  if (!fact) return "UNKNOWN";
  if (
    (fact.id === "FINALIZATION_STATE" && fact.value === "FINALIZED") ||
    (fact.id !== "FINALIZATION_STATE" && fact.value === "MATCH")
  ) {
    return "SATISFIED";
  }
  if (
    (fact.id === "FINALIZATION_STATE" && fact.value === "NOT_FINALIZED") ||
    (fact.id !== "FINALIZATION_STATE" &&
      (fact.value === "MISSING" ||
        fact.value === "MISMATCH" ||
        fact.value === "INVALID"))
  ) {
    return "NOT_SATISFIED";
  }
  return "UNKNOWN";
}

function ownerFieldIsInvalid(observation: SetupObservation): boolean {
  return observation.facts.some(
    (fact) =>
      fact.id !== "HUMAN_GATE" &&
      fact.id !== "FINALIZATION_STATE" &&
      (fact.value === "MISSING" || fact.value === "INVALID"),
  );
}

function humanGate(observation: SetupObservation): string | undefined {
  const gate = observation.facts.find((fact) => fact.id === "HUMAN_GATE");
  return gate?.id === "HUMAN_GATE" && gate.value !== "NONE"
    ? gate.value
    : undefined;
}

export class DelegatedWorkflowController {
  private binding: WorkflowRuntimeBinding;
  private cursor = 0;
  private generation = 0;
  private providerTurns = 0;
  private reconciliations = 0;
  private completedEffects: readonly {
    logicalStep: SetupLogicalStep;
    effectId: string;
  }[] = [];
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly budgets: NonNullable<
    DelegatedWorkflowControllerOptions["budgets"]
  >;
  private readonly executor: LocalActionExecutor;

  constructor(private readonly options: DelegatedWorkflowControllerOptions) {
    this.binding = { ...options.binding };
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.budgets = options.budgets ?? {
      maxReconciliations: 3,
      maxProviderTurns: 8,
      maxDurationMs: 120_000,
    };
    this.executor = new LocalActionExecutor({
      leaseEpoch: this.binding.leaseEpoch,
    });
  }

  async journalEntries() {
    return this.options.journal.read();
  }

  takeoverOffline(): void {
    this.generation += 1;
    this.executor.markOfflineTakeover();
  }

  async takeover(timeoutMs: number): Promise<WorkflowRuntimeResult> {
    this.generation += 1;
    const expectedLeaseEpoch = this.binding.leaseEpoch + 1;
    const local = this.executor.beginOnlineTakeover(
      expectedLeaseEpoch,
      timeoutMs,
    );
    const outcome = await local;
    let coordinatorSynchronized = false;
    try {
      const result = await this.options.coordinator.takeover?.({
        principalId: this.binding.principalId,
        deviceId: this.binding.deviceId,
        jobId: this.binding.jobId,
        browserSessionId: this.binding.browserSessionId,
        expectedLeaseEpoch: this.binding.leaseEpoch,
        cursor: this.cursor,
      });
      if (result?.ok && result.leaseEpoch >= expectedLeaseEpoch) {
        coordinatorSynchronized = true;
        this.cursor = result.cursor;
        this.binding = { ...this.binding, leaseEpoch: result.leaseEpoch };
      }
    } catch {
      // Local owner control remains available while coordinator sync is down.
    }
    if (!coordinatorSynchronized) {
      this.binding = { ...this.binding, leaseEpoch: expectedLeaseEpoch };
    }
    return {
      status: "OWNER_CONTROL",
      outcome: outcome.status,
      coordinatorSynchronized,
    };
  }

  cancelFutureAutomation(): void {
    this.generation += 1;
    this.executor.markOfflineTakeover();
  }

  async runOnce(): Promise<WorkflowRuntimeResult> {
    const budget = this.budgetResult();
    if (budget) return budget;
    const synchronized = await this.synchronize();
    if (!synchronized.ok) return synchronized.result;
    const availability = this.availability(synchronized.snapshot);
    if (availability) return availability;

    const observed = await this.observe(synchronized.snapshot);
    if ("status" in observed) return observed;
    if (postconditionFor(observed.observation) === "SATISFIED") {
      return this.verifyAndReceiptSatisfiedStep();
    }

    if (this.providerTurns >= this.budgets.maxProviderTurns) {
      return { status: "WAITING_FOR_USER", reason: "TURN_BUDGET_EXHAUSTED" };
    }
    this.providerTurns += 1;
    const generation = this.generation;
    const context = this.providerContext(observed.observation);
    const rawResult = await this.options.provider(context);
    const result = validateSetupModelProviderResult(context, rawResult);
    if (generation !== this.generation) {
      return { status: "WAITING_FOR_USER", reason: "STALE_PROVIDER_RESULT" };
    }
    const current = await this.synchronize();
    if (!current.ok) return current.result;
    if (result.status === "waiting") {
      if (result.reason === "HUMAN_GATE_REQUIRED") {
        return { status: "WAITING_FOR_USER", reason: "HUMAN_GATE_REQUIRED" };
      }
      return { status: "WAITING_FOR_USER", reason: result.reason };
    }
    if (!this.matchesCurrentResult(result, current.snapshot)) {
      return { status: "WAITING_FOR_USER", reason: "STALE_PROVIDER_RESULT" };
    }
    const currentAvailability = this.availability(current.snapshot);
    if (currentAvailability) return currentAvailability;
    return this.acceptAndExecute(result.command);
  }

  async reconcile(): Promise<WorkflowRuntimeResult> {
    if (this.reconciliations >= this.budgets.maxReconciliations) {
      return {
        status: "WAITING_FOR_USER",
        reason: "RECONCILIATION_BUDGET_EXHAUSTED",
      };
    }
    this.reconciliations += 1;
    const synchronized = await this.synchronize();
    if (!synchronized.ok) return synchronized.result;
    const availability = this.availability(synchronized.snapshot);
    if (availability) return availability;

    let entries;
    try {
      entries = (await this.options.journal.read()).filter(
        isWorkflowJournalEntry,
      );
    } catch {
      this.executor.markOfflineTakeover();
      return { status: "WAITING_FOR_USER", reason: "JOURNAL_CORRUPT" };
    }
    const outstanding = synchronized.snapshot.outstandingAction;
    if (!outstanding) {
      return this.runOnce();
    }
    if (
      outstanding.logicalStep !== synchronized.snapshot.logicalStep ||
      outstanding.effectId !== synchronized.snapshot.effectId ||
      outstanding.leaseEpoch !== synchronized.snapshot.leaseEpoch
    ) {
      return { status: "WAITING_FOR_USER", reason: "OUTCOME_UNKNOWN" };
    }
    const evidence = entries.filter(
      (entry) =>
        entry.jobId === this.binding.jobId &&
        entry.browserSessionId === this.binding.browserSessionId &&
        entry.logicalStep === outstanding.logicalStep &&
        entry.effectId === outstanding.effectId,
    );
    if (evidence.some((entry) => entry.phase === "RECEIPTED")) {
      return {
        status: "RECEIPTED",
        actionId: outstanding.actionId,
        effectId: outstanding.effectId,
      };
    }
    const observed = await this.observe(synchronized.snapshot);
    if ("status" in observed) return observed;
    const postcondition = postconditionFor(observed.observation);
    if (postcondition === "SATISFIED") {
      if (!evidence.some((entry) => entry.phase === "EFFECT_OBSERVED")) {
        await this.record(outstanding.actionId, "EFFECT_OBSERVED", "SATISFIED");
      }
      return this.receipt(outstanding.actionId, observed.observation);
    }
    const dispatched = evidence.some(
      (entry) =>
        entry.phase === "DISPATCHED" || entry.phase === "EFFECT_OBSERVED",
    );
    if (
      synchronized.snapshot.logicalStep === "FINALIZE_SETUP" &&
      (dispatched || synchronized.snapshot.actionPhase !== "ACCEPTED")
    ) {
      return { status: "WAITING_FOR_USER", reason: "OUTCOME_UNKNOWN" };
    }
    if (dispatched) {
      return this.acceptAndExecute({
        capability: mutationCapability[synchronized.snapshot.logicalStep],
      });
    }
    return this.executeAccepted(outstanding.actionId, {
      capability:
        outstanding.capability ?? mutationCapability[this.binding.logicalStep],
    });
  }

  reconciliationCount(): number {
    return this.reconciliations;
  }

  async handBack(): Promise<WorkflowRuntimeResult> {
    const synchronized = await this.synchronize(false);
    if (!synchronized.ok) return synchronized.result;
    if (synchronized.snapshot.canceled) {
      return { status: "FENCED", reason: "CANCELED" };
    }
    let ownerObservation: SetupObservation | undefined;
    if (this.options.fixture.captureOwnerState) {
      try {
        ownerObservation = await this.options.fixture.captureOwnerState(
          this.binding,
        );
      } catch {
        return { status: "WAITING_FOR_USER", reason: "INVALID_OWNER_EDIT" };
      }
    }
    const observation = ownerObservation
      ? { observation: ownerObservation }
      : await this.observe(synchronized.snapshot);
    if ("status" in observation) return observation;
    if (ownerFieldIsInvalid(observation.observation)) {
      return { status: "WAITING_FOR_USER", reason: "INVALID_OWNER_EDIT" };
    }
    let ownerProgress;
    try {
      ownerProgress = await this.options.coordinator.recordOwnerProgress?.({
        ...this.binding,
        cursor: this.cursor,
        actor: "OWNER",
        actionPhase: synchronized.snapshot.actionPhase,
        occurredAt: new Date(this.now()).toISOString(),
      });
    } catch {
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    if (!ownerProgress?.ok || ownerProgress.cursor <= this.cursor) {
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    this.cursor = ownerProgress.cursor;
    let lease;
    try {
      lease = await this.options.coordinator.claimFreshLease({
        principalId: this.binding.principalId,
        deviceId: this.binding.deviceId,
        jobId: this.binding.jobId,
        browserSessionId: this.binding.browserSessionId,
        afterLeaseEpoch: this.binding.leaseEpoch,
        cursor: this.cursor,
      });
      if (!lease.ok || lease.leaseEpoch <= this.binding.leaseEpoch) {
        return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
      }
    } catch {
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    this.executor.reconcileAgentLease(lease.leaseEpoch);
    this.binding = { ...this.binding, leaseEpoch: lease.leaseEpoch };
    this.cursor = lease.cursor;
    return { status: "OWNER_STATE_ACCEPTED", leaseEpoch: lease.leaseEpoch };
  }

  private async acceptAndExecute(
    command: OwnedFixtureSetupCommand,
  ): Promise<WorkflowRuntimeResult> {
    if (!isSetupCommandAllowedForStep(this.binding.logicalStep, command)) {
      return { status: "WAITING_FOR_USER", reason: "NON_CONVERGENT" };
    }
    const actionId = this.options.createActionId();
    try {
      const accepted = await this.options.coordinator.acceptAction({
        ...this.binding,
        actionId,
        command,
      });
      if (!accepted.ok || accepted.actionId !== actionId) {
        return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
      }
      this.cursor = accepted.cursor;
    } catch {
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    await this.record(actionId, "ACCEPTED", "UNOBSERVED");
    return this.executeAccepted(actionId, command);
  }

  private async verifyAndReceiptSatisfiedStep(): Promise<WorkflowRuntimeResult> {
    const actionId = this.options.createActionId();
    try {
      const accepted = await this.options.coordinator.acceptAction({
        ...this.binding,
        actionId,
        command: { capability: "VERIFY_SETUP" },
      });
      if (!accepted.ok || accepted.actionId !== actionId) {
        return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
      }
      this.cursor = accepted.cursor;
    } catch {
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    await this.record(actionId, "ACCEPTED", "UNOBSERVED", "READ_ONLY");
    await this.record(actionId, "DISPATCHED", "UNOBSERVED", "READ_ONLY");
    const observed = await this.observe(this.binding);
    if ("status" in observed) return observed;
    const postcondition = postconditionFor(observed.observation);
    if (postcondition !== "SATISFIED") {
      await this.record(
        actionId,
        "RECONCILIATION_REQUIRED",
        postcondition,
        "READ_ONLY",
      );
      return {
        status: "WAITING_FOR_USER",
        reason:
          postcondition === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "NON_CONVERGENT",
      };
    }
    await this.record(actionId, "EFFECT_OBSERVED", "SATISFIED", "READ_ONLY");
    return this.receipt(actionId, observed.observation, "READ_ONLY");
  }

  private async executeAccepted(
    actionId: string,
    command: OwnedFixtureSetupCommand,
  ): Promise<WorkflowRuntimeResult> {
    const remoteFence = await this.refreshAutomationFence();
    if (remoteFence) return remoteFence;
    const mutationClass =
      this.binding.logicalStep === "FINALIZE_SETUP"
        ? "NON_IDEMPOTENT"
        : "IDEMPOTENT";
    let operationPostcondition: "SATISFIED" | "NOT_SATISFIED" | "UNKNOWN";
    try {
      operationPostcondition = await this.executor.execute({
        actionId,
        leaseEpoch: this.binding.leaseEpoch,
        mutationClass,
        run: async () => {
          await this.record(actionId, "DISPATCHED", "UNOBSERVED");
          const result = await this.options.fixture.execute({
            ...this.binding,
            actionId,
            command,
          });
          return result.postcondition;
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ["AUTOMATION_BLOCKED", "STALE_LEASE_EPOCH"].includes(error.message)
      ) {
        return { status: "FENCED", reason: "AUTOMATION_UNAVAILABLE" };
      }
      await this.record(actionId, "RECONCILIATION_REQUIRED", "UNKNOWN");
      return { status: "WAITING_FOR_USER", reason: "OUTCOME_UNKNOWN" };
    }
    const observed = await this.observe(this.binding);
    if ("status" in observed) return observed;
    const livePostcondition = postconditionFor(observed.observation);
    if (
      operationPostcondition === "UNKNOWN" ||
      livePostcondition === "UNKNOWN"
    ) {
      await this.record(actionId, "RECONCILIATION_REQUIRED", "UNKNOWN");
      return { status: "WAITING_FOR_USER", reason: "OUTCOME_UNKNOWN" };
    }
    if (livePostcondition !== "SATISFIED") {
      await this.record(actionId, "RECONCILIATION_REQUIRED", livePostcondition);
      return { status: "WAITING_FOR_USER", reason: "NON_CONVERGENT" };
    }
    await this.record(actionId, "EFFECT_OBSERVED", "SATISFIED");
    return this.receipt(actionId, observed.observation);
  }

  private async receipt(
    actionId: string,
    observation: SetupObservation,
    mutationClass?: WorkflowActionJournalEntry["mutationClass"],
  ): Promise<WorkflowRuntimeResult> {
    const now = new Date(this.now()).toISOString();
    const receiptId = this.options.createReceiptId();
    const predicateVersion = observation.predicateIds[0]!;
    try {
      const recorded = await this.options.coordinator.recordReceipt({
        receipt: {
          receiptId,
          principalId: this.binding.principalId,
          deviceId: this.binding.deviceId,
          jobId: this.binding.jobId,
          browserSessionId: this.binding.browserSessionId,
          actionId,
          stepId: `bsp_${actionId.slice(4)}`,
          objective: this.binding.objective,
          jobRevision: this.binding.jobRevision,
          logicalStep: this.binding.logicalStep,
          effectId: this.binding.effectId,
          leaseEpoch: this.binding.leaseEpoch,
          outcome: "POSTCONDITION_SATISFIED",
          predicateIds: observation.predicateIds,
          recordedAt: now,
        },
        checkpoint: {
          checkpointId: this.options.createCheckpointId(),
          principalId: this.binding.principalId,
          deviceId: this.binding.deviceId,
          jobId: this.binding.jobId,
          browserSessionId: this.binding.browserSessionId,
          jobRevision: this.binding.jobRevision,
          eventSequence: this.cursor + 1,
          state:
            this.binding.logicalStep === "FINALIZE_SETUP"
              ? "SUCCEEDED"
              : "RUNNING_AGENT",
          objective: this.binding.objective,
          site: "OWNED_FIXTURE",
          currentStep: this.binding.logicalStep,
          currentEffectId: this.binding.effectId,
          completedEffects: [
            ...this.completedEffects.filter(
              (effect) => effect.logicalStep !== this.binding.logicalStep,
            ),
            {
              logicalStep: this.binding.logicalStep,
              effectId: this.binding.effectId,
            },
          ],
          outstandingAction: null,
          lastPredicateVersion: predicateVersion,
          actionPhase: "RECEIPTED",
          reconciliation: "NONE",
          createdAt: now,
        },
      });
      if (!recorded.ok) {
        throw new Error(recorded.code);
      }
      this.cursor = recorded.cursor;
    } catch {
      await this.record(actionId, "RECONCILIATION_REQUIRED", "SATISFIED");
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    await this.record(actionId, "RECEIPTED", "SATISFIED", mutationClass);
    return { status: "RECEIPTED", actionId, effectId: this.binding.effectId };
  }

  private async synchronize(
    requireAutomation = true,
  ): Promise<
    | { ok: true; snapshot: CoordinatorSnapshot }
    | { ok: false; result: WorkflowRuntimeResult }
  > {
    if (requireAutomation) {
      const remoteFence = await this.refreshAutomationFence();
      if (remoteFence) return { ok: false, result: remoteFence };
    }
    let snapshot: CoordinatorSnapshot;
    try {
      snapshot = await this.options.coordinator.synchronize({
        principalId: this.binding.principalId,
        deviceId: this.binding.deviceId,
        jobId: this.binding.jobId,
        browserSessionId: this.binding.browserSessionId,
        cursor: this.cursor,
      });
    } catch {
      return {
        ok: false,
        result: { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" },
      };
    }
    if (
      snapshot.authenticated !== true ||
      snapshot.principalId !== this.binding.principalId ||
      snapshot.deviceId !== this.binding.deviceId ||
      snapshot.jobId !== this.binding.jobId ||
      snapshot.browserSessionId !== this.binding.browserSessionId ||
      snapshot.objective.kind !== this.binding.objective.kind ||
      snapshot.objective.version !== this.binding.objective.version ||
      snapshot.cursor < this.cursor
    ) {
      this.executor.markOfflineTakeover();
      return {
        ok: false,
        result: { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" },
      };
    }
    this.cursor = snapshot.cursor;
    this.completedEffects = snapshot.completedEffects;
    this.binding = {
      principalId: snapshot.principalId,
      deviceId: snapshot.deviceId,
      jobId: snapshot.jobId,
      browserSessionId: snapshot.browserSessionId,
      objective: snapshot.objective,
      jobRevision: snapshot.jobRevision,
      logicalStep: snapshot.logicalStep,
      effectId: snapshot.effectId,
      leaseEpoch: snapshot.leaseEpoch,
    };
    return { ok: true, snapshot };
  }

  private async refreshAutomationFence(): Promise<
    WorkflowRuntimeResult | undefined
  > {
    let state: AutomationSyncResponse;
    try {
      state = await this.options.automationFence.synchronize({
        principalId: this.binding.principalId,
        deviceId: this.binding.deviceId,
        browserSessionId: this.binding.browserSessionId,
      });
    } catch {
      this.executor.markOfflineTakeover();
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    if (
      state.jobId !== this.binding.jobId ||
      state.leaseEpoch < this.binding.leaseEpoch
    ) {
      this.executor.markOfflineTakeover();
      return { status: "FENCED", reason: "COORDINATOR_UNAVAILABLE" };
    }
    if (state.canceled) {
      this.cancelFutureAutomation();
      return { status: "FENCED", reason: "CANCELED" };
    }
    if (
      state.connection !== "ONLINE" ||
      state.controller !== "AGENT" ||
      state.automationBlocked
    ) {
      this.executor.markOfflineTakeover();
      return { status: "FENCED", reason: "AUTOMATION_UNAVAILABLE" };
    }
    return undefined;
  }

  private availability(
    snapshot: CoordinatorSnapshot,
  ): WorkflowRuntimeResult | undefined {
    if (snapshot.canceled) {
      this.cancelFutureAutomation();
      return { status: "FENCED", reason: "CANCELED" };
    }
    if (
      snapshot.connection !== "ONLINE" ||
      snapshot.controller !== "AGENT" ||
      snapshot.automationBlocked
    ) {
      return { status: "FENCED", reason: "AUTOMATION_UNAVAILABLE" };
    }
    return undefined;
  }

  private async observe(
    binding: WorkflowRuntimeBinding,
  ): Promise<
    | { observation: SetupObservation }
    | Extract<WorkflowRuntimeResult, { status: "WAITING_FOR_USER" }>
  > {
    let observation: SetupObservation;
    try {
      observation = setupObservationSchema.parse(
        await this.options.fixture.observe(binding),
      );
    } catch {
      return { status: "WAITING_FOR_USER", reason: "OUTCOME_UNKNOWN" };
    }
    if (
      observation.workflowKind !== binding.objective.kind ||
      observation.workflowVersion !== binding.objective.version ||
      observation.logicalStep !== binding.logicalStep ||
      observation.effectId !== binding.effectId
    ) {
      return { status: "WAITING_FOR_USER", reason: "OUTCOME_UNKNOWN" };
    }
    const gate = humanGate(observation);
    if (gate) {
      this.executor.markOfflineTakeover();
      return {
        status: "WAITING_FOR_USER",
        reason: "HUMAN_GATE_REQUIRED",
        gate,
      };
    }
    return { observation };
  }

  private providerContext(observation: SetupObservation) {
    return {
      schemaVersion: 1 as const,
      objective: this.binding.objective,
      browserSessionId: this.binding.browserSessionId,
      jobId: this.binding.jobId,
      jobRevision: this.binding.jobRevision,
      logicalStep: this.binding.logicalStep,
      effectId: this.binding.effectId,
      leaseEpoch: this.binding.leaseEpoch,
      actionPhase: "ACCEPTED" as const,
      allowedActions: [
        { capability: mutationCapability[this.binding.logicalStep] },
        { capability: "VERIFY_SETUP" as const },
      ],
      completedSteps: this.completedEffects.map((effect) => effect.logicalStep),
      observation,
    };
  }

  private matchesCurrentResult(
    result: {
      jobId: string;
      jobRevision: number;
      logicalStep: SetupLogicalStep;
      effectId: string;
      leaseEpoch: number;
    },
    snapshot: CoordinatorSnapshot,
  ): boolean {
    return (
      result.jobId === snapshot.jobId &&
      result.jobRevision === snapshot.jobRevision &&
      result.logicalStep === snapshot.logicalStep &&
      result.effectId === snapshot.effectId &&
      result.leaseEpoch === snapshot.leaseEpoch
    );
  }

  private async record(
    actionId: string,
    phase: WorkflowActionJournalEntry["phase"],
    postcondition: WorkflowActionJournalEntry["postcondition"],
    mutationClass?: WorkflowActionJournalEntry["mutationClass"],
  ): Promise<void> {
    await this.options.journal.record({
      actionId,
      jobId: this.binding.jobId,
      browserSessionId: this.binding.browserSessionId,
      logicalStep: this.binding.logicalStep,
      effectId: this.binding.effectId,
      leaseEpoch: this.binding.leaseEpoch,
      phase,
      mutationClass:
        mutationClass ??
        (this.binding.logicalStep === "FINALIZE_SETUP"
          ? "NON_IDEMPOTENT"
          : "IDEMPOTENT"),
      postcondition,
      recordedAt: new Date(this.now()).toISOString(),
    });
  }

  private budgetResult(): WorkflowRuntimeResult | undefined {
    if (this.now() - this.startedAt > this.budgets.maxDurationMs) {
      this.executor.markOfflineTakeover();
      return { status: "WAITING_FOR_USER", reason: "TIME_BUDGET_EXHAUSTED" };
    }
    return undefined;
  }
}
