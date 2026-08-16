import {
  ritualTestRunProviderContextSchema,
  ritualTestRunResultContentJsonSchema,
  ritualTestRunResultContentSchema,
  ritualTestRunResultSchema,
  ritualLearningContextSchema,
  ritualLearningProposalContentJsonSchema,
  ritualLearningProposalContentSchema,
  ritualLearningResultSchema,
  ritualStewardContextSchema,
  ritualStewardProposalContentJsonSchema,
  ritualStewardProposalContentSchema,
  ritualStewardResultSchema,
  researchForRitualStarter,
  type RitualStewardContext,
  type RitualStewardResult,
  type RitualTestRunProviderContext,
  type RitualTestRunResult,
  type RitualLearningContext,
  type RitualLearningResult,
} from "@village/contracts";
import type { AppServerTransport } from "./codex-app-server.js";

export interface RitualStewardProvider {
  draft(context: RitualStewardContext): Promise<RitualStewardResult>;
  testRun(context: RitualTestRunProviderContext): Promise<RitualTestRunResult>;
  learn(context: RitualLearningContext): Promise<RitualLearningResult>;
  close(): Promise<void>;
}

export class CodexRitualStewardProvider implements RitualStewardProvider {
  private initialized = false;
  private threadId: string | undefined;
  private transport: AppServerTransport | undefined;
  private readonly transportFactory: () => AppServerTransport;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(transport: AppServerTransport | (() => AppServerTransport)) {
    if (typeof transport === "function") this.transportFactory = transport;
    else {
      this.transport = transport;
      this.transportFactory = () => transport;
    }
  }

  draft(candidate: RitualStewardContext): Promise<RitualStewardResult> {
    return this.enqueue(() => this.draftExclusive(candidate));
  }

  testRun(
    candidate: RitualTestRunProviderContext,
  ): Promise<RitualTestRunResult> {
    return this.enqueue(() => this.testRunExclusive(candidate));
  }

  learn(candidate: RitualLearningContext): Promise<RitualLearningResult> {
    return this.enqueue(() => this.learnExclusive(candidate));
  }

