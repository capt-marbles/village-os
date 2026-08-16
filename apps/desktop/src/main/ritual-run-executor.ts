import {
  approvedRitualRevisionSchema,
  ritualResearchEvidenceSchema,
  ritualRunSchema,
  webResearchRequestSchema,
  type ApprovedRitualRevision,
  type RitualResearchEvidence,
  type RitualRun,
  type WebResearchWaitingReason,
} from "@village/contracts";
import type { WebResearchProvider } from "../research/exa-search-provider.js";

const DAY_MS = 86_400_000;

export type RitualRunStepExecution =
  | {
      status: "completed";
      stepKey: string;
      research: RitualResearchEvidence | null;
      externalEffects: readonly [];
    }
  | {
      status: "waiting";
      stepKey: string;
      reason: WebResearchWaitingReason;
      externalEffects: readonly [];
    };

export interface RitualRunExecutor {
  completeCurrentStep(input: {
    approved: ApprovedRitualRevision;
    run: RitualRun;
    signal?: AbortSignal;
  }): Promise<RitualRunStepExecution>;
}

export class LocalRitualRunExecutor implements RitualRunExecutor {
  private readonly research: WebResearchProvider | undefined;
  private readonly now: () => string;

  constructor(
    dependencies: {
      research?: WebResearchProvider;
      now?: () => string;
    } = {},
  ) {
    this.research = dependencies.research;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async completeCurrentStep(input: {
    approved: ApprovedRitualRevision;
    run: RitualRun;
    signal?: AbortSignal;
  }): Promise<RitualRunStepExecution> {
    throwIfCanceled(input.signal);
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

    if (
      !approved.research ||
      run.steps.some((candidate) => candidate.research)
    ) {
      return {
        status: "completed",
        stepKey: step.stepKey,
        research: null,
        externalEffects: [],
      };
    }
    if (!this.research) {
      return waiting(step.stepKey, "PROVIDER_UNAVAILABLE");
    }
    const now = new Date(this.now());
    if (!Number.isFinite(now.getTime())) throw new Error("INVALID_RUN_TIME");
    const result = await this.research.search(
      webResearchRequestSchema.parse({
        schemaVersion: 1,
        query: approved.research.query,
        maxResults: approved.research.maxResults,
        publishedAfter: new Date(
          now.getTime() - approved.research.lookbackDays * DAY_MS,
        ).toISOString(),
        ...(approved.research.includeDomains
          ? { includeDomains: approved.research.includeDomains }
          : {}),
      }),
      input.signal ? { signal: input.signal } : {},
    );
    throwIfCanceled(input.signal);
    if (result.status === "waiting") {
      return waiting(step.stepKey, result.reason);
    }
    return {
      status: "completed",
      stepKey: step.stepKey,
      research: sanitizeResearchEvidence(result),
      externalEffects: [],
    };
  }
}

function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("RITUAL_RUN_CANCELED");
}

function sanitizeResearchEvidence(result: {
  provider: "EXA";
  requestId: string;
  sources: readonly {
    title: string;
    url: string;
    publishedAt: string | null;
    author: string | null;
    highlights: readonly string[];
    taint: "UNTRUSTED_WEB";
  }[];
}): RitualResearchEvidence {
  return ritualResearchEvidenceSchema.parse({
    provider: result.provider,
    requestId: result.requestId,
    sources: result.sources.slice(0, 5).map((source) => ({
      title: source.title.slice(0, 160),
      url: source.url,
      publishedAt: source.publishedAt,
      author: source.author?.slice(0, 100) ?? null,
      highlights: source.highlights
        .slice(0, 1)
        .map((highlight) => highlight.slice(0, 500)),
      taint: source.taint,
    })),
  });
}

function waiting(
  stepKey: string,
  reason: WebResearchWaitingReason,
): RitualRunStepExecution {
  return { status: "waiting", stepKey, reason, externalEffects: [] };
}
