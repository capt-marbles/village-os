import { describe, expect, it, vi } from "vitest";
import { GmailOAuthController } from "../src/gmail/gmail-oauth-controller.js";

function tokenStore() {
  let stored:
    { refreshToken: string; accountEmail: string; version: number } | undefined;
  return {
    configure: vi.fn(
      async (candidate: { refreshToken: Uint8Array; accountEmail: string }) => {
        stored = {
          refreshToken: new TextDecoder().decode(candidate.refreshToken),
          accountEmail: candidate.accountEmail,
          version: (stored?.version ?? 0) + 1,
        };
        candidate.refreshToken.fill(0);
        return { configured: true as const, version: stored.version };
      },
    ),
    status: vi.fn(async () =>
      stored
        ? {
            configured: true as const,
            version: stored.version,
            accountEmail: stored.accountEmail,
          }
        : { configured: false as const },
    ),
    withRefreshToken: async <T>(use: (value: Uint8Array) => Promise<T>) => {
      if (!stored) throw new Error("SECRET_REVOKED");
      const value = new TextEncoder().encode(stored.refreshToken);
      try {
        return await use(value);
      } finally {
        value.fill(0);
      }
    },
    revoke: vi.fn(async () => {
      stored = undefined;
    }),
  };
}

describe("Gmail OAuth controller", () => {
  it("uses a system browser, loopback-only callback, PKCE S256, state, and metadata scope", async () => {
    const store = tokenStore();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("approved-code");
        expect(body.get("code_verifier")).toHaveLength(64);
        expect(body.get("redirect_uri")).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
        );
        return Response.json({
          access_token: "transient-access-token",
          refresh_token: "durable-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.metadata",
        });
      }
      expect(url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer transient-access-token",
      });
      return Response.json({ emailAddress: "owner@example.com" });
    });
    const openExternal = vi.fn(async (value: string) => {
      const authorization = new URL(value);
      expect(authorization.origin + authorization.pathname).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth",
      );
      expect(authorization.searchParams.get("client_id")).toBe(
        "desktop-client.apps.googleusercontent.com",
      );
      expect(authorization.searchParams.get("scope")).toBe(
        "https://www.googleapis.com/auth/gmail.metadata",
      );
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorization.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      const state = authorization.searchParams.get("state");
      const redirect = authorization.searchParams.get("redirect_uri");
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      await globalThis.fetch(`${redirect}?code=approved-code&state=${state}`);
    });
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch,
      openExternal,
      timeoutMs: 2_000,
    });

    await expect(controller.connect()).resolves.toEqual({
      status: "snapshot",
      snapshot: {
        provider: "GMAIL",
        state: "CONNECTED",
        accountEmail: "owner@example.com",
        version: 1,
      },
    });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(store.configure).toHaveBeenCalledOnce();
  });

  it("rejects a forged state and closes the callback server", async () => {
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: tokenStore(),
      fetch: vi.fn(),
      openExternal: async (value) => {
        const redirect = new URL(value).searchParams.get("redirect_uri");
        await globalThis.fetch(`${redirect}?code=stolen&state=forged`);
      },
      timeoutMs: 2_000,
    });

    await expect(controller.connect()).resolves.toEqual({
      status: "rejected",
      reason: "OAUTH_STATE_MISMATCH",
    });
    await expect(controller.status()).resolves.toEqual({
      provider: "GMAIL",
      state: "DISCONNECTED",
    });
  });

  it("ignores unrelated loopback requests before accepting the OAuth callback", async () => {
    const store = tokenStore();
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch: vi.fn(async (input) =>
        String(input) === "https://oauth2.googleapis.com/token"
          ? Response.json({
              access_token: "transient-access-token",
              refresh_token: "durable-refresh-token",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "https://www.googleapis.com/auth/gmail.metadata",
            })
          : Response.json({ emailAddress: "owner@example.com" }),
      ),
      openExternal: async (value) => {
        const authorization = new URL(value);
        const redirect = new URL(
          authorization.searchParams.get("redirect_uri")!,
        );
        const unrelated = new URL(redirect);
        unrelated.pathname = "/unrelated";
        await expect(globalThis.fetch(unrelated)).resolves.toMatchObject({
          status: 404,
        });
        redirect.searchParams.set("code", "approved-code");
        redirect.searchParams.set(
          "state",
          authorization.searchParams.get("state")!,
        );
        await globalThis.fetch(redirect);
      },
      timeoutMs: 2_000,
    });

    await expect(controller.connect()).resolves.toMatchObject({
      status: "snapshot",
      snapshot: { state: "CONNECTED" },
    });
    expect(store.configure).toHaveBeenCalledOnce();
  });

  it("allows only one connect and supports abort and close", async () => {
    const abort = new AbortController();
    let opened!: () => void;
    const openedPromise = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: tokenStore(),
      fetch: vi.fn(),
      openExternal: async () => opened(),
      timeoutMs: 2_000,
    });
    const pending = controller.connect({ signal: abort.signal });
    await openedPromise;

    await expect(controller.connect()).resolves.toEqual({
      status: "rejected",
      reason: "OAUTH_CONNECT_IN_PROGRESS",
    });
    abort.abort();
    await expect(pending).resolves.toEqual({
      status: "rejected",
      reason: "OAUTH_CANCELED",
    });

    const closing = controller.connect();
    await controller.close();
    await expect(closing).resolves.toEqual({
      status: "rejected",
      reason: "OAUTH_CANCELED",
    });
  });

  it("keeps access tokens in memory, refreshes them, and disconnects locally even if revocation fails", async () => {
    const store = tokenStore();
    const refresh = new TextEncoder().encode("refresh-secret");
    await store.configure({
      refreshToken: refresh,
      accountEmail: "me@test.dev",
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        expect(
          new URLSearchParams(String(init?.body)).get("refresh_token"),
        ).toBe("refresh-secret");
        return Response.json({
          access_token: "refreshed-access",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (String(input) === "https://oauth2.googleapis.com/revoke") {
        throw new TypeError("offline");
      }
      throw new Error("unexpected request");
    });
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch,
      openExternal: vi.fn(),
    });

    await expect(
      controller.withAccessToken(async (token) =>
        new TextDecoder().decode(token),
      ),
    ).resolves.toBe("refreshed-access");
    await expect(controller.disconnect()).resolves.toEqual({
      status: "snapshot",
      snapshot: { provider: "GMAIL", state: "DISCONNECTED" },
    });
    expect(store.revoke).toHaveBeenCalledOnce();
  });

  it("reports missing client configuration without starting OAuth", async () => {
    const controller = new GmailOAuthController({
      clientId: "",
      tokenStore: tokenStore(),
      fetch: vi.fn(),
      openExternal: vi.fn(),
    });

    await expect(controller.status()).resolves.toEqual({
      provider: "GMAIL",
      state: "CONFIGURATION_REQUIRED",
      reason: "OAUTH_CLIENT_ID_REQUIRED",
    });
    await expect(controller.connect()).resolves.toEqual({
      status: "snapshot",
      snapshot: {
        provider: "GMAIL",
        state: "CONFIGURATION_REQUIRED",
        reason: "OAUTH_CLIENT_ID_REQUIRED",
      },
    });
  });

  it("revokes an invalid refresh grant after releasing vault access", async () => {
    const store = tokenStore();
    const refresh = new TextEncoder().encode("expired-refresh-secret");
    await store.configure({
      refreshToken: refresh,
      accountEmail: "me@test.dev",
    });
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch: vi.fn(async () =>
        Response.json(
          { error: "invalid_grant", error_description: "Token expired" },
          { status: 400 },
        ),
      ),
      openExternal: vi.fn(),
    });

    await expect(
      controller.withAccessToken(async () => undefined),
    ).rejects.toThrow("SECRET_REVOKED");
    expect(store.revoke).toHaveBeenCalledOnce();
    await expect(controller.status()).resolves.toEqual({
      provider: "GMAIL",
      state: "DISCONNECTED",
    });
  });

  it("coalesces concurrent refreshes into one bounded token request", async () => {
    const store = tokenStore();
    await store.configure({
      refreshToken: new TextEncoder().encode("shared-refresh-secret"),
      accountEmail: "me@test.dev",
    });
    let resolveRefresh!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => response);
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch,
      openExternal: vi.fn(),
      timeoutMs: 2_000,
    });

    const first = controller.withAccessToken(async (token) =>
      new TextDecoder().decode(token),
    );
    const second = controller.withAccessToken(async (token) =>
      new TextDecoder().decode(token),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    resolveRefresh(
      Response.json({
        access_token: "coalesced-access",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      "coalesced-access",
      "coalesced-access",
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds refresh and remote revocation without delaying local deletion", async () => {
    const store = tokenStore();
    await store.configure({
      refreshToken: new TextEncoder().encode("stalled-refresh-secret"),
      accountEmail: "me@test.dev",
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>(() => undefined),
    );
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch,
      openExternal: vi.fn(),
      timeoutMs: 5,
    });

    await expect(
      controller.withAccessToken(async () => undefined),
    ).rejects.toThrow();
    await expect(controller.disconnect()).resolves.toEqual({
      status: "snapshot",
      snapshot: { provider: "GMAIL", state: "DISCONNECTED" },
    });
    expect(store.revoke).toHaveBeenCalled();
  });

  it("cannot restore an access token after disconnect aborts a refresh", async () => {
    const store = tokenStore();
    await store.configure({
      refreshToken: new TextEncoder().encode("disconnect-race-secret"),
      accountEmail: "me@test.dev",
    });
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (String(input) === "https://oauth2.googleapis.com/revoke") {
        expect(new URLSearchParams(String(init?.body)).get("token")).toBe(
          "disconnect-race-secret",
        );
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return refreshResponse;
    });
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch,
      openExternal: vi.fn(),
      timeoutMs: 2_000,
    });

    const access = controller.withAccessToken(async () => "unexpected");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(controller.disconnect()).resolves.toMatchObject({
      status: "snapshot",
      snapshot: { state: "DISCONNECTED" },
    });
    resolveRefresh(
      Response.json({
        access_token: "late-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await expect(access).rejects.toThrow();
    await expect(
      controller.withAccessToken(async () => "unexpected"),
    ).rejects.toThrow("SECRET_REVOKED");
  });

  it("times out a stalled authorization-code exchange", async () => {
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: tokenStore(),
      fetch: vi.fn(() => new Promise<Response>(() => undefined)),
      openExternal: async (value) => {
        const authorization = new URL(value);
        const redirect = authorization.searchParams.get("redirect_uri");
        const state = authorization.searchParams.get("state");
        await globalThis.fetch(`${redirect}?code=approved&state=${state}`);
      },
      timeoutMs: 5,
    });

    await expect(controller.connect()).resolves.toEqual({
      status: "rejected",
      reason: "OAUTH_CANCELED",
    });
  });

  it.each([
    [
      "unknown parameter",
      (url: URL) => url.searchParams.set("extra", "1"),
      "OAUTH_CALLBACK_INVALID",
    ],
    [
      "duplicate state",
      (url: URL) => url.searchParams.append("state", "again"),
      "OAUTH_CALLBACK_INVALID",
    ],
    [
      "duplicate code",
      (url: URL) => url.searchParams.append("code", "again"),
      "OAUTH_CALLBACK_INVALID",
    ],
    [
      "missing code",
      (url: URL) => url.searchParams.delete("code"),
      "OAUTH_CALLBACK_INVALID",
    ],
    [
      "provider denial",
      (url: URL) => {
        url.searchParams.delete("code");
        url.searchParams.set("error", "access_denied");
      },
      "OAUTH_CANCELED",
    ],
  ] as const)("rejects a callback with %s", async (_label, mutate, reason) => {
    const store = tokenStore();
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch: vi.fn(),
      openExternal: async (authorizationValue) => {
        const authorization = new URL(authorizationValue);
        const callback = new URL(
          authorization.searchParams.get("redirect_uri")!,
        );
        callback.searchParams.set("code", "approved-code");
        callback.searchParams.set(
          "state",
          authorization.searchParams.get("state")!,
        );
        mutate(callback);
        await globalThis.fetch(callback);
      },
      timeoutMs: 2_000,
    });

    await expect(controller.connect()).resolves.toEqual({
      status: "rejected",
      reason,
    });
    expect(store.configure).not.toHaveBeenCalled();
  });

  it("revokes a credential committed after disconnect begins", async () => {
    const store = tokenStore();
    const originalConfigure = store.configure.getMockImplementation()!;
    let releaseConfigure!: () => void;
    const configureGate = new Promise<void>((resolve) => {
      releaseConfigure = resolve;
    });
    let configureStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      configureStarted = resolve;
    });
    store.configure.mockImplementationOnce(async (candidate) => {
      configureStarted();
      await configureGate;
      return originalConfigure(candidate);
    });
    const controller = new GmailOAuthController({
      clientId: "desktop-client.apps.googleusercontent.com",
      tokenStore: store,
      fetch: vi.fn(async (input) =>
        String(input).endsWith("/profile")
          ? Response.json({ emailAddress: "owner@example.com" })
          : Response.json({
              access_token: "transient-access-token",
              refresh_token: "durable-refresh-token",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "https://www.googleapis.com/auth/gmail.metadata",
            }),
      ),
      openExternal: async (authorizationValue) => {
        const authorization = new URL(authorizationValue);
        const redirect = authorization.searchParams.get("redirect_uri");
        const state = authorization.searchParams.get("state");
        await globalThis.fetch(`${redirect}?code=approved&state=${state}`);
      },
      timeoutMs: 2_000,
    });

    const connect = controller.connect();
    await started;
    const disconnect = controller.disconnect();
    releaseConfigure();

    await expect(connect).resolves.toEqual({
      status: "rejected",
      reason: "OAUTH_CANCELED",
    });
    await expect(disconnect).resolves.toMatchObject({
      status: "snapshot",
      snapshot: { state: "DISCONNECTED" },
    });
    expect(store.revoke).toHaveBeenCalled();
    await expect(controller.status()).resolves.toMatchObject({
      state: "DISCONNECTED",
    });
  });
});
