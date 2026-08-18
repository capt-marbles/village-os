import {
  approvedRitualRevisionSchema,
  gmailMetadataReviewRequestSchema,
  gmailPriorityReportSchema,
  ritualResearchEvidenceSchema,
  ritualRunSchema,
  webResearchRequestSchema,
  type ApprovedRitualRevision,
  type GmailMetadataReviewResult,
  type GmailPriorityReport,
  type RitualResearchEvidence,
  type RitualResearchReport,
  type RitualRun,
} from "@village/contracts";
import type { GmailMailboxProvider } from "../gmail/gmail-metadata-provider.js";
import type { WebResearchProvider } from "../research/exa-search-provider.js";
import type { RitualResearchSynthesizer } from "../model-provider/ritual-steward.js";

const DAY_MS = 86_400_000;

export type RitualRunStepExecution =
  | {
      status: "checkpointed";
      stepKey: string;
      research: RitualResearchEvidence;
      externalEffects: readonly [];
    }
  | {
      status: "completed";
      stepKey: string;
      research: RitualResearchEvidence | null;
      report?: RitualResearchReport | null;
      mailReport?: GmailPriorityReport | null;
      externalEffects: readonly [];
    }
  | {
      status: "waiting";
      stepKey: string;
      reason: RitualRunWaitingReason;
      source: "RESEARCH" | "STEWARD" | "GMAIL";
      research?: RitualResearchEvidence;
      externalEffects: readonly [];
    };

export interface RitualRunExecutor {
  completeCurrentStep(input: {
    approved: ApprovedRitualRevision;
    run: RitualRun;
    signal?: AbortSignal;
  }): Promise<RitualRunStepExecution>;
}

type RitualRunWaitingReason = NonNullable<RitualRun["waitingReason"]>;

export class LocalRitualRunExecutor implements RitualRunExecutor {
  private readonly research: WebResearchProvider | undefined;
  private readonly synthesis: RitualResearchSynthesizer | undefined;
  private readonly gmail: GmailMailboxProvider | undefined;
  private readonly now: () => string;

