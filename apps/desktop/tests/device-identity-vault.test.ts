import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalCommandEnvelopeBytes } from "@village/contracts";
import {
  DeviceIdentityVault,
  type HardwareDeviceKeyProvider,
  type PlatformKeyProtector,
} from "../src/main/device-identity-vault.js";

class TestProtector implements PlatformKeyProtector {
  constructor(
    private readonly secure = true,
    private readonly rotate = false,
  ) {}

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
      shouldReEncrypt: this.rotate,
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
  const directory = await mkdtemp(join(tmpdir(), "village-identity-"));
  temporaryDirectories.push(directory);
  return join(directory, "device-identity.json");
}

describe("OS-protected device identity vault", () => {
  it("persists an encrypted key and reloads it as non-exportable", async () => {
    const path = await vaultPath();
    const vault = new DeviceIdentityVault(path, new TestProtector());
    const created = await vault.create();
    expect(created).not.toHaveProperty("privateKey");
    const loaded = await vault.load();
    expect(loaded.publicJwk).toEqual(created.publicJwk);
    expect(loaded).not.toHaveProperty("privateKey");

    const message = canonicalCommandEnvelopeBytes({
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      sequence: 1,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:30.000Z",
      command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
    });
    const signature = await loaded.signer.sign(message);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      loaded.publicJwk,
      "Ed25519",
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify("Ed25519", publicKey, signature, message),
    ).toBe(true);
  });

  it("prefers a hardware-backed signer and never exposes its private key", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const publicKey = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: exported.x!,
      y: exported.y!,
    };
    const hardware: HardwareDeviceKeyProvider = {
      availability: vi.fn().mockResolvedValue({
        available: true,
        backend: "secure_enclave",
      }),
      create: vi.fn().mockResolvedValue({
        wrappedKey: "device-bound-wrapped-reference",
        publicKey,
      }),
      publicKey: vi.fn().mockResolvedValue(publicKey),
      sign: vi.fn((_, payload) =>
        crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          payload,
        ),
      ),
    };
    const protector = new TestProtector(false);
    const protectorAvailability = vi.spyOn(protector, "availability");
    const path = await vaultPath();
    const vault = new DeviceIdentityVault(path, protector, hardware);

    const created = await vault.create();
    const loaded = await vault.load();
    expect(created).not.toHaveProperty("privateKey");
    expect(loaded).not.toHaveProperty("privateKey");
    expect(loaded).toMatchObject({
      publicJwk: publicKey,
      protection: "HARDWARE_NON_EXPORTABLE",
      protectionBackend: "secure_enclave",
    });
    const payload = canonicalCommandEnvelopeBytes({
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      sequence: 1,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:30.000Z",
      command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
    });
    const signature = await loaded.signer.sign(payload);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        signature,
        payload,
      ),
    ).toBe(true);
    expect(await readFile(path, "utf8")).not.toContain("privateKey");
    expect(protectorAvailability).not.toHaveBeenCalled();
  });

  it("fails closed for insecure backends and broad file permissions", async () => {
    await expect(
      new DeviceIdentityVault(
        await vaultPath(),
        new TestProtector(false),
      ).create(),
    ).rejects.toThrow("SECURE_DEVICE_KEY_STORAGE_UNAVAILABLE");

    if (process.platform !== "win32") {
      const path = await vaultPath();
      const vault = new DeviceIdentityVault(path, new TestProtector());
      await vault.create();
      await chmod(path, 0o644);
      await expect(vault.load()).rejects.toThrow(
        "DEVICE_IDENTITY_PERMISSIONS_TOO_BROAD",
      );
    }
  });

  it("does not overwrite an identity and reports corrupt storage", async () => {
    const path = await vaultPath();
    const vault = new DeviceIdentityVault(path, new TestProtector());
    await vault.create();
    await expect(vault.create()).rejects.toThrow(
      "DEVICE_IDENTITY_ALREADY_EXISTS",
    );
    await writeFile(path, "not-json", { mode: 0o600 });
    await expect(vault.load()).rejects.toThrow("DEVICE_IDENTITY_CORRUPT");
  });
});
