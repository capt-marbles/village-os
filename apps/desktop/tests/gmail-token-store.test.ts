import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GmailTokenStore } from "../src/gmail/gmail-token-store.js";
import { SecretVault } from "../src/secrets/secret-vault.js";

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

describe("Gmail token store", () => {
  it("stores only the refresh credential in the encrypted vault and clears inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-gmail-token-"));
    const store = new GmailTokenStore(
      new SecretVault(join(directory, "secrets.json"), protector),
    );
    const refreshToken = new TextEncoder().encode("refresh-secret-value");

    await expect(
      store.configure({ refreshToken, accountEmail: "owner@example.com" }),
    ).resolves.toEqual({ configured: true, version: 1 });
    expect(refreshToken.every((byte) => byte === 0)).toBe(true);
    await expect(store.status()).resolves.toEqual({
      configured: true,
      version: 1,
      accountEmail: "owner@example.com",
    });
    await expect(
      store.withRefreshToken(async (token) => new TextDecoder().decode(token)),
    ).resolves.toBe("refresh-secret-value");

    await store.revoke();
    await expect(store.status()).resolves.toEqual({ configured: false });
    await expect(store.withRefreshToken(async () => undefined)).rejects.toThrow(
      "SECRET_REVOKED",
    );
  });

  it("rejects malformed values and always clears the caller buffer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-gmail-token-"));
    const store = new GmailTokenStore(
      new SecretVault(join(directory, "secrets.json"), protector),
    );
    const refreshToken = new TextEncoder().encode("bad\nrefresh");

    await expect(
      store.configure({ refreshToken, accountEmail: "not-an-email" }),
    ).rejects.toThrow("GMAIL_REFRESH_CREDENTIAL_INVALID");
    expect(refreshToken.every((byte) => byte === 0)).toBe(true);
    await expect(store.status()).resolves.toEqual({ configured: false });
  });
});
