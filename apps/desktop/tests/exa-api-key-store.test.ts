import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretVault } from "../src/secrets/secret-vault.js";
import { ExaApiKeyStore } from "../src/research/exa-api-key-store.js";

const protector = {
  availability: async () => ({
    available: true,
    backend: "test-secure-store",
    secure: true,
  }),
  encrypt: async (value: string) => new TextEncoder().encode(`sealed:${value}`),
  decrypt: async (value: Uint8Array) => ({
    value: new TextDecoder().decode(value).slice("sealed:".length),
    shouldReEncrypt: false,
  }),
};

describe("Exa API key store", () => {
  it("configures, resolves, and revokes one local encrypted credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-exa-key-"));
    const store = new ExaApiKeyStore(
      new SecretVault(join(directory, "secrets.json"), protector),
    );
    const input = new TextEncoder().encode("exa-local-secret");

    await expect(store.configure(input)).resolves.toEqual({
      configured: true,
      version: 1,
    });
    expect(input.every((byte) => byte === 0)).toBe(true);
    await expect(store.status()).resolves.toEqual({
      configured: true,
      version: 1,
    });
    await expect(
      store.withApiKey(async (key) => new TextDecoder().decode(key)),
    ).resolves.toBe("exa-local-secret");

    await store.revoke();
    await expect(store.status()).resolves.toEqual({ configured: false });
    await expect(store.withApiKey(async () => undefined)).rejects.toThrow(
      "SECRET_REVOKED",
    );
  });

  it("rejects malformed credentials and clears the caller buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-exa-key-"));
    const store = new ExaApiKeyStore(
      new SecretVault(join(directory, "secrets.json"), protector),
    );
    const input = new TextEncoder().encode("bad\nkey");

    await expect(store.configure(input)).rejects.toThrow("EXA_API_KEY_INVALID");
    expect(input.every((byte) => byte === 0)).toBe(true);
    await expect(store.status()).resolves.toEqual({ configured: false });
  });
});
