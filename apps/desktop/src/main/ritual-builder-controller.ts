import { createHash } from "node:crypto";
import {
  approvedRitualRevisionSchema,
  approveRitualLearningProposal,
  restoreRitualRevision,
  createRitualRun,
  createRitualRunReceipt,
  createRitualTestReceipt,
  reduceRitualRun,
  ritualRunCancelRequestSchema,
  ritualRunControllerResultSchema,
  ritualRunRequestSchema,
  ritualScheduledRunRequestSchema,
  ritualRunStepApprovalRequestSchema,
  ritualSchedulePauseRequestSchema,
  ritualScheduleSchema,
  ritualScheduleUpdateRequestSchema,
  ritualTestRunControllerResultSchema,
  ritualTestRunRequestSchema,
  ritualLearningApprovalRequestSchema,
  ritualLearningFeedbackRequestSchema,
  ritualLearningDecisionRequestSchema,
  ritualRevisionRestoreRequestSchema,
  validateRitualTestRunResult,
  validateRitualLearningResult,
  ritualStewardContextSchema,
  ritualStewardFollowUpContextSchema,
  ritualStewardFollowUpRequestSchema,
  ritualStewardFollowUpWaiting,
  validateRitualStewardFollowUpResult,
  validateRitualStewardResult,
  type ApprovedRitualRevision,
  type RitualTestReceipt,
  type RitualTestRunControllerResult,
  type RitualLearningProposal,
  type RitualLearningDecisionRequest,
  type RitualLearningReceipt,
  type RitualLearningResult,
  type RitualRun,
  type RitualRunRequest,
  type RitualRunControllerResult,
  type RitualRunReceipt,
  type RitualInboxItem,
  type RitualSchedule,
  type RitualStewardResult,
  type RitualStewardFollowUpResult,
  type RitualAuditTimeline,
  type RitualCatalog,
  type RitualInitialWorkspaceSnapshot,
  type RitualLatestSnapshot,
  type RitualWorkspaceSnapshot,
  type RitualRevisionRestoreRequest,
} from "@village/contracts";
import type { RitualStewardProvider } from "../model-provider/ritual-steward.js";
import { createVillageId } from "./local-village-id.js";
import {
  LocalRitualRunExecutor,
  type RitualRunExecutor,
} from "./ritual-run-executor.js";
import { nextRitualOccurrence } from "./ritual-scheduler.js";

export interface RitualPersistence {
  latestSnapshot(): Promise<RitualLatestSnapshot>;
  snapshotFor(ritualId: string): Promise<RitualLatestSnapshot | null>;
  catalog(): Promise<RitualCatalog>;
  initialWorkspaceSnapshot(): Promise<RitualInitialWorkspaceSnapshot>;
  workspaceSnapshotFor(
    ritualId: string,
  ): Promise<RitualWorkspaceSnapshot | null>;
  find(ritualId: string): Promise<ApprovedRitualRevision | null>;
  findRevision(
    ritualId: string,
    ritualRevision: number,
  ): Promise<ApprovedRitualRevision | null>;
  findReceipt(receiptId: string): Promise<RitualLearningReceipt | null>;
  latestReceiptFor(
    ritualId: string,
    ritualRevision: number,
  ): Promise<RitualLearningReceipt | null>;
  findLearningProposal(
    proposalId: string,
  ): Promise<RitualLearningProposal | null>;
  save(ritual: ApprovedRitualRevision): Promise<void>;
  saveReceipt(receipt: RitualTestReceipt): Promise<void>;
  saveLearningProposal(proposal: RitualLearningProposal): Promise<void>;
  decideLearning(request: RitualLearningDecisionRequest): Promise<void>;
  findRunWithApprovedRevision(runId: string): Promise<{
    run: RitualRun;
    approved: ApprovedRitualRevision;
  } | null>;
  findNonterminalRun(
    ritualId: string,
    ritualRevision: number,
  ): Promise<RitualRun | null>;
  saveRun(run: RitualRun): Promise<void>;
  completeRun(
    run: RitualRun,
    receipt: RitualRunReceipt,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  listSchedules(): Promise<readonly RitualSchedule[]>;
  saveSchedule(
    schedule: RitualSchedule,
    options?: { expectedUpdatedAt: string | null },
  ): Promise<void>;
  listInbox(): Promise<readonly RitualInboxItem[]>;
  automationSnapshot(): Promise<{
    approved: ApprovedRitualRevision | null;
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }>;
  automationSnapshotFor(ritualId: string): Promise<{
    approved: ApprovedRitualRevision | null;
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }>;
}

interface RitualControllerDependencies {
  createId(prefix: "rrn" | "rcp" | "rlp"): string;
  now(): string;
  runExecutor: RitualRunExecutor;
  onScheduleChanged(): void;
}

interface ActiveRunOperation {
  abortController: AbortController;
  cancellation: Promise<RitualRunControllerResult>;
  resolveCancellation(result: RitualRunControllerResult): void;
  rejectCancellation(error: unknown): void;
  committedResult: RitualRunControllerResult | null;
}

type PreparedRun =
  | { kind: "result"; result: RitualRunControllerResult }
  | {
      kind: "drive";
      ritual: ApprovedRitualRevision;
      run: RitualRun;
      active: ActiveRunOperation;
    };

export class RitualBuilderController {
  private runOperationTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, ActiveRunOperation>();
  private readonly pendingRunCancellations = new Set<string>();
  private readonly dependencies: RitualControllerDependencies;
  private readonly runExecutor: RitualRunExecutor;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly provider: RitualStewardProvider,
    private readonly repository: RitualPersistence,
    dependencies: Partial<RitualControllerDependencies> = {},
  ) {
    this.dependencies = {
      createId: dependencies.createId ?? createVillageId,
      now: dependencies.now ?? (() => new Date().toISOString()),
      runExecutor: dependencies.runExecutor ?? new LocalRitualRunExecutor(),
      onScheduleChanged: dependencies.onScheduleChanged ?? (() => undefined),
    };
    this.runExecutor = this.dependencies.runExecutor;
  }

