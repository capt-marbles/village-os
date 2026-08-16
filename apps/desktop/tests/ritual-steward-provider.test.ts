import { describe, expect, it, vi } from "vitest";
import { CodexRitualStewardProvider } from "../src/model-provider/ritual-steward.js";

const context = {
  schemaVersion: 1 as const,
  draftId: "rtd_01J00000000000000000000000",
  requestRevision: 1,
  ownerPurpose: "Review my sales pipeline and prepare the next follow-ups.",
};

const testRunContext = {
  schemaVersion: 1 as const,
  runId: "rrn_01J00000000000000000000000",
  ritual: {
    schemaVersion: 1 as const,
    ritualId: "rtl_01J00000000000000000000000",
    ritualRevision: 1 as const,
    status: "APPROVED" as const,
    approvedDraftId: context.draftId,
    approvedDraftRevision: 3,
    name: "Inbox priorities",
    purpose: "Review my email and identify the highest-priority response.",
    trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
    steps: [
      {
        stepKey: "rank-responses",
        title: "Rank the responses",
        description: "Rank supplied messages by urgency and consequence.",
        actor: { kind: "STEWARD" as const, role: "Steward" },
        approval: "NONE" as const,
      },
    ],
    permissions: ["Read only supplied sample material"],
    completion: "One response priority is explained with evidence.",
    reviewPolicy: {
      ownerReview: "EVERY_RUN" as const,
      learning: "PROPOSE_ONLY" as const,
    },
    approvedAt: "2026-08-15T15:01:00.000Z",
  },
  sample: "Customer A needs an answer before Friday.",
};

const learningContext = {
  schemaVersion: 1 as const,
  proposalId: "rlp_01J00000000000000000000000",
  ritual: testRunContext.ritual,
  receipt: {
    schemaVersion: 1 as const,
    receiptId: "rcp_01J00000000000000000000000",
    runId: testRunContext.runId,
    ritualId: testRunContext.ritual.ritualId,
    ritualRevision: 1,
    mode: "TEST" as const,
    outcome: "NEEDS_REVIEW" as const,
    summary: "The result was useful but too long.",
    evidence: ["The correct item was ranked first."],
    uncertainties: ["The preferred output length was unknown."],
    sampleDigest: "a".repeat(64),
    sampleCharacterCount: 42,
    externalEffects: [] as const,
    recordedAt: "2026-08-15T18:03:00.000Z",
  },
  ownerFeedback: "Keep future results to three concise bullets.",
};

