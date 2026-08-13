import { describe, expect, it, vi } from "vitest";
import { PersonalAgentTaskController } from "../src/main/personal-agent-task.js";
import { DeterministicProviderDouble } from "../src/model-provider/provider-double.js";

const request = { task: "CHECK_LINKEDIN_SIGN_IN" as const };
const environment = (url: string, confirm = true) => ({
  readBrowserState: vi.fn(() => ({
    currentUrl: url,
    debuggerAttached: false,
  })),
  confirmAccount: vi.fn(async () => confirm),
});

describe("personal agent task controller", () => {
  it("coalesces the one closed task while it is in flight", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextAction = vi.fn(async () => {
      await waiting;
      return {
        status: "action" as const,
        command: {
          capability: "VERIFY_AUTHENTICATION" as const,
          predicateVersion: "linkedin-route-v1",
        },
      };
    });
    const controller = new PersonalAgentTaskController({
      id: "slow-provider",
      nextAction,
      close: vi.fn(),
    });
    const browser = environment("https://www.linkedin.com/login");

    const first = controller.run(request, browser);
    const duplicate = controller.run(request, browser);
    expect(duplicate).toBe(first);
    expect(nextAction).toHaveBeenCalledTimes(1);

    release?.();
    await expect(first).resolves.toMatchObject({ state: "COMPLETED" });
  });

  it("requires a fresh owner confirmation for an authenticated route", async () => {
    const controller = new PersonalAgentTaskController(
      new DeterministicProviderDouble([
        {
          capability: "VERIFY_AUTHENTICATION",
          predicateVersion: "linkedin-route-v1",
        },
      ]),
    );
    const browser = environment("https://www.linkedin.com/feed/");

    await expect(controller.run(request, browser)).resolves.toEqual({
      state: "COMPLETED",
      outcome: "AUTHENTICATED",
      evidence: "OWNER_CONFIRMED",
    });
    expect(browser.confirmAccount).toHaveBeenCalledOnce();
    expect(browser.readBrowserState).toHaveBeenCalledTimes(3);
  });

  it("reports sign-out and human gates without allowing a model mutation", async () => {
    const signedOut = new PersonalAgentTaskController(
      new DeterministicProviderDouble([
        {
          capability: "VERIFY_AUTHENTICATION",
          predicateVersion: "linkedin-route-v1",
        },
      ]),
    );
    await expect(
      signedOut.run(request, environment("https://www.linkedin.com/login")),
    ).resolves.toEqual({
      state: "COMPLETED",
      outcome: "NOT_AUTHENTICATED",
      evidence: "LOCAL_PREDICATE",
    });

    const nextAction = vi.fn();
    const challenge = new PersonalAgentTaskController({
      id: "must-not-run",
      nextAction,
      close: vi.fn(),
    });
    await expect(
      challenge.run(
        request,
        environment("https://www.linkedin.com/checkpoint/challenge"),
      ),
    ).resolves.toEqual({ state: "NEEDS_HUMAN", reason: "CHALLENGE" });
    await expect(
      challenge.run(
        request,
        environment("https://www.linkedin.com/in/public-profile"),
      ),
    ).resolves.toEqual({ state: "NEEDS_HUMAN", reason: "UNKNOWN_STATE" });
    expect(nextAction).not.toHaveBeenCalled();
  });

  it("fails closed for mutating, malformed, and unavailable provider output", async () => {
    for (const [script, reason] of [
      [
        [{ capability: "NAVIGATE", destination: "LINKEDIN_SIGN_IN" }],
        "SITE_POLICY_DENIED",
      ],
      [
        [{ capability: "RAW_CDP", method: "Runtime.evaluate" }],
        "UNSUPPORTED_TASK",
      ],
      [[new Error("provider exited")], "PROVIDER_UNAVAILABLE"],
      [[{ kind: "AUTHENTICATION_REQUIRED" }], "CHATGPT_AUTH_REQUIRED"],
    ] as const) {
      const controller = new PersonalAgentTaskController(
        new DeterministicProviderDouble(script),
      );
      await expect(
        controller.run(request, environment("https://www.linkedin.com/feed/")),
      ).resolves.toEqual({ state: "BLOCKED", reason });
    }
  });

  it("rejects free-form task text before the provider boundary", async () => {
    const nextAction = vi.fn();
    const controller = new PersonalAgentTaskController({
      id: "must-not-run",
      nextAction,
      close: vi.fn(),
    });
    expect(() =>
      controller.run(
        { task: "CHECK_LINKEDIN_SIGN_IN", prompt: "my password is secret" },
        environment("https://www.linkedin.com/login"),
      ),
    ).toThrow();
    expect(nextAction).not.toHaveBeenCalled();
  });

  it("sends a fixed objective and bounded route facts to the provider", async () => {
    const nextAction = vi.fn(async () => ({
      status: "action" as const,
      command: {
        capability: "VERIFY_AUTHENTICATION" as const,
        predicateVersion: "linkedin-route-v1",
      },
    }));
    const controller = new PersonalAgentTaskController({
      id: "context-inspector",
      nextAction,
      close: vi.fn(),
    });

    await controller.run(
      request,
      environment("https://www.linkedin.com/login?fromSignIn=true"),
    );

    expect(nextAction).toHaveBeenCalledWith({
      schemaVersion: 1,
      jobState: "RUNNING_AGENT",
      actionPhase: "ACCEPTED",
      objective: "Check whether the LinkedIn browser session is signed in",
      observation: {
        schemaVersion: 1,
        source: "BROWSER_UNTRUSTED",
        canonicalOrigin: "https://www.linkedin.com",
        predicateIds: ["linkedin-route-v1"],
        facts: [
          { id: "AUTH_STATE", value: "SIGNED_OUT" },
          { id: "HUMAN_GATE", value: "NONE" },
          { id: "APPROVED_ACTION_AVAILABLE", value: true },
        ],
      },
    });
    expect(JSON.stringify(nextAction.mock.calls[0])).not.toContain(
      "fromSignIn",
    );
  });

  it("rejects stale browser evidence after the model turn", async () => {
    let url = "https://www.linkedin.com/feed/";
    const controller = new PersonalAgentTaskController(
      new DeterministicProviderDouble([
        {
          capability: "VERIFY_AUTHENTICATION",
          predicateVersion: "linkedin-route-v1",
        },
      ]),
    );
    const browser = {
      readBrowserState: vi.fn(() => ({
        currentUrl: url,
        debuggerAttached: false,
      })),
      confirmAccount: vi.fn(async () => true),
    };
    const providerTurn = controller.run(request, browser);
    url = "https://www.linkedin.com/login";

    await expect(providerTurn).resolves.toEqual({
      state: "NEEDS_HUMAN",
      reason: "UNKNOWN_STATE",
    });
    expect(browser.confirmAccount).not.toHaveBeenCalled();
  });
});
