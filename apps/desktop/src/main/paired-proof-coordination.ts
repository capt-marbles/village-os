import type { AutomationSyncResponse } from "@village/contracts";
import type {
  AuthenticatedAutomationFence,
  AuthenticatedWorkflowCoordinator,
  CoordinatorSnapshot,
  WorkflowRuntimeResult,
} from "./delegated-workflow-controller.js";
import type { DelegatedWorkflowSnapshot } from "@village/ui";
import { proofProjectionState } from "./proof-projection.js";

export class PairedProofCoordination implements AuthenticatedWorkflowCoordinator {
  private current: CoordinatorSnapshot;
  private lastEffectActor: "AGENT" | "OWNER" | null = null;
  private lastStopReason: string | null = null;
  private lastDurableUpdateAt = new Date().toISOString();
  private cachedAutomationState: AutomationSyncResponse | undefined;

  constructor(
    initialSnapshot: CoordinatorSnapshot,
    private readonly coordinator: AuthenticatedWorkflowCoordinator,
  ) {
    this.current = { ...initialSnapshot };
  }

  snapshot(): CoordinatorSnapshot {
    return {
      ...this.current,
      completedEffects: [...this.current.completedEffects],
    };
  }

  createAutomationFence(
    automationFence: AuthenticatedAutomationFence,
  ): AuthenticatedAutomationFence {
    return {
      synchronize: async (input) => {
        const state = await automationFence.synchronize(input);
        this.cachedAutomationState = state;
        this.applyAutomationState(state);
        return state;
      },
    };
  }

  async refresh(): Promise<CoordinatorSnapshot> {
    return this.synchronize({
      principalId: this.current.principalId,
      deviceId: this.current.deviceId,
      jobId: this.current.jobId,
      browserSessionId: this.current.browserSessionId,
      cursor: this.current.cursor,
    });
  }

  async refreshFor(
    result?: WorkflowRuntimeResult,
  ): Promise<CoordinatorSnapshot> {
    return result?.status === "RECEIPTED" ||
      result?.status === "OWNER_STATE_ACCEPTED"
      ? this.refresh().catch(() => this.snapshot())
      : this.snapshot();
  }

  async synchronize(
    input: Parameters<AuthenticatedWorkflowCoordinator["synchronize"]>[0],
  ): Promise<CoordinatorSnapshot> {
    const cached = this.cachedAutomationState;
    this.cachedAutomationState = undefined;
    if (
      cached?.workflow &&
      cached.jobId === input.jobId &&
      cached.cursor >= input.cursor &&
      input.principalId === this.current.principalId &&
      input.deviceId === this.current.deviceId &&
      input.browserSessionId === this.current.browserSessionId &&
      cached.connection !== "ABSENT"
    ) {
      this.applyAutomationState(cached);
      return this.snapshot();
    }
    this.current = await this.coordinator.synchronize(input);
    this.lastDurableUpdateAt = new Date().toISOString();
    return this.snapshot();
  }

  acceptAction(
    input: Parameters<AuthenticatedWorkflowCoordinator["acceptAction"]>[0],
  ) {
    return this.coordinator.acceptAction(input);
  }

  async recordReceipt(
    input: Parameters<AuthenticatedWorkflowCoordinator["recordReceipt"]>[0],
  ) {
    this.cachedAutomationState = undefined;
    const result = await this.coordinator.recordReceipt(input);
    if (result.ok) {
      const completedEffect = {
        logicalStep: this.current.logicalStep,
        effectId: this.current.effectId,
      };
      this.current = {
        ...this.current,
        cursor: result.cursor,
        completedEffects: this.current.completedEffects.some(
          (candidate) => candidate.effectId === completedEffect.effectId,
        )
          ? this.current.completedEffects
          : [...this.current.completedEffects, completedEffect],
      };
      this.lastEffectActor = "AGENT";
      this.lastDurableUpdateAt = new Date().toISOString();
    }
    return result;
  }

