import type { ModelProviderAccountSnapshot } from "@village/contracts";

export interface ManagedModelProviderAccount {
  start(): Promise<void>;
  accountStatus(): Promise<
    | { status: "authenticated"; accountType: "chatgpt" }
    | { status: "authentication_required" }
  >;
  startManagedChatGptLogin(): Promise<{
    loginId: string;
    authUrl: string;
  }>;
  cancelManagedChatGptLogin(loginId: string): Promise<void>;
  close(): Promise<void>;
}

export type OpenManagedLogin = (url: string) => Promise<void>;

export interface ModelProviderAccountOperations {
  refresh(): Promise<ModelProviderAccountSnapshot>;
  beginLogin(): Promise<ModelProviderAccountSnapshot>;
  cancelLogin(): Promise<ModelProviderAccountSnapshot>;
  close(): Promise<void>;
}

function trustedManagedLoginUrl(candidate: string): string | undefined {
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "auth.openai.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Owns Codex account state in Electron's main process; no tokens reach IPC. */
export class ModelProviderAccountController implements ModelProviderAccountOperations {
  private started = false;
  private closed = false;
  private activeLoginId: string | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly provider: ManagedModelProviderAccount,
    private readonly openManagedLogin: OpenManagedLogin,
  ) {}

  refresh(): Promise<ModelProviderAccountSnapshot> {
    return this.enqueue(async () => {
      try {
        await this.ensureStarted();
        const account = await this.provider.accountStatus();
        if (account.status === "authenticated") {
          this.activeLoginId = undefined;
          return this.update({
            provider: "CHATGPT",
            state: "AUTHENTICATED",
            accountType: account.accountType,
          });
        }
        return this.update(
          this.activeLoginId
            ? { provider: "CHATGPT", state: "AUTHENTICATING" }
            : { provider: "CHATGPT", state: "AUTHENTICATION_REQUIRED" },
        );
      } catch {
        return this.recoverUnavailable("PROVIDER_UNAVAILABLE");
      }
    });
  }

  beginLogin(): Promise<ModelProviderAccountSnapshot> {
    return this.enqueue(async () => {
      try {
        await this.ensureStarted();
        const account = await this.provider.accountStatus();
        if (account.status === "authenticated") {
          return this.update({
            provider: "CHATGPT",
            state: "AUTHENTICATED",
            accountType: account.accountType,
          });
        }
        if (this.activeLoginId) {
          return { provider: "CHATGPT", state: "AUTHENTICATING" };
        }

        const login = await this.provider.startManagedChatGptLogin();
        const authUrl = trustedManagedLoginUrl(login.authUrl);
        if (!authUrl) {
          await this.provider
            .cancelManagedChatGptLogin(login.loginId)
            .catch(() => undefined);
          return this.unavailable("UNTRUSTED_AUTH_URL");
        }
        this.activeLoginId = login.loginId;
        try {
          await this.openManagedLogin(authUrl);
        } catch {
          this.activeLoginId = undefined;
          await this.provider
            .cancelManagedChatGptLogin(login.loginId)
            .catch(() => undefined);
          return this.unavailable("AUTH_BROWSER_UNAVAILABLE");
        }
        return this.update({ provider: "CHATGPT", state: "AUTHENTICATING" });
      } catch {
        return this.recoverUnavailable("PROVIDER_UNAVAILABLE");
      }
    });
  }

  cancelLogin(): Promise<ModelProviderAccountSnapshot> {
    return this.enqueue(async () => {
      try {
        await this.ensureStarted();
        const account = await this.provider.accountStatus();
        if (account.status === "authenticated") {
          this.activeLoginId = undefined;
          return this.update({
            provider: "CHATGPT",
            state: "AUTHENTICATED",
            accountType: account.accountType,
          });
        }
        const loginId = this.activeLoginId;
        if (loginId) {
          await this.provider.cancelManagedChatGptLogin(loginId);
          this.activeLoginId = undefined;
        }
      } catch {
        return this.recoverUnavailable("PROVIDER_UNAVAILABLE");
      }
      return this.update({
        provider: "CHATGPT",
        state: "AUTHENTICATION_REQUIRED",
      });
    });
  }

  async close(): Promise<void> {
    await this.operationTail;
    if (this.closed) return;
    this.closed = true;
    this.activeLoginId = undefined;
    await this.provider.close();
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("MODEL_PROVIDER_ACCOUNT_CLOSED");
    if (this.started) return;
    await this.provider.start();
    this.started = true;
  }

  private update(
    snapshot: ModelProviderAccountSnapshot,
  ): ModelProviderAccountSnapshot {
    return { ...snapshot };
  }

  private unavailable(
    errorCode: Extract<
      ModelProviderAccountSnapshot,
      { state: "UNAVAILABLE" }
    >["errorCode"],
  ): ModelProviderAccountSnapshot {
    this.activeLoginId = undefined;
    return this.update({
      provider: "CHATGPT",
      state: "UNAVAILABLE",
      errorCode,
    });
  }

  /** Reset a failed provider so the next operation can create a fresh transport. */
  private async recoverUnavailable(
    errorCode: Extract<
      ModelProviderAccountSnapshot,
      { state: "UNAVAILABLE" }
    >["errorCode"],
  ): Promise<ModelProviderAccountSnapshot> {
    const loginId = this.activeLoginId;
    this.activeLoginId = undefined;
    if (this.started && loginId) {
      await this.provider
        .cancelManagedChatGptLogin(loginId)
        .catch(() => undefined);
    }
    this.started = false;
    await this.provider.close().catch(() => undefined);
    return this.unavailable(errorCode);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
