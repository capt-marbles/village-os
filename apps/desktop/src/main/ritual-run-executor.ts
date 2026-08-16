import {
  approvedRitualRevisionSchema,
  ritualRunSchema,
  type ApprovedRitualRevision,
  type RitualRun,
} from "@village/contracts";

export interface RitualRunStepExecution {
  stepKey: string;
  externalEffects: readonly [];
}

export interface RitualRunExecutor {
  completeCurrentStep(input: {
    approved: ApprovedRitualRevision;
    run: RitualRun;
  }): Promise<RitualRunStepExecution>;
}

export class DeterministicRitualRunExecutor implements RitualRunExecutor {
  async completeCurrentStep(input: {
    approved: ApprovedRitualRevision;
    run: RitualRun;
  }): Promise<RitualRunStepExecution> {
    const approved = approvedRitualRevisionSchema.parse(input.approved);
    const run = ritualRunSchema.parse(input.run);
    if (
      approved.ritualId !== run.ritualId ||
      approved.ritualRevision !== run.ritualRevision
    ) {
      throw new Error("STALE_RITUAL_RUN");
    }
    if (run.status !== "RUNNING" || !run.currentStepKey) {
      throw new Error("RITUAL_RUN_NOT_EXECUTABLE");
    }
    const step = run.steps.find(
      (candidate) =>
        candidate.stepKey === run.currentStepKey &&
        candidate.status === "RUNNING",
    );
    if (!step) throw new Error("RITUAL_RUN_NOT_EXECUTABLE");

    return {
      stepKey: step.stepKey,
      externalEffects: [],
    };
  }
}
