import {
  ritualStewardContextSchema,
  ritualStewardProposalContentJsonSchema,
  ritualStewardProposalContentSchema,
  ritualStewardResultSchema,
  type RitualStewardContext,
  type RitualStewardResult,
} from "@village/contracts";
import type { AppServerTransport } from "./codex-app-server.js";

export interface RitualStewardProvider {
  draft(context: RitualStewardContext): Promise<RitualStewardResult>;
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

  private async draftExclusive(
    candidate: RitualStewardContext,
  ): Promise<RitualStewardResult> {
    const context = ritualStewardContextSchema.parse(candidate);
    if (this.closed) return waiting(context, "PROVIDER_UNAVAILABLE");
    const transport = this.transport ?? this.transportFactory();
    this.transport = transport;
    try {
      if (!this.initialized) {
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
          constraints: {
            maximumSteps: 6,
            externalEffects: "OWNER_APPROVAL_REQUIRED",
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
        "You are the Village Steward. Turn one bounded owner purpose into a concise Ritual draft. Call village_ritual_draft exactly once. Use 1 to 6 semantic steps. Every external effect must require owner approval. Never add credentials, raw source content, URLs, code, tools, execution commands, autonomous learning, or a Run capability.",
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