describe("CodexRitualStewardProvider", () => {
  it("constructs its app-server transport lazily", async () => {
    const factory = vi.fn(() => ({
      request: async () => ({ account: null }),
      notify: () => undefined,
      runToolTurn: async () => ({}),
      close: async () => undefined,
    }));
    const provider = new CodexRitualStewardProvider(factory);
    expect(factory).not.toHaveBeenCalled();
    await provider.draft(context);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("closes an active turn immediately and rejects future drafts", async () => {
    let rejectTurn!: (error: Error) => void;
    const close = vi.fn(async () => rejectTurn(new Error("CLOSED")));
    const runToolTurn = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectTurn = reject;
        }),
    );
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: "thread-1" } };
      },
      notify: () => undefined,
      runToolTurn,
      close,
    };
    const provider = new CodexRitualStewardProvider(transport);
    const pending = provider.draft(context);
    await vi.waitFor(() => expect(runToolTurn).toHaveBeenCalledOnce());
    await provider.close();
    expect(close).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({
      status: "waiting",
      reason: "PROVIDER_UNAVAILABLE",
    });
    await expect(provider.draft(context)).resolves.toMatchObject({
      status: "waiting",
      reason: "PROVIDER_UNAVAILABLE",
    });
  });

  it("sends only the bounded purpose and constraints, then locally binds the proposal", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        throw new Error(`unexpected ${method}`);
      },
      notify: () => undefined,
      runToolTurn: async (
        _threadId: string,
        prompt: unknown,
        options: unknown,
      ) => {
        calls.push({ method: "turn", params: { prompt, options } });
        return {
          stewardMessage: "I have shaped a focused draft.",
          name: "Pipeline follow-up review",
          purpose: context.ownerPurpose,
          steps: [
            {
              stepKey: "prepare-review",
              title: "Prepare the review",
              description:
                "Gather the bounded information needed for the review.",
              actor: { kind: "STEWARD", role: "Steward" },
              approval: "OWNER_REQUIRED",
            },
          ],
          permissions: ["Read only connected pipeline records"],
          completion: "A reviewable follow-up list is ready.",
          research: {
            provider: "EXA",
            query: "recent public signals about pipeline accounts",
            maxResults: 5,
            lookbackDays: 30,
          },
        };
      },
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);

    const result = await provider.draft(context);

    expect(result).toMatchObject({
      status: "proposal",
      draftId: context.draftId,
      requestRevision: 1,
      name: "Pipeline follow-up review",
      research: {
        provider: "EXA",
        query: "recent public signals about pipeline accounts",
      },
    });
    const turn = calls.find((call) => call.method === "turn")?.params as {
      prompt: unknown;
      options: unknown;
    };
    const serializedTurn = JSON.stringify(turn.prompt);
    expect(serializedTurn).toContain(context.ownerPurpose);
    expect(serializedTurn).not.toContain(context.draftId);
    expect(serializedTurn).not.toContain("ritualId");
    expect(serializedTurn).not.toContain("RUN_RITUAL");
    expect(serializedTurn).toContain("EXA_OPTIONAL_MAX_30_DAYS");
    expect(turn.options).toEqual({
      toolName: "village_ritual_draft",
      timeoutMs: 30_000,
    });
  });

  it("binds the 30-day starter to the exact locally governed Exa resource", async () => {
    const starterContext = {
      ...context,
      ownerPurpose:
        "Prepare a grounded brief on the most important public-web developments about AI coding agents from the last 30 days.",
      starter: {
        kind: "LAST_30_DAYS" as const,
        topic: "AI coding agents",
      },
    };
    let prompt: unknown;
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: "thread-last-30-days" } };
      },
      notify: () => undefined,
      runToolTurn: async (_threadId: string, candidate: unknown) => {
        prompt = candidate;
        return {
          stewardMessage: "I shaped a bounded signal brief.",
          name: "AI coding agent signals",
          purpose: starterContext.ownerPurpose,
          steps: [
            {
              stepKey: "prepare-brief",
              title: "Prepare the brief",
              description: "Review the bounded recent public-web evidence.",
              actor: { kind: "STEWARD", role: "Steward" },
              approval: "NONE",
            },
          ],
          permissions: ["Read bounded public-web evidence"],
          completion: "A grounded signal brief is ready for review.",
          research: {
            provider: "EXA",
            query: "a broader query the model invented",
            maxResults: 2,
            lookbackDays: 7,
          },
        };
      },
      close: async () => undefined,
    };

    const result = await new CodexRitualStewardProvider(transport).draft(
      starterContext,
    );

    expect(result).toMatchObject({
      status: "proposal",
      research: {
        provider: "EXA",
        query: "AI coding agents",
        maxResults: 5,
        lookbackDays: 30,
      },
    });
    expect(prompt).toMatchObject({
      starter: {
        kind: "LAST_30_DAYS",
        topic: "AI coding agents",
      },
    });
    expect(JSON.stringify(prompt)).not.toContain(starterContext.draftId);
  });

  it("fails closed when ChatGPT authentication is unavailable", async () => {
    const transport = {
      request: async (method: string) =>
        method === "initialize" ? {} : { account: null },
      notify: () => undefined,
      runToolTurn: async () => ({ extra: "hostile" }),
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);
    await expect(provider.draft(context)).resolves.toMatchObject({
      status: "waiting",
      reason: "AUTHENTICATION_REQUIRED",
    });
  });

  it("creates a fresh transport after a process failure", async () => {
    const good = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: "thread-2" } };
      },
      notify: () => undefined,
      runToolTurn: async () => ({
        stewardMessage: "Draft ready.",
        name: "Pipeline review",
        purpose: context.ownerPurpose,
        steps: [
          {
            stepKey: "prepare-review",
            title: "Prepare the review",
            description: "Gather bounded records for the review.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "OWNER_REQUIRED",
          },
        ],
        permissions: ["Read only connected records"],
        completion: "A reviewable result is ready.",
      }),
      close: vi.fn(async () => undefined),
    };
    const failed = {
      ...good,
      request: vi.fn(async () => {
        throw new Error("CODEX_APP_SERVER_EXITED");
      }),
    };
    const transports = [failed, good];
    const factory = vi.fn(() => transports.shift()!);
    const provider = new CodexRitualStewardProvider(factory);

    await expect(provider.draft(context)).resolves.toMatchObject({
      status: "waiting",
      reason: "PROVIDER_UNAVAILABLE",
    });
    await expect(provider.draft(context)).resolves.toMatchObject({
      status: "proposal",
      name: "Pipeline review",
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(failed.close).toHaveBeenCalledOnce();
  });

  it("rejects authenticated provider output with extra authority fields", async () => {
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: "thread-1" } };
      },
      notify: () => undefined,
      runToolTurn: async () => ({
        stewardMessage: "Draft ready.",
        name: "Unsafe draft",
        purpose: context.ownerPurpose,
        steps: [],
        permissions: [],
        completion: "Done.",
        runImmediately: true,
      }),
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);
    await expect(provider.draft(context)).resolves.toMatchObject({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("normalizes model-friendly step identifiers before strict validation", async () => {
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: "thread-1" } };
      },
      notify: () => undefined,
      runToolTurn: async () => ({
        stewardMessage: "Draft ready.",
        name: "Email review",
        purpose: context.ownerPurpose,
        steps: [
          {
            stepKey: "Review_Inbox",
            title: "Review the inbox",
            description: "Review the bounded mailbox for response priority.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "NONE",
          },
          {
            stepKey: "Review Inbox",
            title: "Recommend a response",
            description:
              "Present the highest-priority response recommendation.",
            actor: { kind: "STEWARD", role: "Steward" },
            approval: "NONE",
          },
        ],
        permissions: ["Read only connected email"],
        completion: "A response priority recommendation is ready.",
      }),
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);

    await expect(provider.draft(context)).resolves.toMatchObject({
      status: "proposal",
      steps: [{ stepKey: "review-inbox" }, { stepKey: "review-inbox-2" }],
    });
  });

  it("runs an approved Ritual only against supplied sample material and binds the result locally", async () => {
    const turns: Array<{ prompt: unknown; options: unknown }> = [];
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: `thread-${method}` } };
      },
      notify: () => undefined,
      runToolTurn: async (
        _threadId: string,
        prompt: unknown,
        options: unknown,
      ) => {
        turns.push({ prompt, options });
        return {
          summary: "Customer A is the highest-priority response.",
          evidence: ["The supplied deadline is Friday."],
          uncertainties: ["The commercial impact was not supplied."],
        };
      },
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);

    await expect(provider.testRun(testRunContext)).resolves.toMatchObject({
      status: "result",
      runId: testRunContext.runId,
      ritualId: testRunContext.ritual.ritualId,
      ritualRevision: 1,
    });
    expect(turns[0]?.options).toEqual({
      toolName: "village_ritual_test_result",
      timeoutMs: 30_000,
    });
    const prompt = JSON.stringify(turns[0]?.prompt);
    expect(prompt).toContain(testRunContext.sample);
    expect(prompt).toContain(testRunContext.ritual.completion);
    expect(prompt).not.toContain(testRunContext.runId);
    expect(prompt).not.toContain(testRunContext.ritual.ritualId);
    expect(prompt).toContain('"externalEffects":"NONE"');
  });

  it("uses a fresh ephemeral thread for every independent Test Run", async () => {
    let threadStarts = 0;
    const usedThreads: string[] = [];
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "thread/start") {
          threadStarts += 1;
          return { thread: { id: `test-thread-${threadStarts}` } };
        }
        return {};
      },
      notify: () => undefined,
      runToolTurn: async (threadId: string) => {
        usedThreads.push(threadId);
        return {
          summary: "Customer A is the highest-priority response.",
          evidence: ["The supplied deadline is Friday."],
          uncertainties: [],
        };
      },
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);

    await provider.testRun(testRunContext);
    await provider.testRun({
      ...testRunContext,
      runId: "rrn_01J00000000000000000000001",
      sample: "A different representative sample.",
    });

    expect(threadStarts).toBe(2);
    expect(usedThreads).toEqual(["test-thread-1", "test-thread-2"]);
  });

  it("proposes learning from bounded evidence without exposing lineage ids", async () => {
    const turns: Array<{ prompt: unknown; options: unknown }> = [];
    const transport = {
      request: async (method: string) => {
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        return { thread: { id: "learning-thread-1" } };
      },
      notify: () => undefined,
      runToolTurn: async (
        _threadId: string,
        prompt: unknown,
        options: unknown,
      ) => {
        turns.push({ prompt, options });
        return {
          stewardMessage: "I propose a more concise result.",
          rationale: "The owner asked for a shorter review.",
          proposedDefinition: {
            name: learningContext.ritual.name,
            purpose: learningContext.ritual.purpose,
            trigger: learningContext.ritual.trigger,
            steps: learningContext.ritual.steps,
            permissions: learningContext.ritual.permissions,
            completion: "Three concise bullets are ready for review.",
            reviewPolicy: learningContext.ritual.reviewPolicy,
          },
        };
      },
      close: async () => undefined,
    };
    const provider = new CodexRitualStewardProvider(transport);

    await expect(provider.learn(learningContext)).resolves.toMatchObject({
      status: "proposal",
      proposalId: learningContext.proposalId,
      receiptId: learningContext.receipt.receiptId,
      fromRevision: 1,
    });
    expect(turns[0]?.options).toEqual({
      toolName: "village_ritual_learning_proposal",
      timeoutMs: 30_000,
    });
    const prompt = JSON.stringify(turns[0]?.prompt);
    expect(prompt).toContain(learningContext.ownerFeedback);
    expect(prompt).toContain(learningContext.receipt.summary);
    expect(prompt).not.toContain(learningContext.proposalId);
    expect(prompt).not.toContain(learningContext.ritual.ritualId);
    expect(prompt).not.toContain(learningContext.receipt.receiptId);
    expect(prompt).not.toContain(learningContext.receipt.sampleDigest);
  });
});
