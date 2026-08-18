import type { SecretVault } from "../secrets/secret-vault.js";

const GMAIL_REFRESH_TOKEN_SECRET_REF = "sec_gmail_refresh_token";

type StoredRefreshCredential = {
  schemaVersion: 1;
  refreshToken: string;
  accountEmail: string;
};

export interface GmailRefreshTokenSource {
  status(): Promise<
    | { configured: false }
    | { configured: true; version: number; accountEmail: string }
  >;
  withRefreshToken<T>(
    use: (refreshToken: Uint8Array) => Promise<T>,
  ): Promise<T>;
}

export class GmailTokenStore implements GmailRefreshTokenSource {
  constructor(private readonly vault: SecretVault) {}

  async configure(candidate: {
    refreshToken: Uint8Array;
    accountEmail: string;
  }): Promise<{ configured: true; version: number }> {
    let refreshToken = "";
    try {
      refreshToken = new TextDecoder("utf-8", { fatal: true }).decode(
        candidate.refreshToken,
      );
      const accountEmail = candidate.accountEmail.trim().toLowerCase();
      if (
        !/^[\x21-\x7e]{8,4096}$/.test(refreshToken) ||
        !isEmailAddress(accountEmail)
      ) {
        throw new Error("GMAIL_REFRESH_CREDENTIAL_INVALID");
      }
      const payload: StoredRefreshCredential = {
        schemaVersion: 1,
        refreshToken,
        accountEmail,
      };
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      const { version } = await this.vault.store(
        GMAIL_REFRESH_TOKEN_SECRET_REF,
        plaintext,
      );
      return { configured: true, version };
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("GMAIL_REFRESH_CREDENTIAL_INVALID");
      }
      throw error;
    } finally {
      candidate.refreshToken.fill(0);
      refreshToken = "";
    }
  }

  async status(): Promise<
    | { configured: false }
    | { configured: true; version: number; accountEmail: string }
  > {
    const configured = await this.vault.configured(
      GMAIL_REFRESH_TOKEN_SECRET_REF,
    );
    if (!configured.configured) return configured;
    const accountEmail = await this.vault.withSecret(
      GMAIL_REFRESH_TOKEN_SECRET_REF,
      async (plaintext) => {
        const credential = parseCredential(plaintext);
        const accountEmail = credential.accountEmail;
        credential.refreshToken = "";
        return accountEmail;
      },
    );
    return { ...configured, accountEmail };
  }

  withRefreshToken<T>(
    use: (refreshToken: Uint8Array) => Promise<T>,
  ): Promise<T> {
    return this.vault.withSecret(
      GMAIL_REFRESH_TOKEN_SECRET_REF,
      async (plaintext) => {
        const credential = parseCredential(plaintext);
        const refreshToken = new TextEncoder().encode(credential.refreshToken);
        credential.refreshToken = "";
        try {
          return await use(refreshToken);
        } finally {
          refreshToken.fill(0);
        }
      },
    );
  }

  revoke(): Promise<void> {
    return this.vault.revoke(GMAIL_REFRESH_TOKEN_SECRET_REF);
  }
}

function parseCredential(plaintext: Uint8Array): StoredRefreshCredential {
  let raw = "";
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const candidate: unknown = JSON.parse(raw);
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Object.keys(candidate).length !== 3 ||
      (candidate as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      typeof (candidate as { refreshToken?: unknown }).refreshToken !==
        "string" ||
      !/^[\x21-\x7e]{8,4096}$/.test(
        (candidate as { refreshToken: string }).refreshToken,
      ) ||
      typeof (candidate as { accountEmail?: unknown }).accountEmail !==
        "string" ||
      !isEmailAddress((candidate as { accountEmail: string }).accountEmail)
    ) {
      throw new Error("GMAIL_REFRESH_CREDENTIAL_CORRUPT");
    }
    return candidate as StoredRefreshCredential;
  } catch {
    throw new Error("GMAIL_REFRESH_CREDENTIAL_CORRUPT");
  } finally {
    raw = "";
  }
}

function isEmailAddress(value: string): boolean {
  return (
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    !/[\r\n]/.test(value)
  );
}
