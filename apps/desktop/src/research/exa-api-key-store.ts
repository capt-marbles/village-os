import type { SecretVault } from "../secrets/secret-vault.js";
import type { ExaCredentialSource } from "./exa-credential-source.js";

const EXA_API_KEY_SECRET_REF = "sec_exa_api_key";

export class ExaApiKeyValidationError extends Error {
  constructor() {
    super("EXA_API_KEY_INVALID");
    this.name = "ExaApiKeyValidationError";
  }
}

export class ExaApiKeyStore implements ExaCredentialSource {
  constructor(private readonly vault: SecretVault) {}

  async configure(
    candidate: Uint8Array,
  ): Promise<{ configured: true; version: number }> {
    let value = "";
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      if (!/^[\x21-\x7e]{8,512}$/.test(value)) {
        throw new ExaApiKeyValidationError();
      }
      const { version } = await this.vault.store(
        EXA_API_KEY_SECRET_REF,
        candidate,
      );
      return { configured: true, version };
    } catch (error) {
      if (error instanceof TypeError) throw new ExaApiKeyValidationError();
      throw error;
    } finally {
      candidate.fill(0);
      value = "";
    }
  }

  status(): Promise<
    { configured: false } | { configured: true; version: number }
  > {
    return this.vault.configured(EXA_API_KEY_SECRET_REF);
  }

  withApiKey<T>(use: (apiKey: Uint8Array) => Promise<T>): Promise<T> {
    return this.vault.withSecret(EXA_API_KEY_SECRET_REF, use);
  }

  revoke(): Promise<void> {
    return this.vault.revoke(EXA_API_KEY_SECRET_REF);
  }
}
