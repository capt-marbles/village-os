import {
  gmailCredentialMutationResultSchema,
  gmailCredentialSnapshotSchema,
  gmailOAuthScopeSchema,
  type GmailCredentialMutationResult,
  type GmailCredentialSnapshot,
} from "@village/contracts";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GmailRefreshTokenSource } from "./gmail-token-store.js";
import { readBoundedResponseBody } from "../net/read-bounded-response-body.js";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const PROFILE_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_METADATA_SCOPE = gmailOAuthScopeSchema.value;
const CALLBACK_PATH = "/oauth/callback";
const MAX_RESPONSE_BYTES = 64 * 1_024;

interface WritableGmailTokenStore extends GmailRefreshTokenSource {
  configure(candidate: {
    refreshToken: Uint8Array;
    accountEmail: string;
  }): Promise<{ configured: true; version: number }>;
  revoke(): Promise<void>;
}

export interface GmailAccessTokenSource {
  withAccessToken<T>(
    use: (accessToken: Uint8Array) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

export interface GmailCredentialOperations {
  status(): Promise<GmailCredentialSnapshot>;
  connect(): Promise<GmailCredentialMutationResult>;
  disconnect(): Promise<GmailCredentialMutationResult>;
  close(): Promise<void>;
}

type RejectionReason = Extract<
  GmailCredentialMutationResult,
  { status: "rejected" }
>["reason"];

class OAuthFlowError extends Error {
  constructor(readonly reason: RejectionReason) {
    super(`GMAIL_${reason}`);
    this.name = "OAuthFlowError";
  }
}

export class GmailOAuthController
  implements GmailAccessTokenSource, GmailCredentialOperations
{
  private readonly clientId: string;
  private readonly tokenStore: WritableGmailTokenStore;
  private readonly request: typeof globalThis.fetch;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly timeoutMs: number;
  private activeConnect: AbortController | undefined;
  private accessToken: Uint8Array | undefined;
  private accessTokenExpiresAt = 0;
  private refreshInFlight: Promise<void> | undefined;
  private refreshController: AbortController | undefined;
  private credentialEpoch = 0;

  constructor(dependencies: {
    clientId: string;
    tokenStore: WritableGmailTokenStore;
    fetch?: typeof globalThis.fetch;
    openExternal: (url: string) => Promise<void>;
    timeoutMs?: number;
  }) {
    this.clientId = dependencies.clientId.trim();
    this.tokenStore = dependencies.tokenStore;
    this.request = dependencies.fetch ?? globalThis.fetch;
    this.openExternal = dependencies.openExternal;
    this.timeoutMs = dependencies.timeoutMs ?? 120_000;
    if (this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error("INVALID_GMAIL_OAUTH_TIMEOUT");
    }
  }

  async status(): Promise<GmailCredentialSnapshot> {
    if (!this.clientId) {
      return gmailCredentialSnapshotSchema.parse({
        provider: "GMAIL",
        state: "CONFIGURATION_REQUIRED",
        reason: "OAUTH_CLIENT_ID_REQUIRED",
      });
    }
    try {
      const state = await this.tokenStore.status();
      return gmailCredentialSnapshotSchema.parse(
        state.configured
          ? {
              provider: "GMAIL",
              state: "CONNECTED",
              accountEmail: state.accountEmail,
              version: state.version,
            }
          : { provider: "GMAIL", state: "DISCONNECTED" },
      );
    } catch {
      return gmailCredentialSnapshotSchema.parse({
        provider: "GMAIL",
        state: "UNAVAILABLE",
        reason: "CREDENTIAL_STORE_UNAVAILABLE",
      });
    }
  }

  async connect(
    options: { signal?: AbortSignal } = {},
  ): Promise<GmailCredentialMutationResult> {
    if (!this.clientId) {
      return gmailCredentialMutationResultSchema.parse({
        status: "snapshot",
        snapshot: {
          provider: "GMAIL",
          state: "CONFIGURATION_REQUIRED",
          reason: "OAUTH_CLIENT_ID_REQUIRED",
        },
      });
    }
    if (this.activeConnect) {
      return gmailCredentialMutationResultSchema.parse({
        status: "rejected",
        reason: "OAUTH_CONNECT_IN_PROGRESS",
      });
    }
    const controller = new AbortController();
    const credentialEpoch = this.credentialEpoch;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    this.activeConnect = controller;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      const snapshot = await this.performConnect(
        controller.signal,
        credentialEpoch,
      );
      return gmailCredentialMutationResultSchema.parse({
        status: "snapshot",
        snapshot,
      });
    } catch (error) {
      const reason =
        error instanceof OAuthFlowError
          ? error.reason
          : "CREDENTIAL_STORE_UNAVAILABLE";
      return gmailCredentialMutationResultSchema.parse({
        status: "rejected",
        reason,
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      if (this.activeConnect === controller) this.activeConnect = undefined;
    }
  }

  async disconnect(): Promise<GmailCredentialMutationResult> {
    this.credentialEpoch += 1;
    this.activeConnect?.abort();
    this.refreshController?.abort();
    const revocationToken = await this.tokenStore
      .withRefreshToken(async (value) => new Uint8Array(value))
      .catch(() =>
        this.accessToken ? new Uint8Array(this.accessToken) : undefined,
      );
    this.clearAccessToken();
    try {
      if (revocationToken) {
        let token = "";
        try {
          token = new TextDecoder("utf-8", { fatal: true }).decode(
            revocationToken,
          );
          await bestEffortRequestWithTimeout(
            this.request,
            REVOKE_ENDPOINT,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token }),
            },
            Math.min(this.timeoutMs, 5_000),
          );
        } finally {
          revocationToken.fill(0);
          token = "";
        }
      }
      await this.tokenStore.revoke();
      return gmailCredentialMutationResultSchema.parse({
        status: "snapshot",
        snapshot: { provider: "GMAIL", state: "DISCONNECTED" },
      });
    } catch {
      return gmailCredentialMutationResultSchema.parse({
        status: "rejected",
        reason: "CREDENTIAL_STORE_UNAVAILABLE",
      });
    }
  }