  async draft(candidate: unknown): Promise<RitualStewardResult> {
    const context = ritualStewardContextSchema.parse(candidate);
    return validateRitualStewardResult(
      context,
      await this.provider.draft(context),
    );
  }

  async followUp(candidate: unknown): Promise<RitualStewardFollowUpResult> {
    const request = ritualStewardFollowUpRequestSchema.parse(candidate);
    const snapshot = await this.enqueueRun(async () =>
      this.repository.snapshotFor(request.ritualId),
    );
    if (!snapshot?.approved) throw new Error("RITUAL_NOT_FOUND");
    if (snapshot.approved.ritualRevision !== request.ritualRevision) {
      throw new Error("STALE_RITUAL_REVISION");
    }
    const latestReceipt = await this.enqueueRun(() =>
      this.repository.latestReceiptFor(
        request.ritualId,
        request.ritualRevision,
      ),
    );
    const evidence =
      latestReceipt?.mode === "RUN"
        ? {
            mode: "RUN" as const,
            outcome: latestReceipt.outcome,
            summary: sanitizeFollowUpText(latestReceipt.summary, 500),
            steps: latestReceipt.stepEvidence.slice(0, 6).map((step) => ({
              title: step.title,
              actor: step.actor,
              report: step.report
                ? {
                    headline: sanitizeFollowUpText(step.report.headline, 280),
                    summary: sanitizeFollowUpText(step.report.summary, 500),
                    findings: step.report.findings.map((finding) =>
                      sanitizeFollowUpText(finding.claim, 600),
                    ),
                    uncertainties: step.report.uncertainties.map(
                      (uncertainty) => sanitizeFollowUpText(uncertainty, 280),
                    ),
                  }
                : null,
              mailReport: step.mailReport
                ? {
                    metadataOnly: true as const,
                    reviewedMessageCount: step.mailReport.reviewedMessageCount,
                    headline: sanitizeFollowUpText(
                      step.mailReport.headline,
                      160,
                    ),
                    priorityCounts: {
                      high: step.mailReport.priorities.filter(
                        (item) => item.priority === "HIGH",
                      ).length,
                      medium: step.mailReport.priorities.filter(
                        (item) => item.priority === "MEDIUM",
                      ).length,
                      low: step.mailReport.priorities.filter(
                        (item) => item.priority === "LOW",
                      ).length,
                    },
                    uncertainties: step.mailReport.uncertainties.map(
                      (uncertainty) => sanitizeFollowUpText(uncertainty, 280),
                    ),
                  }
                : null,
            })),
            uncertainties: latestReceipt.uncertainties.map((uncertainty) =>
              sanitizeFollowUpText(uncertainty, 280),
            ),
            externalEffects: latestReceipt.externalEffects.map((effect) =>
              sanitizeFollowUpText(effect, 280),
            ),
          }
        : latestReceipt?.mode === "TEST"
          ? {
              mode: "TEST" as const,
              outcome: latestReceipt.outcome,
              summary: sanitizeFollowUpText(latestReceipt.summary, 500),
              evidence: latestReceipt.evidence.map((item) =>
                sanitizeFollowUpText(item, 600),
              ),
              uncertainties: latestReceipt.uncertainties.map((uncertainty) =>
                sanitizeFollowUpText(uncertainty, 280),
              ),
              externalEffects: latestReceipt.externalEffects.map((effect) =>
                sanitizeFollowUpText(effect, 280),
              ),
            }
          : null;
    const context = ritualStewardFollowUpContextSchema.parse({
      ...request,
      ritual: {
        name: snapshot.approved.name,
        purpose: snapshot.approved.purpose,
        trigger: snapshot.approved.trigger,
        steps: snapshot.approved.steps,
        permissions: snapshot.approved.permissions,
        completion: snapshot.approved.completion,
        reviewPolicy: snapshot.approved.reviewPolicy,
        ...(snapshot.approved.gmailReview
          ? { gmailReview: snapshot.approved.gmailReview }
          : {}),
      },
      evidence,
    });
    const result = validateRitualStewardFollowUpResult(
      context,
      await this.provider.followUp(context),
    );
    const current = await this.enqueueRun(() =>
      this.repository.snapshotFor(request.ritualId),
    );
    if (current?.approved?.ritualRevision !== request.ritualRevision) {
      return ritualStewardFollowUpWaiting(context, "STALE_STEWARD_RESULT");
    }
    return result;
  }