  async recordOwnerProgress(
    input: Parameters<
      NonNullable<AuthenticatedWorkflowCoordinator["recordOwnerProgress"]>
    >[0],
  ) {
    this.cachedAutomationState = undefined;
    if (!this.coordinator.recordOwnerProgress) {
      return { ok: false as const, code: "OWNER_PROGRESS_UNAVAILABLE" };
    }
    const result = await this.coordinator.recordOwnerProgress(input);
    if (result.ok) {
      this.current = { ...this.current, cursor: result.cursor };
      this.lastEffectActor = "OWNER";
      this.lastDurableUpdateAt = input.occurredAt;
    }
    return result;
  }

  async claimFreshLease(
    input: Parameters<AuthenticatedWorkflowCoordinator["claimFreshLease"]>[0],
  ) {
    this.cachedAutomationState = undefined;
    const result = await this.coordinator.claimFreshLease(input);
    if (result.ok) {
      this.current = {
        ...this.current,
        cursor: result.cursor,
        leaseEpoch: result.leaseEpoch,
        controller: "AGENT",
        automationBlocked: false,
      };
      this.lastDurableUpdateAt = new Date().toISOString();
    }
    return result;
  }

  async takeover(
    input: Parameters<
      NonNullable<AuthenticatedWorkflowCoordinator["takeover"]>
    >[0],
  ) {
    this.cachedAutomationState = undefined;
    if (!this.coordinator.takeover) {
      return { ok: false as const, code: "TAKEOVER_UNAVAILABLE" };
    }
    const result = await this.coordinator.takeover(input);
    if (result.ok) {
      this.current = {
        ...this.current,
        cursor: result.cursor,
        leaseEpoch: result.leaseEpoch,
        controller: "USER",
        automationBlocked: true,
      };
      this.lastDurableUpdateAt = new Date().toISOString();
    }
    return result;
  }

  projection(result?: WorkflowRuntimeResult): DelegatedWorkflowSnapshot {
    this.lastStopReason =
      result?.status === "WAITING_FOR_USER" || result?.status === "FENCED"
        ? result.reason
        : null;
    const terminal = this.current.completedEffects.some(
      (effect) => effect.logicalStep === "FINALIZE_SETUP",
    );
    const state = proofProjectionState(result, terminal);
    return {
      workflowKind: this.current.objective.kind,
      state,
      logicalStep: this.current.logicalStep,
      controller: state === "OWNER_CONTROL" ? "USER" : this.current.controller,
      connection: this.current.connection,
      actionPhase: this.current.actionPhase,
      lastEffectActor: this.lastEffectActor,
      humanGate:
        result?.status === "WAITING_FOR_USER" && result.gate
          ? result.gate
          : null,
      inputOwner: state === "OWNER_CONTROL" ? "OWNER" : "NONE",
      lastDurableUpdateAt: this.lastDurableUpdateAt,
    };
  }

  stopReason(): string | null {
    return this.lastStopReason;
  }

  private applyAutomationState(state: AutomationSyncResponse): void {
    if (
      state.jobId !== this.current.jobId ||
      state.leaseEpoch < this.current.leaseEpoch
    ) {
      return;
    }
    const workflow = state.workflow;
    const completedEffects = workflow
      ? [...this.current.completedEffects, ...workflow.completedEffects].filter(
          (effect, index, all) =>
            all.findIndex(
              (candidate) => candidate.effectId === effect.effectId,
            ) === index,
        )
      : this.current.completedEffects;
    this.current = {
      ...this.current,
      cursor: state.cursor,
      jobId: state.jobId,
      controller: state.controller,
      connection: state.connection === "ABSENT" ? "OFFLINE" : state.connection,
      leaseEpoch: state.leaseEpoch,
      automationBlocked: state.automationBlocked,
      canceled: state.canceled,
      ...workflow,
      completedEffects,
    };
    this.lastDurableUpdateAt = new Date().toISOString();
  }
}