  async close(): Promise<void> {
    this.credentialEpoch += 1;
    this.activeConnect?.abort();
    this.refreshController?.abort();
    this.clearAccessToken();
  }

  async withAccessToken<T>(
    use: (accessToken: Uint8Array) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.accessToken || Date.now() + 30_000 >= this.accessTokenExpiresAt) {
      const refresh = this.refreshInFlight ?? this.startRefresh();
      await raceAgainstSignal(refresh, options.signal);
    }
    if (!this.accessToken) throw new Error("SECRET_REVOKED");
    const copy = new Uint8Array(this.accessToken);
    try {
      return await use(copy);
    } finally {
      copy.fill(0);
    }
  }

  private startRefresh(): Promise<void> {
    const controller = new AbortController();
    const refresh = this.refreshAccessToken(this.credentialEpoch, controller);
    this.refreshController = controller;
    this.refreshInFlight = refresh;
    const clear = () => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
      if (this.refreshController === controller)
        this.refreshController = undefined;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async performConnect(
    signal: AbortSignal,
    credentialEpoch: number,
  ): Promise<GmailCredentialSnapshot> {
    if (signal.aborted) throw new OAuthFlowError("OAUTH_CANCELED");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    const loopback = await openLoopbackCallback({
      state,
      signal,
      timeoutMs: this.timeoutMs,
    });
    try {
      if (signal.aborted) throw new OAuthFlowError("OAUTH_CANCELED");
      const authorization = new URL(AUTHORIZE_ENDPOINT);
      authorization.search = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: loopback.redirectUri,
        response_type: "code",
        scope: GMAIL_METADATA_SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
      }).toString();
      try {
        await raceAgainstAbort(
          this.openExternal(authorization.toString()),
          signal,
        );
      } catch (error) {
        if (error instanceof OAuthFlowError) throw error;
        throw new OAuthFlowError("PROVIDER_UNAVAILABLE");
      }
      const code = await loopback.callback;
      const token = await this.exchangeAuthorizationCode({
        code,
        verifier,
        redirectUri: loopback.redirectUri,
        signal,
      });
      try {
        const accountEmail = await this.fetchAccountEmail(
          token.accessToken,
          signal,
        );
        if (signal.aborted) throw new OAuthFlowError("OAUTH_CANCELED");
        const refreshToken = new TextEncoder().encode(token.refreshToken);
        token.refreshToken = "";
        const configured = await this.tokenStore.configure({
          refreshToken,
          accountEmail,
        });
        if (signal.aborted || credentialEpoch !== this.credentialEpoch) {
          await this.tokenStore.revoke();
          throw new OAuthFlowError("OAUTH_CANCELED");
        }
        this.setAccessToken(token.accessToken, token.expiresInSeconds);
        token.accessToken = "";
        return gmailCredentialSnapshotSchema.parse({
          provider: "GMAIL",
          state: "CONNECTED",
          accountEmail,
          version: configured.version,
        });
      } finally {
        token.accessToken = "";
        token.refreshToken = "";
      }
    } finally {
      await loopback.close();
    }
  }

  private async exchangeAuthorizationCode(input: {
    code: string;
    verifier: string;
    redirectUri: string;
    signal: AbortSignal;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresInSeconds: number;
  }> {
    let response: Response;
    try {
      response = await raceRequestAgainstAbort(
        this.request(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.clientId,
            code: input.code,
            code_verifier: input.verifier,
            grant_type: "authorization_code",
            redirect_uri: input.redirectUri,
          }),
          signal: input.signal,
        }),
        input.signal,
      );
    } catch {
      if (input.signal.aborted) throw new OAuthFlowError("OAUTH_CANCELED");
      throw new OAuthFlowError("TOKEN_EXCHANGE_FAILED");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OAuthFlowError("TOKEN_EXCHANGE_FAILED");
    }
    try {
      const candidate = JSON.parse(
        await readGoogleResponse(response),
      ) as Record<string, unknown>;
      const scopes =
        typeof candidate.scope === "string" ? candidate.scope.split(" ") : [];
      if (
        typeof candidate.access_token !== "string" ||
        candidate.access_token.length < 8 ||
        typeof candidate.refresh_token !== "string" ||
        candidate.refresh_token.length < 8 ||
        typeof candidate.expires_in !== "number" ||
        !Number.isFinite(candidate.expires_in) ||
        candidate.expires_in <= 0 ||
        candidate.token_type !== "Bearer" ||
        (scopes.length > 0 && !scopes.includes(GMAIL_METADATA_SCOPE))
      ) {
        throw new Error("invalid token response");
      }
      return {
        accessToken: candidate.access_token,
        refreshToken: candidate.refresh_token,
        expiresInSeconds: candidate.expires_in,
      };
    } catch {
      throw new OAuthFlowError("TOKEN_EXCHANGE_FAILED");
    }
  }

  private async fetchAccountEmail(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await raceRequestAgainstAbort(
        this.request(PROFILE_ENDPOINT, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal,
        }),
        signal,
      );
    } catch {
      if (signal.aborted) throw new OAuthFlowError("OAUTH_CANCELED");
      throw new OAuthFlowError("PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OAuthFlowError("PROVIDER_UNAVAILABLE");
    }
    try {
      const candidate = JSON.parse(await readGoogleResponse(response)) as {
        emailAddress?: unknown;
      };
      if (
        typeof candidate.emailAddress !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.emailAddress) ||
        candidate.emailAddress.length > 320
      ) {
        throw new Error("invalid profile");
      }
      return candidate.emailAddress.trim().toLowerCase();
    } catch {
      throw new OAuthFlowError("PROVIDER_UNAVAILABLE");
    }
  }

  private async refreshAccessToken(
    credentialEpoch: number,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, 30_000),
    );
    const refreshTokenBytes = await this.tokenStore.withRefreshToken(
      async (value) => new Uint8Array(value),
    );
    let refreshToken = "";
    try {
      refreshToken = new TextDecoder("utf-8", { fatal: true }).decode(
        refreshTokenBytes,
      );
      const response = await raceRequestAgainstAbort(
        this.request(TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: this.clientId,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (!response.ok) {
        const invalidGrant =
          response.status === 400 &&
          (await readGoogleResponse(response).catch(() => "")).includes(
            "invalid_grant",
          );
        if (invalidGrant) throw new Error("GMAIL_INVALID_GRANT");
        await response.body?.cancel().catch(() => undefined);
        throw new Error("GMAIL_PROVIDER_UNAVAILABLE");
      }
      const candidate = JSON.parse(await readGoogleResponse(response)) as {
        access_token?: unknown;
        expires_in?: unknown;
        token_type?: unknown;
      };
      if (
        typeof candidate.access_token !== "string" ||
        candidate.access_token.length < 8 ||
        typeof candidate.expires_in !== "number" ||
        !Number.isFinite(candidate.expires_in) ||
        candidate.expires_in <= 0 ||
        candidate.token_type !== "Bearer"
      ) {
        throw new Error("GMAIL_PROVIDER_UNAVAILABLE");
      }
      if (
        controller.signal.aborted ||
        credentialEpoch !== this.credentialEpoch
      ) {
        throw new Error("GMAIL_PROVIDER_UNAVAILABLE");
      }
      this.setAccessToken(candidate.access_token, candidate.expires_in);
      candidate.access_token = "";
    } catch (error) {
      if (error instanceof Error && error.message === "GMAIL_INVALID_GRANT") {
        await this.tokenStore.revoke();
        throw new Error("SECRET_REVOKED");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      refreshTokenBytes.fill(0);
      refreshToken = "";
    }
  }

  private setAccessToken(value: string, expiresInSeconds: number): void {
    this.clearAccessToken();
    this.accessToken = new TextEncoder().encode(value);
    this.accessTokenExpiresAt = Date.now() + expiresInSeconds * 1_000;
  }

  private clearAccessToken(): void {
    this.accessToken?.fill(0);
    this.accessToken = undefined;
    this.accessTokenExpiresAt = 0;
  }
}

async function bestEffortRequestWithTimeout(
  request: typeof globalThis.fetch,
  url: string,
  init: {
    method: "POST";
    headers: { "Content-Type": "application/x-www-form-urlencoded" };
    body: URLSearchParams;
  },
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await Promise.race([
      request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("GMAIL_REQUEST_ABORTED")),
          { once: true },
        );
      }),
    ]);
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Remote revocation is best effort; local deletion is authoritative.
  } finally {
    clearTimeout(timeout);
  }
}