  async loadLatestState(): Promise<RitualLatestSnapshot> {
    return this.enqueueRun(async () => {
      const snapshot = await this.repository.latestSnapshot();
      return this.reconcileLoadedSnapshot(snapshot);
    });
  }

  async listRituals(): Promise<RitualCatalog> {
    return this.enqueueRun(async () => this.repository.catalog());
  }

  async loadInitialWorkspaceState(): Promise<RitualInitialWorkspaceSnapshot> {
    return this.enqueueRun(async () => {
      const workspace = await this.repository.initialWorkspaceSnapshot();
      const reconciled = await this.reconcileLoadedSnapshot(workspace);
      if (reconciled.run === workspace.run) return workspace;
      const automation = await this.repository.automationSnapshotFor(
        reconciled.approved!.ritualId,
      );
      return {
        ...workspace,
        ...reconciled,
        ...automation,
        inbox: [...automation.inbox],
      };
    });
  }

  async loadRitualWorkspaceState(
    ritualId: string,
  ): Promise<RitualWorkspaceSnapshot> {
    return this.enqueueRun(async () => {
      const workspace = await this.repository.workspaceSnapshotFor(ritualId);
      if (!workspace) throw new Error("RITUAL_NOT_FOUND");
      const reconciled = await this.reconcileLoadedSnapshot(workspace);
      if (reconciled.run === workspace.run) return workspace;
      const automation = await this.repository.automationSnapshotFor(ritualId);
      return {
        ...workspace,
        ...reconciled,
        ...automation,
        inbox: [...automation.inbox],
      };
    });
  }

  async loadAuditTimeline(ritualId?: string): Promise<RitualAuditTimeline> {
    return this.enqueueRun(async () => {
      const snapshot = ritualId
        ? await this.repository.snapshotFor(ritualId)
        : await this.repository.latestSnapshot();
      if (!snapshot) throw new Error("RITUAL_NOT_FOUND");
      return snapshot.auditTimeline;
    });
  }

  async loadAutomationState(ritualId?: string): Promise<{
    schedule: RitualSchedule | null;
    inbox: readonly RitualInboxItem[];
  }> {
    return this.enqueueRun(async () => {
      const { schedule, inbox } = ritualId
        ? await this.repository.automationSnapshotFor(ritualId)
        : await this.repository.automationSnapshot();
      return { schedule, inbox };
    });
  }

