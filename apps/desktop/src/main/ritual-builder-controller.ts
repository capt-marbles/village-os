import { createHash } from "node:crypto";
import {
  approvedRitualRevisionSchema,
  approveRitualLearningProposal,
  createRitualTestReceipt,
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
  type RitualStewardResult,
} from "@village/contracts";
import type { RitualStewardProvider } from "../model-provider/ritual-steward.js";
import { createVillageId } from "./local-village-id.js";

export interface RitualPersistence {
  latestSnapshot(): Promise<{
    approved: ApprovedRitualRevision | null;
    receipt: RitualTestReceipt | null;
  }>;
  find(ritualId: string): Promise<ApprovedRitualRevision | null>;
  findReceipt(receiptId: string): Promise<RitualTestReceipt | null>;
  findLearningProposal(
    proposalId: string,
  ): Promise<RitualLearningProposal | null>;
  save(ritual: ApprovedRitualRevision): Promise<void>;
  saveReceipt(receipt: RitualTestReceipt): Promise<void>;
  saveLearningProposal(proposal: RitualLearningProposal): Promise<void>;
}

interface RitualControllerDependencies {
  createId(prefix: "rrn" | "rcp" | "rlp"): string;
  now(): string;
}

export class RitualBuilderController {
  constructor(
    private readonly provider: RitualStewardProvider,
    private readonly repository: RitualPersistence,
    private readonly dependencies: RitualControllerDependencies = {
      createId: createVillageId,
      now: () => new Date().toISOString(),
    },
  ) {}

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
  }> {
    return this.repository.latestSnapshot();
  }

  async approve(candidate: unknown): Promise<ApprovedRitualRevision> {
    const ritual = approvedRitualRevisionSchema.parse(candidate);
    await this.repository.save(ritual);
    return ritual;
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
}
