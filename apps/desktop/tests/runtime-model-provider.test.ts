import { describe, expect, it, vi } from "vitest";
import { createRuntimeModelProviderComposition } from "../src/main/runtime-model-provider.js";

describe("runtime model provider composition", () => {
  it("shares one provider across account, personal, and delegated work", async () => {
    const provider = {
      id: "shared-provider",
      start: vi.fn(async () => undefined),
      accountStatus: vi.fn(async () => ({
        status: "authenticated" as const,
        accountType: "chatgpt" as const,
      })),
      startManagedChatGptLogin: vi.fn(),
      cancelManagedChatGptLogin: vi.fn(),
      nextAction: vi.fn(async () => ({
        status: "action" as const,
        command: {
          capability: "VERIFY_AUTHENTICATION" as const,
          predicateVersion: "linkedin-route-v1",
        },
      })),
      nextSetupAction: vi.fn(),
      replaceSetupThread: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const createProvider = vi.fn(() => provider);
    const composition = createRuntimeModelProviderComposition(
      async () => undefined,
      createProvider,
    );

    await expect(composition.modelProviderAccount.refresh()).resolves.toEqual({
      provider: "CHATGPT",
      state: "AUTHENTICATED",
      accountType: "chatgpt",
    });
    await expect(
      composition.personalAgentTask.run(
        { task: "CHECK_LINKEDIN_SIGN_IN" },
        {
          readBrowserState: () => ({
            currentUrl: "https://www.linkedin.com/login",
            debuggerAttached: false,
          }),
          confirmAccount: async () => true,
        },
      ),
    ).resolves.toMatchObject({ state: "COMPLETED" });

    expect(createProvider).toHaveBeenCalledOnce();
    expect(composition.provider).toBe(provider);
    expect(provider.start).toHaveBeenCalledOnce();
    expect(provider.accountStatus).toHaveBeenCalledOnce();
    expect(provider.nextAction).toHaveBeenCalledOnce();

    await composition.modelProviderAccount.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });
});