  private async reconcileLoadedSnapshot(
    snapshot: RitualLatestSnapshot,
  ): Promise<RitualLatestSnapshot> {
    if (
      !snapshot.approved ||
      !snapshot.run ||
      (snapshot.run.status !== "QUEUED" && snapshot.run.status !== "RUNNING")
    ) {
      return snapshot;
    }
    const isPendingScheduleRun = (await this.repository.listSchedules()).some(
      (schedule) => schedule.pendingOccurrence?.runId === snapshot.run?.runId,
    );
    if (this.activeRuns.has(snapshot.run.runId) || isPendingScheduleRun) {
      return snapshot;
    }
    const checkpointedStep = snapshot.run.steps.find(
      (step) =>
        step.stepKey === snapshot.run?.currentStepKey &&
        step.status === "RUNNING" &&
        step.research != null &&
        step.report == null,
    );
    if (checkpointedStep?.research) {
      const waiting = reduceRitualRun(snapshot.run, snapshot.approved, {
        type: "WAIT_FOR_RESOURCE",
        reason: "PROVIDER_UNAVAILABLE",
        source: "STEWARD",
        research: checkpointedStep.research,
        occurredAt: this.dependencies.now(),
      });
      await this.repository.saveRun(waiting);
      return { ...snapshot, run: waiting };
    }
    const interrupted = reduceRitualRun(snapshot.run, snapshot.approved, {
      type: "FAIL",
      failureCode: "INTERRUPTED",
      occurredAt: this.dependencies.now(),
    });
    await this.repository.saveRun(interrupted);
    return { ...snapshot, run: interrupted };
  }

  async configureSchedule(candidate: unknown): Promise<RitualSchedule> {
    const request = ritualScheduleUpdateRequestSchema.parse(candidate);
    return this.enqueueRun(async () => {
      const ritual = await this.repository.find(request.ritualId);
      if (!ritual || ritual.ritualRevision !== request.ritualRevision) {
        throw new Error("STALE_RITUAL_SCHEDULE");
      }
      const existing = (await this.repository.listSchedules()).findLast(
        (entry) =>
          entry.ritualId === request.ritualId &&
          entry.ritualRevision === request.ritualRevision,
      );
      if (existing?.pendingOccurrence) {
        throw new Error("RITUAL_SCHEDULE_BUSY");
      }
      const now = this.dependencies.now();
      const schedule = ritualScheduleSchema.parse({
        ...request,
        state: "ENABLED",
        nextRunAt: nextRitualOccurrence(request, now),
        pendingOccurrence: null,
        lastTriggeredAt: existing?.lastTriggeredAt ?? null,
        updatedAt: now,
      });
      await this.repository.saveSchedule(schedule, {
        expectedUpdatedAt: existing?.updatedAt ?? null,
      });
      this.dependencies.onScheduleChanged();
      return schedule;
    });
  }

  async pauseSchedule(candidate: unknown): Promise<RitualSchedule> {
    const request = ritualSchedulePauseRequestSchema.parse(candidate);
    return this.enqueueRun(async () => {
      const schedule = (await this.repository.listSchedules()).findLast(
        (entry) =>
          entry.ritualId === request.ritualId &&
          entry.ritualRevision === request.ritualRevision,
      );
      if (!schedule) throw new Error("RITUAL_SCHEDULE_NOT_FOUND");
      const paused = ritualScheduleSchema.parse({
        ...schedule,
        state: "PAUSED",
        pendingOccurrence: null,
        updatedAt: this.dependencies.now(),
      });
      await this.repository.saveSchedule(paused, {
        expectedUpdatedAt: schedule.updatedAt,
      });
      this.dependencies.onScheduleChanged();
      return paused;
    });
  }

  async approve(candidate: unknown): Promise<ApprovedRitualRevision> {
    const ritual = approvedRitualRevisionSchema.parse(candidate);
    await this.repository.save(ritual);
    return ritual;
  }

  async restoreRevision(candidate: unknown): Promise<ApprovedRitualRevision> {
    const request: RitualRevisionRestoreRequest =
      ritualRevisionRestoreRequestSchema.parse(candidate);
    return this.enqueueRun(async () => {
      const [current, source, activeRun, snapshot] = await Promise.all([
        this.repository.find(request.ritualId),
        this.repository.findRevision(
          request.ritualId,
          request.restoreFromRevision,
        ),
        this.repository.findNonterminalRun(
          request.ritualId,
          request.expectedCurrentRevision,
        ),
        this.repository.latestSnapshot(),
      ]);
      if (!current || !source) throw new Error("RITUAL_RESTORE_NOT_FOUND");
      if (activeRun) throw new Error("RITUAL_RESTORE_RUN_ACTIVE");
      if (
        snapshot.learningReview &&
        snapshot.approved?.ritualId === request.ritualId &&
        snapshot.approved.ritualRevision === request.expectedCurrentRevision
      ) {
        throw new Error("RITUAL_RESTORE_LEARNING_PENDING");
      }
      const restored = restoreRitualRevision(current, source, {
        ...request,
        restoredAt: this.dependencies.now(),
      });
      await this.repository.save(restored);
      this.dependencies.onScheduleChanged();
      return restored;
    });
  }