  private async learnExclusive(
    candidate: RitualLearningContext,
  ): Promise<RitualLearningResult> {
    const context = ritualLearningContextSchema.parse(candidate);
    if (this.closed) return learningWaiting(context, "PROVIDER_UNAVAILABLE");
    const transport = this.transport ?? this.transportFactory();
    this.transport = transport;
    try {
      await this.ensureInitialized(transport);
      const account = (await transport.request("account/read", {
        refreshToken: false,
      })) as { account?: { type?: unknown } | null };
      if (account.account?.type !== "chatgpt") {
        return learningWaiting(context, "AUTHENTICATION_REQUIRED");
      }
      const threadId = await this.startLearningThread();
      if (!threadId) return learningWaiting(context, "PROVIDER_UNAVAILABLE");
      const raw = await transport.runToolTurn(
        threadId,
        {
          schemaVersion: 1,
          currentRitual: {
            name: context.ritual.name,
            purpose: context.ritual.purpose,
            trigger: context.ritual.trigger,
            steps: context.ritual.steps,
            permissions: context.ritual.permissions,
            completion: context.ritual.completion,
            reviewPolicy: context.ritual.reviewPolicy,
            ...(context.ritual.research
              ? { research: context.ritual.research }
              : {}),
          },
          testReceipt: {
            outcome: context.receipt.outcome,
            summary: context.receipt.summary,
            evidence: context.receipt.evidence,
            uncertainties: context.receipt.uncertainties,
            externalEffects: context.receipt.externalEffects,
          },
          ownerFeedback: context.ownerFeedback,
          constraints: {
            mode: "PROPOSE_ONLY",
            execution: "NO_RUN",
            externalEffects: "NONE",
          },
        },
        { toolName: "village_ritual_learning_proposal", timeoutMs: 30_000 },
      );
      const content = ritualLearningProposalContentSchema.safeParse(
        normalizeProposedDefinitionStepKeys(raw),
      );
      if (!content.success) {
        return learningWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
      }
      return ritualLearningResultSchema.parse({
        status: "proposal",
        proposalId: context.proposalId,
        ritualId: context.ritual.ritualId,
        fromRevision: context.ritual.ritualRevision,
        receiptId: context.receipt.receiptId,
        ownerFeedback: context.ownerFeedback,
        ...content.data,
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        error.message === "CODEX_APP_SERVER_TURN_TIMEOUT";
      if (!timeout) await this.invalidateTransport();
      return learningWaiting(
        context,
        timeout ? "TIME_BUDGET_EXHAUSTED" : "PROVIDER_UNAVAILABLE",
      );
    }
  }

  private async draftExclusive(
    candidate: RitualStewardContext,
  ): Promise<RitualStewardResult> {
    const context = ritualStewardContextSchema.parse(candidate);
    if (this.closed) return waiting(context, "PROVIDER_UNAVAILABLE");
    const transport = this.transport ?? this.transportFactory();
    this.transport = transport;
    try {
      await this.ensureInitialized(transport);
      const account = (await transport.request("account/read", {
        refreshToken: false,
      })) as { account?: { type?: unknown } | null };
      if (account.account?.type !== "chatgpt") {
        return waiting(context, "AUTHENTICATION_REQUIRED");
      }
      if (!this.threadId) await this.startThread();
      if (!this.threadId) return waiting(context, "PROVIDER_UNAVAILABLE");
      const raw = await transport.runToolTurn(
        this.threadId,
        {
          schemaVersion: 1,
          ownerPurpose: context.ownerPurpose,
          ...(context.starter ? { starter: context.starter } : {}),
          constraints: {
            maximumSteps: 6,
            externalEffects: "OWNER_APPROVAL_REQUIRED",
            publicWebResearch: "EXA_OPTIONAL_MAX_30_DAYS",
            learning: "PROPOSE_ONLY",
            execution: "NO_RUN",
          },
        },
        { toolName: "village_ritual_draft", timeoutMs: 30_000 },
      );
      const proposal = ritualStewardProposalContentSchema.safeParse(
        normalizeProposalStepKeys(raw),
      );
      if (!proposal.success) {
        return waiting(context, "MALFORMED_PROVIDER_OUTPUT");
      }
      return ritualStewardResultSchema.parse({
        status: "proposal",
        draftId: context.draftId,
        requestRevision: context.requestRevision,
        ...proposal.data,
        ...(context.starter
          ? { research: researchForRitualStarter(context.starter) }
          : {}),
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        error.message === "CODEX_APP_SERVER_TURN_TIMEOUT";
      if (timeout) this.threadId = undefined;
      else await this.invalidateTransport();
      const reason = timeout ? "TIME_BUDGET_EXHAUSTED" : "PROVIDER_UNAVAILABLE";
      return waiting(context, reason);
    }
  }

  private async testRunExclusive(
    candidate: RitualTestRunProviderContext,
  ): Promise<RitualTestRunResult> {
    const context = ritualTestRunProviderContextSchema.parse(candidate);
    if (this.closed) return testRunWaiting(context, "PROVIDER_UNAVAILABLE");
    const transport = this.transport ?? this.transportFactory();
    this.transport = transport;
    try {
      await this.ensureInitialized(transport);
      const account = (await transport.request("account/read", {
        refreshToken: false,
      })) as { account?: { type?: unknown } | null };
      if (account.account?.type !== "chatgpt") {
        return testRunWaiting(context, "AUTHENTICATION_REQUIRED");
      }
      const testThreadId = await this.startTestThread();
      if (!testThreadId) {
        return testRunWaiting(context, "PROVIDER_UNAVAILABLE");
      }
      const raw = await transport.runToolTurn(
        testThreadId,
        {
          schemaVersion: 1,
          ritual: {
            name: context.ritual.name,
            purpose: context.ritual.purpose,
            steps: context.ritual.steps,
            permissions: context.ritual.permissions,
            completion: context.ritual.completion,
            reviewPolicy: context.ritual.reviewPolicy,
            ...(context.ritual.research
              ? { research: context.ritual.research }
              : {}),
          },
          sample: context.sample,
          constraints: {
            source: "SUPPLIED_SAMPLE_ONLY",
            externalEffects: "NONE",
            learning: "NO_CHANGE",
          },
        },
        { toolName: "village_ritual_test_result", timeoutMs: 30_000 },
      );
      const content = ritualTestRunResultContentSchema.safeParse(raw);
      if (!content.success) {
        return testRunWaiting(context, "MALFORMED_PROVIDER_OUTPUT");
      }
      return ritualTestRunResultSchema.parse({
        status: "result",
        runId: context.runId,
        ritualId: context.ritual.ritualId,
        ritualRevision: context.ritual.ritualRevision,
        ...content.data,
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        error.message === "CODEX_APP_SERVER_TURN_TIMEOUT";
      if (!timeout) await this.invalidateTransport();
      return testRunWaiting(
        context,
        timeout ? "TIME_BUDGET_EXHAUSTED" : "PROVIDER_UNAVAILABLE",
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.invalidateTransport();
  }

  private async startThread(): Promise<void> {
    if (!this.transport) return;
    const created = (await this.transport.request("thread/start", {
      ephemeral: true,
      experimentalRawEvents: false,
      environments: [],
      baseInstructions:
        "You are the Village Steward. Turn one bounded owner purpose into a concise Ritual draft. Call village_ritual_draft exactly once. Use 1 to 6 semantic steps. Add one bounded EXA research resource only when the outcome requires current public-web information; use a focused query, at most 5 results, and a lookback of at most 30 days. When starter.kind is LAST_30_DAYS, shape a grounded public-web signal brief for its exact topic; Village binds the resource locally to that topic, 5 results, and 30 days. Do not claim Reddit, X, YouTube, or engagement-specific coverage. Do not use public-web research for private email, accounts, messages, or connected records. Every external effect must require owner approval. Never add credentials, raw source content, full URLs, code, execution commands, autonomous learning, or a Run capability.",
      dynamicTools: [
        {
          type: "function",
          name: "village_ritual_draft",
          description:
            "Propose a bounded Ritual charter. Village validates it locally and does not execute it.",
          inputSchema: ritualStewardProposalContentJsonSchema,
        },
      ],
    })) as { thread?: { id?: unknown } };
    if (typeof created.thread?.id === "string")
      this.threadId = created.thread.id;
  }

  private async startTestThread(): Promise<string | undefined> {
    if (!this.transport) return undefined;
    const created = (await this.transport.request("thread/start", {
      ephemeral: true,
      experimentalRawEvents: false,
      environments: [],
      baseInstructions:
        "You are the Village Steward running one safe test of an approved Ritual. Use only the supplied sample. Call village_ritual_test_result exactly once with a concise result, evidence grounded in that sample, and honest uncertainties. Do not take external actions, browse, use tools, request credentials, repeat the entire sample, or change the Ritual.",
      dynamicTools: [
        {
          type: "function",
          name: "village_ritual_test_result",
          description:
            "Return the bounded result of a sample-only Ritual test. Village binds and records it locally.",
          inputSchema: ritualTestRunResultContentJsonSchema,
        },
      ],
    })) as { thread?: { id?: unknown } };
    return typeof created.thread?.id === "string"
      ? created.thread.id
      : undefined;
  }

  private async startLearningThread(): Promise<string | undefined> {
    if (!this.transport) return undefined;
    const created = (await this.transport.request("thread/start", {
      ephemeral: true,
      experimentalRawEvents: false,
      environments: [],
      baseInstructions:
        "You are the Village Steward proposing one governed improvement to an approved Ritual. Use only the current Ritual, its bounded Test Receipt, and explicit owner feedback. Call village_ritual_learning_proposal exactly once. Return a complete proposed definition and concise rationale. Do not execute, browse, add credentials or URLs, broaden permissions beyond the feedback, or silently apply the change.",
      dynamicTools: [
        {
          type: "function",
          name: "village_ritual_learning_proposal",
          description:
            "Propose a complete replacement Ritual definition for explicit owner review.",
          inputSchema: ritualLearningProposalContentJsonSchema,
        },
      ],
    })) as { thread?: { id?: unknown } };
    return typeof created.thread?.id === "string"
      ? created.thread.id
      : undefined;
  }

  private async ensureInitialized(
    transport: AppServerTransport,
  ): Promise<void> {
    if (this.initialized) return;
    await transport.request("initialize", {
      clientInfo: {
        name: "village-ritual-steward",
        title: "Village Ritual Steward",
        version: "0.0.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    transport.notify("initialized");
    this.initialized = true;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async invalidateTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.initialized = false;
    this.threadId = undefined;
    await transport?.close().catch(() => undefined);
  }
}

function testRunWaiting(
  context: RitualTestRunProviderContext,
  reason: Extract<RitualTestRunResult, { status: "waiting" }>["reason"],
): RitualTestRunResult {
  return {
    status: "waiting",
    runId: context.runId,
    ritualId: context.ritual.ritualId,
    ritualRevision: context.ritual.ritualRevision,
    reason,
  };
}

function normalizeProposalStepKeys(candidate: unknown): unknown {
  if (!isRecord(candidate) || !Array.isArray(candidate.steps)) return candidate;
  const used = new Set<string>();
  const steps = candidate.steps.map((step, index) => {
    if (!isRecord(step) || typeof step.stepKey !== "string") return step;
    let base = step.stepKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    if (!/^[a-z]/u.test(base)) base = `step-${base}`;
    if (base.length < 2) base = `step-${index + 1}`;
    base = base.slice(0, 48).replace(/-+$/u, "");
    let stepKey = base;
    let duplicate = 2;
    while (used.has(stepKey)) {
      const suffix = `-${duplicate++}`;
      stepKey = `${base.slice(0, 48 - suffix.length).replace(/-+$/u, "")}${suffix}`;
    }
    used.add(stepKey);
    return { ...step, stepKey };
  });
  return { ...candidate, steps };
}

function normalizeProposedDefinitionStepKeys(candidate: unknown): unknown {
  if (!isRecord(candidate) || !isRecord(candidate.proposedDefinition)) {
    return candidate;
  }
  return {
    ...candidate,
    proposedDefinition: normalizeProposalStepKeys(candidate.proposedDefinition),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waiting(
  context: RitualStewardContext,
  reason: Extract<RitualStewardResult, { status: "waiting" }>["reason"],
): RitualStewardResult {
  return {
    status: "waiting",
    draftId: context.draftId,
    requestRevision: context.requestRevision,
    reason,
  };
}

function learningWaiting(
  context: RitualLearningContext,
  reason: Extract<RitualLearningResult, { status: "waiting" }>["reason"],
): RitualLearningResult {
  return {
    status: "waiting",
    proposalId: context.proposalId,
    ritualId: context.ritual.ritualId,
    fromRevision: context.ritual.ritualRevision,
    receiptId: context.receipt.receiptId,
    reason,
  };
}
