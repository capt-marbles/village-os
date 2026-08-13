import { describe, expect, it, vi } from "vitest";
import { modelProviderAccountSnapshotSchema } from "@village/contracts";
import {
  ModelProviderAccountController,
  type ManagedModelProviderAccount,
} from "../src/main/model-provider-account.js";

function account(
  overrides: Partial<ManagedModelProviderAccount> = {},
): ManagedModelProviderAccount {
  return {
    start: vi.fn(async () => undefined),
    accountStatus: vi.fn(async () => ({
      status: "authentication_required" as const,
    })),
    startManagedChatGptLogin: vi.fn(async () => ({
      loginId: "login-1",
      authUrl: "https://auth.openai.com/authorize?client_id=codex",
    })),
    cancelManagedChatGptLogin: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("model provider account controller", () => {
  it("moves from account check through managed ChatGPT authentication", async () => {
    let signedIn = false;
    const provider = account({
      accountStatus: vi.fn(async () =>
        signedIn
          ? ({ status: "authenticated", accountType: "chatgpt" } as const)
          : ({ status: "authentication_required" } as const),
      ),
    });
    const open = vi.fn(async () => undefined);
    const controller = new ModelProviderAccountController(provider, open);

    await expect(controller.refresh()).resolves.toMatchObject({
      state: "AUTHENTICATION_REQUIRED",
      provider: "CHATGPT",
    });
    await expect(controller.beginLogin()).resolves.toMatchObject({
      state: "AUTHENTICATING",
    });
    expect(open).toHaveBeenCalledWith(
      "https://auth.openai.com/authorize?client_id=codex",
    );

    signedIn = true;
    await expect(controller.refresh()).resolves.toMatchObject({
      state: "AUTHENTICATED",
      accountType: "chatgpt",
    });
    await controller.close();
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it("fails closed before opening an untrusted managed-login URL", async () => {
    const open = vi.fn(async () => undefined);
    const controller = new ModelProviderAccountController(
      account({
        startManagedChatGptLogin: vi.fn(async () => ({
          loginId: "login-hostile",
          authUrl: "https://attacker.example/steal",
        })),
      }),
      open,
    );

    await controller.refresh();
    await expect(controller.beginLogin()).resolves.toMatchObject({
      state: "UNAVAILABLE",
      errorCode: "UNTRUSTED_AUTH_URL",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("cancels only the active login and returns to the signed-out state", async () => {
    const provider = account();
    const controller = new ModelProviderAccountController(
      provider,
      async () => undefined,
    );

    await controller.refresh();
    await controller.beginLogin();
    await expect(controller.cancelLogin()).resolves.toMatchObject({
      state: "AUTHENTICATION_REQUIRED",
    });
    expect(provider.cancelManagedChatGptLogin).toHaveBeenCalledWith("login-1");
    await expect(controller.cancelLogin()).resolves.toMatchObject({
      state: "AUTHENTICATION_REQUIRED",
    });
    expect(provider.cancelManagedChatGptLogin).toHaveBeenCalledOnce();
  });

  it("reports provider startup and status failures without exposing details", async () => {
    const controller = new ModelProviderAccountController(
      account({
        start: vi.fn(async () => {
          throw new Error("credential-shaped internal detail");
        }),
      }),
      async () => undefined,
    );

    await expect(controller.refresh()).resolves.toEqual({
      provider: "CHATGPT",
      state: "UNAVAILABLE",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
  });

  it("restarts the provider after a post-start account-status failure", async () => {
    const provider = account({
      accountStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "authentication_required" as const })
        .mockRejectedValueOnce(new Error("app server exited"))
        .mockResolvedValueOnce({ status: "authentication_required" as const }),
    });
    const controller = new ModelProviderAccountController(
      provider,
      async () => undefined,
    );

    await expect(controller.refresh()).resolves.toMatchObject({
      state: "AUTHENTICATION_REQUIRED",
    });
    await expect(controller.refresh()).resolves.toMatchObject({
      state: "UNAVAILABLE",
      errorCode: "PROVIDER_UNAVAILABLE",
    });
    await expect(controller.refresh()).resolves.toMatchObject({
      state: "AUTHENTICATION_REQUIRED",
    });

    expect(provider.close).toHaveBeenCalledOnce();
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it("cancels an active login before recovering from a status failure", async () => {
    const provider = account({
      accountStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "authentication_required" as const })
        .mockRejectedValueOnce(new Error("app server exited")),
    });
    const controller = new ModelProviderAccountController(
      provider,
      async () => undefined,
    );

    await controller.beginLogin();
    await expect(controller.refresh()).resolves.toMatchObject({
      state: "UNAVAILABLE",
      errorCode: "PROVIDER_UNAVAILABLE",
    });

    expect(provider.cancelManagedChatGptLogin).toHaveBeenCalledWith("login-1");
    expect(provider.close).toHaveBeenCalledOnce();
  });

  it("preserves a just-completed OAuth login when cancel is requested", async () => {
    let signedIn = false;
    const provider = account({
      accountStatus: vi.fn(async () =>
        signedIn
          ? ({ status: "authenticated", accountType: "chatgpt" } as const)
          : ({ status: "authentication_required" } as const),
      ),
    });
    const controller = new ModelProviderAccountController(
      provider,
      async () => undefined,
    );

    await controller.beginLogin();
    signedIn = true;

    await expect(controller.cancelLogin()).resolves.toEqual({
      provider: "CHATGPT",
      state: "AUTHENTICATED",
      accountType: "chatgpt",
    });
    expect(provider.cancelManagedChatGptLogin).not.toHaveBeenCalled();
  });

  it("keeps the renderer account contract closed to credential-shaped fields", () => {
    expect(
      modelProviderAccountSnapshotSchema.safeParse({
        provider: "CHATGPT",
        state: "AUTHENTICATED",
        accountType: "chatgpt",
        accessToken: "must-not-cross-ipc",
      }).success,
    ).toBe(false);
  });
});