  async startRun(candidate: unknown): Promise<RitualRunControllerResult> {
    this.assertOpen();
    const prepared = await this.enqueueRun<PreparedRun>(async () => {
      this.assertOpen();
      const request = ritualRunRequestSchema.parse(candidate);
      const ritual = await this.repository.find(request.ritualId);
      if (!ritual || ritual.ritualRevision !== request.ritualRevision) {
        throw new Error("STALE_RITUAL_RUN");
      }
      const existing = await this.repository.findNonterminalRun(
        ritual.ritualId,
        ritual.ritualRevision,
      );
      if (existing) {
        if (existing.status === "WAITING_FOR_RESOURCE") {
          const retrying = reduceRitualRun(existing, ritual, {
            type: "RETRY_RESOURCE",
            occurredAt: this.dependencies.now(),
          });
          await this.repository.saveRun(retrying);
          return {
            kind: "drive",
            ritual,
            run: retrying,
            active: this.activateRun(retrying.runId),
          };
        }
        return {
          kind: "result",
          result: ritualRunControllerResultSchema.parse({
            status: "run",
            run: existing,
          }),
        };
      }
      const run = await this.createAndStartRun(
        ritual,
        request,
        this.dependencies.createId("rrn"),
      );
      return {
        kind: "drive",
        ritual,
        run,
        active: this.activateRun(run.runId),
      };
    });
    return prepared.kind === "result"
      ? prepared.result
      : this.driveActiveRun(prepared.ritual, prepared.run, prepared.active);
  }

  async startScheduledRun(
    candidate: unknown,
  ): Promise<RitualRunControllerResult> {
    this.assertOpen();
    const prepared = await this.enqueueRun<PreparedRun>(async () => {
      this.assertOpen();
      const request = ritualScheduledRunRequestSchema.parse(candidate);
      const existing = await this.repository.findRunWithApprovedRevision(
        request.runId,
      );
      if (existing) {
        if (
          existing.run.ritualId !== request.ritualId ||
          existing.run.ritualRevision !== request.ritualRevision
        ) {
          throw new Error("STALE_RITUAL_SCHEDULED_RUN");
        }
        if (existing.run.status === "QUEUED") {
          const started = reduceRitualRun(existing.run, existing.approved, {
            type: "START",
            occurredAt: this.dependencies.now(),
          });
          await this.repository.saveRun(started);
          return {
            kind: "drive",
            ritual: existing.approved,
            run: started,
            active: this.activateRun(started.runId),
          };
        }
        if (existing.run.status === "RUNNING") {
          return {
            kind: "drive",
            ritual: existing.approved,
            run: existing.run,
            active: this.activateRun(existing.run.runId),
          };
        }
        return {
          kind: "result",
          result: ritualRunControllerResultSchema.parse({
            status: "run",
            run: existing.run,
          }),
        };
      }

      const ritual = await this.repository.find(request.ritualId);
      if (!ritual || ritual.ritualRevision !== request.ritualRevision) {
        throw new Error("STALE_RITUAL_SCHEDULED_RUN");
      }
      const activeRun = await this.repository.findNonterminalRun(
        request.ritualId,
        request.ritualRevision,
      );
      if (activeRun) {
        return {
          kind: "result",
          result: ritualRunControllerResultSchema.parse({
            status: "run",
            run: activeRun,
          }),
        };
      }
      const run = await this.createAndStartRun(
        ritual,
        {
          schemaVersion: 1,
          ritualId: request.ritualId,
          ritualRevision: request.ritualRevision,
        },
        request.runId,
      );
      return {
        kind: "drive",
        ritual,
        run,
        active: this.activateRun(run.runId),
      };
    });
    return prepared.kind === "result"
      ? prepared.result
      : this.driveActiveRun(prepared.ritual, prepared.run, prepared.active);
  }

  private async createAndStartRun(
    ritual: ApprovedRitualRevision,
    request: RitualRunRequest,
    runId: RitualRun["runId"],
  ): Promise<RitualRun> {
    const queued = createRitualRun({
      approved: ritual,
      request,
      runId,
      createdAt: this.dependencies.now(),
    });
    await this.repository.saveRun(queued);
    const started = reduceRitualRun(queued, ritual, {
      type: "START",
      occurredAt: this.dependencies.now(),
    });
    await this.repository.saveRun(started);
    return started;
  }

