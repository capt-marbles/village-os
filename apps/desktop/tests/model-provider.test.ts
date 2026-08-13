import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { BrowserObservation } from "@village/contracts";
import {
  CodexAppServerProvider,
  CodexStdioTransport,
} from "../src/model-provider/codex-app-server.js";
import { DeterministicProviderDouble } from "../src/model-provider/provider-double.js";
import { requestOwnedFixtureAction } from "../src/model-provider/browser-orchestrator.js";
import { createSanitizedModelContext } from "../src/model-provider/sanitized-context.js";

const observation: BrowserObservation = {
  schemaVersion: 1,
  source: "BROWSER_UNTRUSTED",
  canonicalOrigin: "https://fixture.village.test",
  predicateIds: ["fixture-sign-in-form-v1"],
  facts: [
    { id: "AUTH_STATE", value: "SIGNED_OUT" },
    { id: "HUMAN_GATE", value: "NONE" },
    { id: "APPROVED_ACTION_AVAILABLE", value: true },
  ],
};

describe("model provider boundary", () => {
  it("starts once and preempts an active turn on close", async () => {
    let releaseTurn: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let initializeCalls = 0;
    let closeCalls = 0;
    const provider = new CodexAppServerProvider({
      request: async (method: string): Promise<unknown> => {
        if (method === "initialize") {
          initializeCalls += 1;
          return {};
        }
        if (method === "account/read") {
          return { account: { type: "chatgpt" } };
        }
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        throw new Error(`unexpected method ${method}`);
      },
      notify: () => undefined,
      runBrowserActionTurn: async () => {
        await turn;
        return { capability: "OBSERVE", facts: ["AUTH_STATE"] };
      },
      close: async () => {
        closeCalls += 1;
      },
    });

    await Promise.all([provider.start(), provider.start()]);
    expect(initializeCalls).toBe(1);
    const action = provider.nextAction(
      createSanitizedModelContext({
        jobState: "RUNNING_AGENT",
        actionPhase: "ACCEPTED",
        observation,
      }),
    );
    const closing = provider.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCalls).toBe(1);
    await closing;
    expect(closeCalls).toBe(1);
    releaseTurn?.();
    await action;
  });

  it("serializes only bounded facts and treats provider output as an untrusted command candidate", async () => {
    const context = createSanitizedModelContext({
      jobState: "RUNNING_AGENT",
      actionPhase: "ACCEPTED",
      observation,
    });
    expect(JSON.stringify(context)).not.toContain("pageText");
    expect(Object.keys(context.observation)).toEqual([
      "schemaVersion",
      "source",
      "canonicalOrigin",
      "predicateIds",
      "facts",
    ]);

    const provider = new DeterministicProviderDouble([
      { capability: "OBSERVE", facts: ["AUTH_STATE", "HUMAN_GATE"] },
      { capability: "RAW_CDP", method: "Runtime.evaluate" },
    ]);
    await expect(provider.nextAction(context)).resolves.toEqual({
      status: "action",
      command: {
        capability: "OBSERVE",
        facts: ["AUTH_STATE", "HUMAN_GATE"],
      },
    });
    await expect(provider.nextAction(context)).resolves.toEqual({
      status: "waiting",
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
  });

  it("uses Codex managed ChatGPT auth and never receives provider credentials", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      request: async (method: string, params: unknown): Promise<unknown> => {
        calls.push({ method, params });
        if (method === "initialize") return { userAgent: "codex-cli/0.147.0" };
        if (method === "account/read") {
          return { requiresOpenaiAuth: true, account: null };
        }
        if (method === "account/login/start") {
          return {
            type: "chatgpt",
            loginId: "login-local-only",
            authUrl: "https://auth.openai.com/authorize",
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      notify: () => undefined,
      runBrowserActionTurn: async () => ({
        capability: "OBSERVE",
        facts: ["AUTH_STATE"],
      }),
      close: async () => undefined,
    };
    const provider = new CodexAppServerProvider(transport);
    await provider.start();
    await expect(provider.accountStatus()).resolves.toEqual({
      status: "authentication_required",
    });
    await expect(provider.startManagedChatGptLogin()).resolves.toEqual({
      loginId: "login-local-only",
      authUrl: "https://auth.openai.com/authorize",
    });
    expect(calls).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "village-desktop",
            title: "Village Desktop",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      },
      { method: "account/read", params: { refreshToken: false } },
      {
        method: "account/login/start",
        params: {
          type: "chatgpt",
          appBrand: "chatgpt",
          codexStreamlinedLogin: true,
          useHostedLoginSuccessPage: true,
        },
      },
    ]);
  });

  it("aggregates only the named closed tool request after turn completion", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk) => writes.push(String(chunk)));
    const transport = new CodexStdioTransport("codex", ["app-server"], () => ({
      stdin,
      stdout,
      stderr,
      killed: false,
      kill: () => true,
      once: () => undefined,
    }));

    const result = transport.runBrowserActionTurn(
      "thread-1",
      { safe: "context" },
      500,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const turnRequest = JSON.parse(writes[0] ?? "{}") as { id: number };
    expect(JSON.parse(writes[0] ?? "{}").params.input[0]).toEqual({
      type: "text",
      text: '{"safe":"context"}',
      text_elements: [],
    });
    stdout.write(
      [
        {
          jsonrpc: "2.0",
          id: turnRequest.id,
          result: { turn: { id: "turn-1" } },
        },
        {
          jsonrpc: "2.0",
          id: "server-request-99",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            namespace: null,
            tool: "village_browser_action",
            arguments: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
          },
        },
        {
          jsonrpc: "2.0",
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          },
        },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n",
    );

    await expect(result).resolves.toEqual({
      capability: "OBSERVE",
      facts: ["AUTH_STATE"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      writes.some(
        (line) =>
          JSON.parse(line).id === "server-request-99" &&
          JSON.parse(line).result?.success === true,
      ),
    ).toBe(true);
  });

  it("bounds unanswered requests and makes provider close terminal", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const transport = new CodexStdioTransport(
      "codex",
      ["app-server"],
      () => ({
        stdin,
        stdout,
        stderr,
        killed: false,
        kill: () => true,
        once: () => undefined,
      }),
      5,
    );
    await expect(transport.request("account/read", {})).rejects.toThrow(
      "CODEX_APP_SERVER_REQUEST_TIMEOUT",
    );
    await transport.close();

    let threadStarts = 0;
    let transportsCreated = 0;
    const provider = new CodexAppServerProvider(() => {
      transportsCreated += 1;
      return {
        request: async (method: string): Promise<unknown> => {
          if (method === "initialize") return {};
          if (method === "account/read") {
            return {
              requiresOpenaiAuth: true,
              account: { type: "chatgpt", email: null, planType: "plus" },
            };
          }
          if (method === "thread/start") {
            threadStarts += 1;
            return { thread: { id: `thread-${threadStarts}` } };
          }
          throw new Error(`unexpected method ${method}`);
        },
        notify: () => undefined,
        runBrowserActionTurn: async () => ({
          capability: "OBSERVE",
          facts: ["AUTH_STATE"],
        }),
        close: async () => undefined,
      };
    });
    const context = createSanitizedModelContext({
      jobState: "RUNNING_AGENT",
      actionPhase: "ACCEPTED",
      observation,
    });
    await provider.start();
    await provider.nextAction(context);
    await provider.close();
    await expect(provider.start()).rejects.toThrow("CODEX_APP_SERVER_CLOSED");
    expect(threadStarts).toBe(1);
    expect(transportsCreated).toBe(1);
  });

  it("interrupts timed-out turns and contains stdin failures", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const writes: string[] = [];
    stdin.on("data", (chunk) => writes.push(String(chunk)));
    const transport = new CodexStdioTransport(
      "codex",
      ["app-server"],
      () => ({
        stdin,
        stdout,
        stderr,
        killed: false,
        kill: () => true,
        once: () => undefined,
      }),
      50,
    );
    const turn = transport.runBrowserActionTurn("thread-timeout", {}, 5);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = JSON.parse(writes[0] ?? "{}") as { id: number };
    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-timeout" } } })}\n`,
    );
    await expect(turn).rejects.toThrow("CODEX_APP_SERVER_TURN_TIMEOUT");
    expect(
      writes.some((line) => JSON.parse(line).method === "turn/interrupt"),
    ).toBe(true);

    const pending = transport.request("account/read", {});
    stdin.emit("error", new Error("EPIPE"));
    await expect(pending).rejects.toThrow("EPIPE");
    await transport.close();
  });

  it("fails into inspectable waiting states on provider loss and auth expiry", async () => {
    const provider = new DeterministicProviderDouble([
      new Error("PROVIDER_UNAVAILABLE"),
      { kind: "AUTHENTICATION_REQUIRED" },
    ]);
    await expect(
      provider.nextAction(
        createSanitizedModelContext({
          jobState: "RUNNING_AGENT",
          actionPhase: "ACCEPTED",
          observation,
        }),
      ),
    ).resolves.toEqual({
      status: "waiting",
      reason: "PROVIDER_UNAVAILABLE",
    });
    await expect(
      provider.nextAction(
        createSanitizedModelContext({
          jobState: "RUNNING_AGENT",
          actionPhase: "ACCEPTED",
          observation,
        }),
      ),
    ).resolves.toEqual({
      status: "waiting",
      reason: "AUTHENTICATION_REQUIRED",
    });
  });

  it("advertises the complete closed command schema to an authenticated provider", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      request: async (method: string, params: unknown): Promise<unknown> => {
        calls.push({ method, params });
        if (method === "initialize") return {};
        if (method === "account/read") {
          return {
            requiresOpenaiAuth: true,
            account: { type: "chatgpt", email: null, planType: "plus" },
          };
        }
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        throw new Error(`unexpected method ${method}`);
      },
      notify: () => undefined,
      runBrowserActionTurn: async () => ({
        capability: "OBSERVE",
        facts: ["AUTH_STATE"],
      }),
      close: async () => undefined,
    };
    const provider = new CodexAppServerProvider(transport);
    await provider.start();
    await expect(
      provider.nextAction(
        createSanitizedModelContext({
          jobState: "RUNNING_AGENT",
          actionPhase: "ACCEPTED",
          observation,
        }),
      ),
    ).resolves.toEqual({
      status: "action",
      command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
    });

    const threadStart = calls.find((call) => call.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      ephemeral: true,
      experimentalRawEvents: false,
      environments: [],
      dynamicTools: [
        {
          type: "function",
          name: "village_browser_action",
          inputSchema: {
            oneOf: expect.any(Array),
          },
        },
      ],
    });
    expect(JSON.stringify(threadStart?.params)).not.toContain("RAW_CDP");
  });

  it("composes the provider with the owned-fixture policy before returning an action", async () => {
    const context = createSanitizedModelContext({
      jobState: "RUNNING_AGENT",
      actionPhase: "ACCEPTED",
      observation,
    });
    await expect(
      requestOwnedFixtureAction(
        new DeterministicProviderDouble([
          { capability: "NAVIGATE", destination: "LINKEDIN_SIGN_IN" },
        ]),
        context,
      ),
    ).resolves.toEqual({
      status: "waiting",
      reason: "SITE_POLICY_DENIED",
    });
    await expect(
      requestOwnedFixtureAction(
        new DeterministicProviderDouble([
          {
            capability: "FIXTURE_INPUT",
            field: "IDENTIFIER",
            value: "fixture-user",
          },
        ]),
        context,
      ),
    ).resolves.toEqual({
      status: "action",
      command: {
        capability: "FIXTURE_INPUT",
        field: "IDENTIFIER",
        value: "fixture-user",
      },
    });
    await expect(
      requestOwnedFixtureAction(
        new DeterministicProviderDouble([
          { capability: "FIXTURE_INPUT", field: "IDENTIFIER", value: "x" },
        ]),
        createSanitizedModelContext({
          jobState: "RUNNING_AGENT",
          actionPhase: "ACCEPTED",
          observation: {
            ...observation,
            canonicalOrigin: "https://www.linkedin.com",
          },
        }),
      ),
    ).resolves.toEqual({ status: "waiting", reason: "SITE_POLICY_DENIED" });
  });
});
