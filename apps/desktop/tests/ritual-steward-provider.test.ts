import { describe, expect, it, vi } from "vitest";
import { CodexRitualStewardProvider } from "../src/model-provider/ritual-steward.js";

const context = {
  schemaVersion: 1 as const,
  draftId: "rtd_01J00000000000000000000000",
  requestRevision: 1,
  ownerPurpose: "Review my sales pipeline and prepare the next follow-ups.",
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
    expect(turn.options).toEqual({
      toolName: "village_ritual_draft",
      timeoutMs: 30_000,
    });
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
});