  async approveRunStep(candidate: unknown): Promise<RitualRunControllerResult> {
    this.assertOpen();
    const prepared = await this.enqueueRun<PreparedRun>(async () => {
      this.assertOpen();
      const request = ritualRunStepApprovalRequestSchema.parse(candidate);
      const context = await this.repository.findRunWithApprovedRevision(
        request.runId,
      );
      if (!context) throw new Error("RITUAL_RUN_NOT_FOUND");
      const { run, approved: ritual } = context;
      const approved = reduceRitualRun(run, ritual, {
        type: "APPROVE_STEP",
        stepKey: request.stepKey,
        occurredAt: this.dependencies.now(),
      });
      await this.repository.saveRun(approved);
      return {
        kind: "drive",
        ritual,
        run: approved,
        active: this.activateRun(approved.runId),
      };
    });
    return prepared.kind === "result"
      ? prepared.result
      : this.driveActiveRun(prepared.ritual, prepared.run, prepared.active);
  }

  cancelRun(candidate: unknown): Promise<RitualRunControllerResult> {
    const request = ritualRunCancelRequestSchema.parse(candidate);
    this.assertOpen();
    this.pendingRunCancellations.add(request.runId);
    this.activeRuns.get(request.runId)?.abortController.abort();
    const cancellation = this.enqueueRun(async () => {
      const active = this.activeRuns.get(request.runId);
      if (active?.committedResult) return active.committedResult;
      active?.abortController.abort();
      const context = await this.repository.findRunWithApprovedRevision(
        request.runId,
      );
      if (!context) throw new Error("RITUAL_RUN_NOT_FOUND");
      const { run, approved: ritual } = context;
      const canceled = reduceRitualRun(run, ritual, {
        type: "CANCEL",
        occurredAt: this.dependencies.now(),
      });
      await this.repository.saveRun(canceled);
      return ritualRunControllerResultSchema.parse({
        status: "run",
        run: canceled,
      });
    });
    void cancellation.then(
      (result) => {
        this.pendingRunCancellations.delete(request.runId);
        this.activeRuns.get(request.runId)?.resolveCancellation(result);
      },
      (error: unknown) => {
        this.pendingRunCancellations.delete(request.runId);
        this.activeRuns.get(request.runId)?.rejectCancellation(error);
      },
    );
    return cancellation;
  }

  async testRun(candidate: unknown): Promise<RitualTestRunControllerResult> {
    const request = ritualTestRunRequestSchema.parse(candidate);
    const ritual = await this.repository.find(request.ritualId);
    if (!ritual || ritual.ritualRevision !== request.ritualRevision) {
      throw new Error("STALE_RITUAL_TEST_RUN");
    }
    const context = {
      schemaVersion: 1 as const,
      runId: this.dependencies.createId("rrn"),
      ritual,
      sample: request.sample,
    };
    const result = validateRitualTestRunResult(
      context,
      await this.provider.testRun(context),
    );
    if (result.status === "waiting") {
      return ritualTestRunControllerResultSchema.parse(result);
    }
    const receipt = createRitualTestReceipt({
      approved: ritual,
      request,
      result,
      receiptId: this.dependencies.createId("rcp"),
      sampleDigest: createHash("sha256").update(request.sample).digest("hex"),
      recordedAt: this.dependencies.now(),
    });
    await this.repository.saveReceipt(receipt);
    return ritualTestRunControllerResultSchema.parse({
      status: "receipt",
      receipt,
    });
  }

  async proposeLearning(candidate: unknown): Promise<RitualLearningResult> {
    const request = ritualLearningFeedbackRequestSchema.parse(candidate);
    const [ritual, receipt] = await Promise.all([
      this.repository.find(request.ritualId),
      this.repository.findReceipt(request.receiptId),
    ]);
    if (
      !ritual ||
      !receipt ||
      ritual.ritualRevision !== request.ritualRevision ||
      receipt.ritualId !== ritual.ritualId ||
      receipt.ritualRevision !== ritual.ritualRevision
    ) {
      throw new Error("STALE_RITUAL_LEARNING_PROPOSAL");
    }
    const context = {
      schemaVersion: 1 as const,
      proposalId: this.dependencies.createId("rlp"),
      ritual,
      receipt,
      ownerFeedback: request.feedback,
    };
    const result = validateRitualLearningResult(
      context,
      await this.provider.learn(context),
    );
    if (result.status === "proposal") {
      await this.repository.saveLearningProposal(result);
    }
    return result;
  }