  constructor(
    dependencies: {
      research?: WebResearchProvider;
      synthesis?: RitualResearchSynthesizer;
      gmail?: GmailMailboxProvider;
      now?: () => string;
    } = {},
  ) {
    this.research = dependencies.research;
    this.synthesis = dependencies.synthesis;
    this.gmail = dependencies.gmail;
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

    const retainedMailReport = run.steps.find(
      (candidate) => candidate.mailReport,
    )?.mailReport;
    if (approved.gmailReview && !retainedMailReport) {
      if (!this.gmail)
        return waiting(step.stepKey, "PROVIDER_UNAVAILABLE", "GMAIL");
      const result = await this.gmail.review(
        gmailMetadataReviewRequestSchema.parse({
          schemaVersion: 1,
          ...approved.gmailReview,
        }),
        input.signal ? { signal: input.signal } : {},
      );
      throwIfCanceled(input.signal);
      if (result.status === "waiting") {
        return waiting(step.stepKey, result.reason, "GMAIL");
      }
      return {
        status: "completed",
        stepKey: step.stepKey,
        research: null,
        mailReport: createMetadataPriorityReport(result),
        externalEffects: [],
      };
    }

    const retainedReport = run.steps.find(
      (candidate) => candidate.report,
    )?.report;
    if (!approved.research || retainedReport) {
      return {
        status: "completed",
        stepKey: step.stepKey,
        research: null,
        externalEffects: [],
      };
    }
    let research = run.steps.find((candidate) => candidate.research)?.research;
    if (!research) {
      if (!this.research)
        return waiting(step.stepKey, "PROVIDER_UNAVAILABLE", "RESEARCH");
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
      if (result.status === "waiting")
        return waiting(step.stepKey, result.reason, "RESEARCH");
      research = sanitizeResearchEvidence(result);
      return {
        status: "checkpointed",
        stepKey: step.stepKey,
        research,
        externalEffects: [],
      };
    }
    if (research.sources.length === 0) {
      return {
        status: "completed",
        stepKey: step.stepKey,
        research,
        report: null,
        externalEffects: [],
      };
    }
    if (!this.synthesis) {
      return waiting(step.stepKey, "PROVIDER_UNAVAILABLE", "STEWARD", research);
    }
    const synthesis = await this.synthesis.synthesizeResearch(
      {
        schemaVersion: 1,
        ritual: {
          name: approved.name,
          purpose: approved.purpose,
          completion: approved.completion,
        },
        sources: research.sources.map((source, index) => ({
          sourceNumber: index + 1,
          title: source.title,
          publishedAt: source.publishedAt,
          author: source.author,
          highlight: source.highlights[0] ?? null,
          taint: source.taint,
        })),
      },
      input.signal ? { signal: input.signal } : {},
    );
    throwIfCanceled(input.signal);
    if (synthesis.status === "waiting") {
      return waiting(
        step.stepKey,
        synthesis.reason === "STALE_STEWARD_RESULT"
          ? "MALFORMED_PROVIDER_OUTPUT"
          : synthesis.reason,
        "STEWARD",
        research,
      );
    }
    return {
      status: "completed",
      stepKey: step.stepKey,
      research,
      report: synthesis.report,
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
  reason: RitualRunWaitingReason,
  source: "RESEARCH" | "STEWARD" | "GMAIL",
  research?: RitualResearchEvidence,
): RitualRunStepExecution {
  return {
    status: "waiting",
    stepKey,
    reason,
    source,
    ...(research ? { research } : {}),
    externalEffects: [],
  };
}

function createMetadataPriorityReport(
  result: Extract<GmailMetadataReviewResult, { status: "result" }>,
): GmailPriorityReport {
  const ranked = result.messages
    .map((message) => ({ message, score: priorityScore(message) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.message.receivedAt) -
          Date.parse(left.message.receivedAt) ||
        left.message.messageNumber - right.message.messageNumber,
    )
    .slice(0, 10);
  return gmailPriorityReportSchema.parse({
    metadataOnly: true,
    reviewedMessageCount: result.messages.length,
    headline:
      ranked.length === 0
        ? "No likely reply priorities were identified from message metadata"
        : `${ranked.length} inbox ${ranked.length === 1 ? "item" : "items"} likely need attention`,
    summary:
      "Village ranked recent unread inbox items using sender, subject, recency, and Gmail labels. Open each message before deciding how to respond.",
    priorities: ranked.map(({ message, score }) => ({
      messageNumber: message.messageNumber,
      from: safeReportText(message.from, 320, "Sender unavailable"),
      subject: safeReportText(message.subject, 500, "Subject unavailable"),
      receivedAt: message.receivedAt,
      priority: score >= 70 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW",
      reason: priorityReason(message),
      responseFocus:
        "Open the full message, verify the request and context, then decide whether and how to reply.",
      uncertainty:
        "Only headers and labels were reviewed; the message body may change this priority.",
    })),
    uncertainties: [
      "Message bodies and attachments were not read.",
      "Header and label signals can miss context, deadlines, and requests inside a message.",
    ],
  });
}

function priorityScore(message: {
  from: string;
  subject: string;
  unread: boolean;
  labelIds: readonly string[];
}): number {
  const subject = message.subject.toLowerCase();
  const sender = message.from.toLowerCase();
  let score = message.unread ? 20 : 0;
  if (message.labelIds.includes("IMPORTANT")) score += 80;
  if (
    /\b(?:urgent|action|required|approval|deadline|reply|respond|today)\b/.test(
      subject,
    )
  )
    score += 40;
  if (/\b(?:no[-_. ]?reply|newsletter|digest|notification)\b/.test(sender))
    score -= 80;
  if (/\b(?:newsletter|digest|sale|promotion|unsubscribe)\b/.test(subject))
    score -= 40;
  return score;
}

function priorityReason(message: {
  subject: string;
  unread: boolean;
  labelIds: readonly string[];
}): string {
  const signals = [
    ...(message.labelIds.includes("IMPORTANT")
      ? ["Gmail marked it important"]
      : []),
    ...(message.unread ? ["it is unread"] : []),
    ...(/\b(?:urgent|action|required|approval|deadline|reply|respond|today)\b/i.test(
      message.subject,
    )
      ? ["the subject suggests a time-sensitive request"]
      : []),
  ];
  return safeReportText(
    signals.length > 0
      ? `${signals.join(", ")}.`
      : "The message remains a possible reply candidate based on its inbox metadata.",
    320,
    "Review the message metadata before responding.",
  );
}

function safeReportText(
  value: string,
  maximum: number,
  fallback: string,
): string {
  const sanitized = value
    .replace(/(?:https?:\/\/|www\.)\S*/gi, "[link removed]")
    .trim()
    .slice(0, maximum);
  return sanitized || fallback;
}
