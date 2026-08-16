import { createHash } from "node:crypto";
import {
  approvedRitualRevisionSchema,
  approveRitualLearningProposal,
  createRitualRun,
  createRitualRunReceipt,
  createRitualTestReceipt,
  reduceRitualRun,
  ritualRunCancelRequestSchema,
  ritualRunControllerResultSchema,
  ritualRunRequestSchema,
  ritualRunStepApprovalRequestSchema,
  ritualTestRunControllerResultSchema,
  ritualTestRunRequestSchema,
  ritualLearningApprovalRequestSchema,
  ritualLearningFeedbackRequestSchema,
  validateRitualTestRunResult,
  validateRitualLearningResult,
  ritualStewardContextSchema,
  validateRitualStewardResult,
  type ApprovedRitualRevision,
  type RitualTestReceipt,
  type RitualTestRunControllerResult,
  type RitualLearningProposal,
  type RitualLearningResult,
  type RitualRun,
  type RitualRunControllerResult,
  type RitualRunReceipt,
  type RitualStewardResult,
} from "@village/contracts";
import type { RitualStewardProvider } from "../model-provider/ritual-steward.js";
import { createVillageId } from "./local-village-id.js";
import {
  DeterministicRitualRunExecutor,
  type RitualRunExecutor,
} from "./ritual-run-executor.js";

export interface RitualPersistence {
  latestSnapshot(): Promise<{
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
    run: RitualRun | null;
    runReceipt: RitualRunReceipt | null;
  }>;
  find(ritualId: string): Promise<ApprovedRitualRevision | null>;
  findReceipt(receiptId: string): Promise<RitualTestReceipt | null>;
  findLearningProposal(
    proposalId: string,
  ): Promise<RitualLearningProposal | null>;
  save(ritual: ApprovedRitualRevision): Promise<void>;
  saveReceipt(receipt: RitualTestReceipt): Promise<void>;
  saveLearningProposal(proposal: RitualLearningProposal): Promise<void>;
  findRunWithApprovedRevision(runId: string): Promise<{
    run: RitualRun;
    approved: ApprovedRitualRevision;
  } | null>;
  findNonterminalRun(
    ritualId: string,
    ritualRevision: number,
  ): Promise<RitualRun | null>;
  saveRun(run: RitualRun): Promise<void>;
  completeRun(run: RitualRun, receipt: RitualRunReceipt): Promise<void>;
}

interface RitualControllerDependencies {
  createId(prefix: "rrn" | "rcp" | "rlp"): string;
  now(): string;
  runExecutor?: RitualRunExecutor;
}

export class RitualBuilderController {
  private runOperationTail: Promise<void> = Promise.resolve();
  private readonly runExecutor: RitualRunExecutor;

  constructor(
    private readonly provider: RitualStewardProvider,
    private readonly repository: RitualPersistence,
    private readonly dependencies: RitualControllerDependencies = {
      createId: createVillageId,
      now: () => new Date().toISOString(),
      runExecutor: new DeterministicRitualRunExecutor(),
    },
  ) {
    this.runExecutor =
      dependencies.runExecutor ?? new DeterministicRitualRunExecutor();
  }

  async draft(candidate: unknown): Promise<RitualStewardResult> {
    const context = ritualStewardContextSchema.parse(candidate);
    return validateRitualStewardResult(
      context,
      await this.provider.draft(context),
    );
  }

  async loadLatestState(): Promise<{
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
    run: RitualRun | null;
    runReceipt: RitualRunReceipt | null;
  }> {
    return this.enqueueRun(async () => {
      const snapshot = await this.repository.latestSnapshot();
      if (
        !snapshot.approved ||
        !snapshot.run ||
        (snapshot.run.status !== "QUEUED" && snapshot.run.status !== "RUNNING")
      ) {
        return snapshot;
      }
      const interrupted = reduceRitualRun(snapshot.run, snapshot.approved, {
        type: "FAIL",
        failureCode: "INTERRUPTED",
        occurredAt: this.dependencies.now(),
      });
      await this.repository.saveRun(interrupted);
      return { ...snapshot, run: interrupted };
    });
  }

  async approve(candidate: unknown): Promise<ApprovedRitualRevision> {
    const ritual = approvedRitualRevisionSchema.parse(candidate);
    await this.repository.save(ritual);
    return ritual;
  }

  startRun(candidate: unknown): Promise<RitualRunControllerResult> {
    return this.enqueueRun(async () => {
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
        return ritualRunControllerResultSchema.parse({
          status: "run",
          run: existing,
        });
      }
      let run = createRitualRun({
        approved: ritual,
        request,
        runId: this.dependencies.createId("rrn"),
        createdAt: this.dependencies.now(),
      });
      await this.repository.saveRun(run);
      run = reduceRitualRun(run, ritual, {
        type: "START",
        occurredAt: this.dependencies.now(),
      });
      await this.repository.saveRun(run);
      return this.driveRun(ritual, run);
    });
  }

  approveRunStep(candidate: unknown): Promise<RitualRunControllerResult> {
    return this.enqueueRun(async () => {
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
      return this.driveRun(ritual, approved);
    });
  }

  cancelRun(candidate: unknown): Promise<RitualRunControllerResult> {
    return this.enqueueRun(async () => {
      const request = ritualRunCancelRequestSchema.parse(candidate);
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

  close(): Promise<void> {
    return this.provider.close();
  }

  private async driveRun(
    ritual: ApprovedRitualRevision,
    initial: RitualRun,
  ): Promise<RitualRunControllerResult> {
    let run = initial;
    let durableRun = initial;
    try {
      while (run.status === "RUNNING" && run.currentStepKey) {
        const executed = await this.runExecutor.completeCurrentStep({
          approved: ritual,
          run,
        });
        if (executed.externalEffects.length !== 0) {
          throw new Error("RITUAL_RUN_POLICY_DENIED");
        }
        run = reduceRitualRun(run, ritual, {
          type: "COMPLETE_STEP",
          stepKey: executed.stepKey,
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
    run = reduceRitualRun(run, ritual, {
      type: "COMPLETE_RUN",
      outcome: "NEEDS_REVIEW",
      occurredAt: this.dependencies.now(),
    });
    const receipt = createRitualRunReceipt({
      approved: ritual,
      run,
      receiptId: this.dependencies.createId("rcp"),
      summary: `The deterministic fixture completed all ${run.steps.length} approved orchestration ${run.steps.length === 1 ? "step" : "steps"}.`,
      recordedAt: this.dependencies.now(),
    });
    await this.repository.completeRun(run, receipt);
    return ritualRunControllerResultSchema.parse({
      status: "receipt",
      run,
      receipt,
    });
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