  async approveLearning(candidate: unknown): Promise<ApprovedRitualRevision> {
    const request = ritualLearningApprovalRequestSchema.parse(candidate);
    const [ritual, proposal] = await Promise.all([
      this.repository.find(request.ritualId),
      this.repository.findLearningProposal(request.proposalId),
    ]);
    if (!ritual || !proposal) {
      throw new Error("STALE_RITUAL_LEARNING_PROPOSAL");
    }
    const revision = approveRitualLearningProposal(ritual, proposal, request);
    await this.repository.save(revision);
    return revision;
  }

  async decideLearning(candidate: unknown): Promise<void> {
    const request = ritualLearningDecisionRequestSchema.parse(candidate);
    return this.enqueueRun(() => this.repository.decideLearning(request));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const closingRuns = new Map(this.activeRuns);
    for (const [runId, active] of this.activeRuns) {
      if (!active.committedResult) {
        this.pendingRunCancellations.add(runId);
        active.abortController.abort();
      }
    }
    const cancelActiveRuns = this.enqueueRun(async () => {
      for (const [runId, active] of this.activeRuns) {
        closingRuns.set(runId, active);
      }
      let cancellationFailure: unknown;
      for (const [runId, active] of closingRuns) {
        if (active.committedResult) continue;
        try {
          const context =
            await this.repository.findRunWithApprovedRevision(runId);
          if (!context) throw new Error("RITUAL_RUN_NOT_FOUND");
          const canceled = reduceRitualRun(context.run, context.approved, {
            type: "CANCEL",
            occurredAt: this.dependencies.now(),
          });
          await this.repository.saveRun(canceled);
          active.resolveCancellation(
            ritualRunControllerResultSchema.parse({
              status: "run",
              run: canceled,
            }),
          );
        } catch (error) {
          active.rejectCancellation(error);
          cancellationFailure ??= error;
        } finally {
          this.pendingRunCancellations.delete(runId);
        }
      }
      if (cancellationFailure) throw cancellationFailure;
    });
    this.closePromise = cancelActiveRuns.then(
      () => this.provider.close(),
      async (error: unknown) => {
        await this.provider.close();
        throw error;
      },
    );
    return this.closePromise;
  }

