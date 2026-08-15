import {
  approvedRitualRevisionSchema,
  ritualStewardContextSchema,
  validateRitualStewardResult,
  type ApprovedRitualRevision,
  type RitualStewardResult,
} from "@village/contracts";
import type { RitualStewardProvider } from "../model-provider/ritual-steward.js";

export interface RitualPersistence {
  latest(): Promise<ApprovedRitualRevision | null>;
  save(ritual: ApprovedRitualRevision): Promise<void>;
}

export class RitualBuilderController {
  constructor(
    private readonly provider: RitualStewardProvider,
    private readonly repository: RitualPersistence,
  ) {}

  async draft(candidate: unknown): Promise<RitualStewardResult> {
    const context = ritualStewardContextSchema.parse(candidate);
    return validateRitualStewardResult(
      context,
      await this.provider.draft(context),
    );
  }

  async loadLatest(): Promise<ApprovedRitualRevision | null> {
    return this.repository.latest();
  }

  async approve(candidate: unknown): Promise<ApprovedRitualRevision> {
    const ritual = approvedRitualRevisionSchema.parse(candidate);
    await this.repository.save(ritual);
    return ritual;
  }

  close(): Promise<void> {
    return this.provider.close();
  }
}
