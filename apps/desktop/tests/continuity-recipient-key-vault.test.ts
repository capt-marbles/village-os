import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformKeyProtector } from "../src/main/device-identity-vault.js";
import { ContinuityRecipientKeyVault } from "../src/main/continuity-recipient-key-vault.js";

class TestProtector implements PlatformKeyProtector {
  constructor(private readonly secure = true) {}

  async availability() {
    return {
      available: true,
      backend: this.secure ? "test-keychain" : "basic_text",
      secure: this.secure,
    };
  }

  async encrypt(value: string) {
    return new TextEncoder().encode(`protected:${value}`);
  }

  async decrypt(value: Uint8Array) {
    const encoded = new TextDecoder().decode(value);
    if (!encoded.startsWith("protected:")) throw new Error("invalid");
    return {
      value: encoded.slice("protected:".length),
      shouldReEncrypt: false,
    };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function vaultPath() {
  const directory = await mkdtemp(join(tmpdir(), "village-recipient-key-"));
  temporaryDirectories.push(directory);
  return join(directory, "recipient-key.json");
}

describe("OS-protected continuity recipient-key vault", () => {
  it("persists encrypted X25519 material and reloads a non-exportable key", async () => {
    const path = await vaultPath();
    const vault = new ContinuityRecipientKeyVault(path, new TestProtector());
    const created = await vault.create();
    const stored = await readFile(path, "utf8");

    expect(created.privateKey.extractable).toBe(false);
    expect(created.publicJwk).toMatchObject({ kty: "OKP", crv: "X25519" });
    expect(stored).not.toContain("privateKey");

    const loaded = await vault.load();
    expect(loaded.publicJwk).toEqual(created.publicJwk);
    expect(loaded.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("pkcs8", loaded.privateKey),
    ).rejects.toThrow();
  });

  it("fails closed for insecure protection and unsafe file permissions", async () => {
    await expect(
      new ContinuityRecipientKeyVault(
        await vaultPath(),
        new TestProtector(false),
      ).create(),
    ).rejects.toThrow("SECURE_RECIPIENT_KEY_STORAGE_UNAVAILABLE");

    if (process.platform !== "win32") {
      const path = await vaultPath();
      const vault = new ContinuityRecipientKeyVault(path, new TestProtector());
      await vault.create();
      await chmod(path, 0o644);
      await expect(vault.load()).rejects.toThrow(
        "RECIPIENT_KEY_PERMISSIONS_TOO_BROAD",
      );
    }
  });

  it("does not overwrite or accept corrupt recipient-key state", async () => {
    const path = await vaultPath();
    const vault = new ContinuityRecipientKeyVault(path, new TestProtector());
    await vault.create();
    await expect(vault.create()).rejects.toThrow(
      "RECIPIENT_KEY_ALREADY_EXISTS",
    );
    await writeFile(path, "not-json", { mode: 0o600 });
    await expect(vault.load()).rejects.toThrow("RECIPIENT_KEY_CORRUPT");
  });

  it("rejects a public key that no longer matches the protected private key", async () => {
    const path = await vaultPath();
    const vault = new ContinuityRecipientKeyVault(path, new TestProtector());
    await vault.create();
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      publicKey: JsonWebKey;
    };
    const replacement = (await crypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const replacementPublic = await crypto.subtle.exportKey(
      "jwk",
      replacement.publicKey,
    );
    stored.publicKey = {
      kty: "OKP",
      crv: "X25519",
      x: replacementPublic.x,
    };
    await writeFile(path, JSON.stringify(stored), { mode: 0o600 });

    await expect(vault.load()).rejects.toThrow("RECIPIENT_KEY_CORRUPT");
  });
});