  private async driveRun(
    ritual: ApprovedRitualRevision,
    initial: RitualRun,
    active: ActiveRunOperation,
  ): Promise<RitualRunControllerResult> {
    const { signal } = active.abortController;
    let run = initial;
    let durableRun = initial;
    try {
      while (run.status === "RUNNING" && run.currentStepKey) {
        const executed = await abortable(
          () =>
            this.runExecutor.completeCurrentStep({
              approved: ritual,
              run,
              signal,
            }),
          signal,
        );
        if (executed.externalEffects.length !== 0) {
          throw new Error("RITUAL_RUN_POLICY_DENIED");
        }
        if (executed.status === "checkpointed") {
          run = reduceRitualRun(run, ritual, {
            type: "CHECKPOINT_RESEARCH",
            stepKey: executed.stepKey,
            research: executed.research,
            occurredAt: this.dependencies.now(),
          });
          await this.repository.saveRun(run);
          durableRun = run;
          continue;
        }
        if (executed.status === "waiting") {
          run = reduceRitualRun(run, ritual, {
            type: "WAIT_FOR_RESOURCE",
            reason: executed.reason,
            source: executed.source,
            ...(executed.research ? { research: executed.research } : {}),
            occurredAt: this.dependencies.now(),
          });
          await this.repository.saveRun(run);
          return ritualRunControllerResultSchema.parse({ status: "run", run });
        }
        run = reduceRitualRun(run, ritual, {
          type: "COMPLETE_STEP",
          stepKey: executed.stepKey,
          ...(executed.research ? { research: executed.research } : {}),
          ...(executed.report ? { report: executed.report } : {}),
          ...(executed.mailReport ? { mailReport: executed.mailReport } : {}),
          occurredAt: this.dependencies.now(),
        });
        await this.repository.saveRun(run);
        durableRun = run;
      }
      if (run.status === "WAITING_FOR_OWNER") {
        return ritualRunControllerResultSchema.parse({ status: "run", run });
      }
      if (run.status !== "RUNNING" || run.currentStepKey !== null) {
        return ritualRunControllerResultSchema.parse({ status: "run", run });
      }
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.message === "RITUAL_RUN_CANCELED")
      ) {
        return active.cancellation;
      }
      const failureCode =
        error instanceof Error && error.message === "RITUAL_RUN_POLICY_DENIED"
          ? "POLICY_DENIED"
          : "EXECUTOR_FAILED";
      const failed = reduceRitualRun(durableRun, ritual, {
        type: "FAIL",
        failureCode,
        occurredAt: this.dependencies.now(),
      });
      await this.repository.saveRun(failed);
      return ritualRunControllerResultSchema.parse({
        status: "run",
        run: failed,
      });
    }
    try {
      return await this.enqueueRun(async () => {
        throwIfRunCanceled(signal, this.pendingRunCancellations.has(run.runId));
        run = reduceRitualRun(run, ritual, {
          type: "COMPLETE_RUN",
          outcome: "NEEDS_REVIEW",
          occurredAt: this.dependencies.now(),
        });
        const receipt = createRitualRunReceipt({
          approved: ritual,
          run,
          receiptId: this.dependencies.createId("rcp"),
          summary: run.steps.some((step) => step.mailReport != null)
            ? `The local Run reviewed Gmail metadata and completed ${run.steps.length} approved ${run.steps.length === 1 ? "step" : "steps"} without mail mutations.`
            : run.steps.some((step) => (step.research?.sources.length ?? 0) > 0)
              ? `The local Run completed ${run.steps.length} approved ${run.steps.length === 1 ? "step" : "steps"} with bounded Exa evidence.`
              : run.steps.some((step) => step.research != null)
                ? "Exa completed the approved search, but no qualifying sources were found."
                : `The local Run completed all ${run.steps.length} approved orchestration ${run.steps.length === 1 ? "step" : "steps"}.`,
          recordedAt: this.dependencies.now(),
        });
        await this.repository.completeRun(run, receipt, { signal });
        const result = ritualRunControllerResultSchema.parse({
          status: "receipt",
          run,
          receipt,
        });
        active.committedResult = result;
        this.pendingRunCancellations.delete(run.runId);
        return result;
      });
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.message === "RITUAL_RUN_CANCELED")
      ) {
        return active.cancellation;
      }
      throw error;
    }
  }

  private async driveActiveRun(
    ritual: ApprovedRitualRevision,
    run: RitualRun,
    active: ActiveRunOperation,
  ): Promise<RitualRunControllerResult> {
    try {
      return await this.driveRun(ritual, run, active);
    } finally {
      if (this.activeRuns.get(run.runId) === active) {
        this.activeRuns.delete(run.runId);
      }
    }
  }

  private activateRun(runId: string): ActiveRunOperation {
    if (this.activeRuns.has(runId))
      throw new Error("RITUAL_RUN_ALREADY_ACTIVE");
    const abortController = new AbortController();
    let resolveCancellation!: (result: RitualRunControllerResult) => void;
    let rejectCancellation!: (error: unknown) => void;
    const cancellation = new Promise<RitualRunControllerResult>(
      (resolve, reject) => {
        resolveCancellation = resolve;
        rejectCancellation = reject;
      },
    );
    const active: ActiveRunOperation = {
      abortController,
      cancellation,
      resolveCancellation,
      rejectCancellation,
      committedResult: null,
    };
    this.activeRuns.set(runId, active);
    if (this.closed || this.pendingRunCancellations.has(runId)) {
      abortController.abort();
    }
    return active;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("RITUAL_CONTROLLER_CLOSED");
  }

  private enqueueRun<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.runOperationTail.then(operation, operation);
    this.runOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("RITUAL_RUN_CANCELED"));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("RITUAL_RUN_CANCELED"));
    signal.addEventListener("abort", cancel, { once: true });
    let operation: Promise<T>;
    try {
      operation = work();
    } catch (error) {
      signal.removeEventListener("abort", cancel);
      reject(error);
      return;
    }
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

function throwIfRunCanceled(signal: AbortSignal, pending: boolean): void {
  if (signal.aborted || pending) throw new Error("RITUAL_RUN_CANCELED");
}

function sanitizeFollowUpText(value: string, maximum: number): string {
  const sanitized = value
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link omitted]")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized || "[source detail omitted]").slice(0, maximum).trim();
}