function raceAgainstSignal<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Error("RITUAL_RUN_CANCELED"));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("RITUAL_RUN_CANCELED"));
    signal.addEventListener("abort", cancel, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", cancel);
    });
  });
}

function raceRequestAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("GMAIL_PROVIDER_UNAVAILABLE"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("GMAIL_PROVIDER_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

async function openLoopbackCallback(input: {
  state: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{
  redirectUri: string;
  callback: Promise<string>;
  close(): Promise<void>;
}> {
  let resolveCallback!: (code: string) => void;
  let rejectCallback!: (error: Error) => void;
  let settled = false;
  let expectedHost = "";
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // The callback can arrive while the system-browser opener is still resolving.
  // Attach a handler immediately; callers still observe the original rejection.
  void callback.catch(() => undefined);
  const settle = (result: { code: string } | { error: OAuthFlowError }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", cancel);
    if ("code" in result) resolveCallback(result.code);
    else rejectCallback(result.error);
  };
  const server = createServer((request, response) => {
    if (settled) {
      response.writeHead(410).end("OAuth callback is no longer active.");
      return;
    }
    const host = request.headers.host ?? "";
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(request.url ?? "", `http://${host}`);
    } catch {
      response.writeHead(400).end("Invalid OAuth callback.");
      settle({ error: new OAuthFlowError("OAUTH_CALLBACK_INVALID") });
      return;
    }
    if (
      request.method !== "GET" ||
      host !== expectedHost ||
      callbackUrl.pathname !== CALLBACK_PATH
    ) {
      response.writeHead(404).end("OAuth callback was not found.");
      return;
    }
    if (
      callbackUrl.username ||
      callbackUrl.password ||
      callbackUrl.hash ||
      // OAuth providers may add response parameters. Only fields that affect
      // authorization are consumed and cardinality checked here.
      callbackUrl.searchParams.getAll("state").length !== 1 ||
      callbackUrl.searchParams.getAll("code").length > 1 ||
      callbackUrl.searchParams.getAll("error").length > 1
    ) {
      response.writeHead(400).end("Invalid OAuth callback.");
      settle({ error: new OAuthFlowError("OAUTH_CALLBACK_INVALID") });
      return;
    }
    if (callbackUrl.searchParams.get("state") !== input.state) {
      response.writeHead(400).end("OAuth state did not match.");
      settle({ error: new OAuthFlowError("OAUTH_STATE_MISMATCH") });
      return;
    }
    const authorizationError = callbackUrl.searchParams.get("error");
    if (authorizationError) {
      response.writeHead(400).end("OAuth authorization was not completed.");
      settle({
        error: new OAuthFlowError(
          authorizationError === "access_denied"
            ? "OAUTH_CANCELED"
            : "OAUTH_CALLBACK_INVALID",
        ),
      });
      return;
    }
    const code = callbackUrl.searchParams.get("code");
    if (!code || code.length > 4_096 || /[\r\n]/.test(code)) {
      response.writeHead(400).end("OAuth authorization was not completed.");
      settle({ error: new OAuthFlowError("OAUTH_CALLBACK_INVALID") });
      return;
    }
    response
      .writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      })
      .end("Gmail is connected. You can return to Village.");
    settle({ code });
  });
  const cancel = () => settle({ error: new OAuthFlowError("OAUTH_CANCELED") });
  const timeout = setTimeout(cancel, input.timeoutMs);
  input.signal.addEventListener("abort", cancel, { once: true });
  if (input.signal.aborted) cancel();
  try {
    await listenOnLoopback(server);
  } catch {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", cancel);
    throw new OAuthFlowError("PROVIDER_UNAVAILABLE");
  }
  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    redirectUri: `http://${expectedHost}${CALLBACK_PATH}`,
    callback,
    close: () => closeServer(server),
  };
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once("error", fail);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", fail);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function raceAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new OAuthFlowError("OAUTH_CANCELED"));
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new OAuthFlowError("OAUTH_CANCELED"));
    signal.addEventListener("abort", cancel, { once: true });
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", cancel);
    });
  });
}

function readGoogleResponse(response: Response): Promise<string> {
  return readBoundedResponseBody(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    errorCode: "GMAIL_RESPONSE_TOO_LARGE",
  });
}
