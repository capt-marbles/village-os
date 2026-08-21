import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  p256DevicePublicKeySchema,
  type DeviceSigningPublicKey,
} from "@village/contracts";
import { exportPublicDeviceJwk, type DeviceSigner } from "./device-identity.js";

export interface PlatformKeyProtector {
  availability(): Promise<{
    available: boolean;
    backend: string;
    secure: boolean;
  }>;
  encrypt(value: string): Promise<Uint8Array>;
  decrypt(value: Uint8Array): Promise<{
    value: string;
    shouldReEncrypt: boolean;
  }>;
}

type StoredDeviceIdentity = {
  version: 1;
  algorithm: "Ed25519";
  encryptedPrivateKey: string;
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  protectionBackend: string;
  createdAt: string;
};

type StoredHardwareDeviceIdentity = {
  version: 2;
  algorithm: "ES256";
  wrappedKey: string;
  publicKey: Extract<DeviceSigningPublicKey, { kty: "EC" }>;
  protectionBackend: string;
  createdAt: string;
};

export interface HardwareDeviceKeyProvider {
  availability(): Promise<{ available: boolean; backend: string }>;
  create(): Promise<{
    wrappedKey: string;
    publicKey: StoredHardwareDeviceIdentity["publicKey"];
  }>;
  publicKey(
    wrappedKey: string,
  ): Promise<StoredHardwareDeviceIdentity["publicKey"]>;
  sign(wrappedKey: string, payload: ArrayBuffer): Promise<ArrayBuffer>;
}

export type DeviceIdentity =
  | {
      signer: DeviceSigner;
      publicJwk: Extract<DeviceSigningPublicKey, { kty: "EC" }>;
      protection: "HARDWARE_NON_EXPORTABLE";
      protectionBackend: string;
    }
  | {
      signer: DeviceSigner;
      publicJwk: Extract<DeviceSigningPublicKey, { kty: "OKP" }>;
      protection: "OS_PROTECTED_FALLBACK";
      protectionBackend: string;
    };

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function parseStoredIdentity(
  value: string,
): StoredDeviceIdentity | StoredHardwareDeviceIdentity {
  const candidate = JSON.parse(value) as
    Partial<StoredDeviceIdentity> | Partial<StoredHardwareDeviceIdentity>;
  if (candidate.version === 2) {
    const hardware = candidate as Partial<StoredHardwareDeviceIdentity>;
    const publicKey = p256DevicePublicKeySchema.safeParse(hardware.publicKey);
    if (
      hardware.algorithm !== "ES256" ||
      typeof hardware.wrappedKey !== "string" ||
      hardware.wrappedKey.length < 8 ||
      hardware.wrappedKey.length > 16_384 ||
      !publicKey.success ||
      typeof hardware.protectionBackend !== "string" ||
      hardware.protectionBackend.length === 0 ||
      typeof hardware.createdAt !== "string" ||
      Number.isNaN(Date.parse(hardware.createdAt))
    ) {
      throw new Error("DEVICE_IDENTITY_CORRUPT");
    }
    return {
      ...hardware,
      publicKey: publicKey.data,
    } as StoredHardwareDeviceIdentity;
  }
  if (
    candidate.version !== 1 ||
    candidate.algorithm !== "Ed25519" ||
    typeof candidate.encryptedPrivateKey !== "string" ||
    candidate.encryptedPrivateKey.length > 16_384 ||
    candidate.publicKey?.kty !== "OKP" ||
    candidate.publicKey.crv !== "Ed25519" ||
    typeof candidate.publicKey.x !== "string" ||
    typeof candidate.protectionBackend !== "string" ||
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt))
  ) {
    throw new Error("DEVICE_IDENTITY_CORRUPT");
  }
  return candidate as StoredDeviceIdentity;
}

export class DeviceIdentityVault {
  constructor(
    private readonly path: string,
    private readonly protector: PlatformKeyProtector,
    private readonly hardware?: HardwareDeviceKeyProvider,
  ) {}

  async create(): Promise<DeviceIdentity> {
    try {
      await lstat(this.path);
      throw new Error("DEVICE_IDENTITY_ALREADY_EXISTS");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }

    if (this.hardware) {
      const availability = await this.hardware.availability();
      if (availability.available) {
        const created = await this.hardware.create();
        const publicKey = p256DevicePublicKeySchema.parse(created.publicKey);
        const stored: StoredHardwareDeviceIdentity = {
          version: 2,
          algorithm: "ES256",
          wrappedKey: created.wrappedKey,
          publicKey,
          protectionBackend: availability.backend,
          createdAt: new Date().toISOString(),
        };
        await this.write(stored, true);
        return this.hardwareIdentity(stored);
      }
    }

    const protection = await this.requireProtection();
    const generated = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const exported = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", generated.privateKey),
    );
    try {
      const protectedBytes = await this.protector.encrypt(encode(exported));
      const publicJwk = await exportPublicDeviceJwk(generated.publicKey);
      const stored: StoredDeviceIdentity = {
        version: 1,
        algorithm: "Ed25519",
        encryptedPrivateKey: encode(protectedBytes),
        publicKey: publicJwk as StoredDeviceIdentity["publicKey"],
        protectionBackend: protection.backend,
        createdAt: new Date().toISOString(),
      };
      await this.write(stored, true);
      return await this.importIdentity(stored, exported);
    } finally {
      exported.fill(0);
    }
  }

  async load(): Promise<DeviceIdentity> {
    const metadata = await lstat(this.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("DEVICE_IDENTITY_UNSAFE_PATH");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("DEVICE_IDENTITY_PERMISSIONS_TOO_BROAD");
    }
    const raw = await readFile(this.path, "utf8");
    if (raw.length > 32_768) throw new Error("DEVICE_IDENTITY_CORRUPT");
    let stored: StoredDeviceIdentity | StoredHardwareDeviceIdentity;
    try {
      stored = parseStoredIdentity(raw);
    } catch {
      throw new Error("DEVICE_IDENTITY_CORRUPT");
    }
    if (stored.version === 2) {
      if (!this.hardware) throw new Error("SECURE_ENCLAVE_HELPER_UNAVAILABLE");
      const availability = await this.hardware.availability();
      if (!availability.available) {
        throw new Error("SECURE_ENCLAVE_UNAVAILABLE");
      }
      const publicKey = await this.hardware.publicKey(stored.wrappedKey);
      if (
        JSON.stringify(p256DevicePublicKeySchema.parse(publicKey)) !==
        JSON.stringify(stored.publicKey)
      ) {
        throw new Error("DEVICE_IDENTITY_CORRUPT");
      }
      return this.hardwareIdentity(stored);
    }
    await this.requireProtection();
    const decrypted = await this.protector.decrypt(
      decode(stored.encryptedPrivateKey),
    );
    const privateBytes = decode(decrypted.value);
    try {
      if (decrypted.shouldReEncrypt) {
        const protection = await this.requireProtection();
        stored.encryptedPrivateKey = encode(
          await this.protector.encrypt(decrypted.value),
        );
        stored.protectionBackend = protection.backend;
        await this.write(stored, false);
      }
      return await this.importIdentity(stored, privateBytes);
    } catch {
      throw new Error("DEVICE_IDENTITY_CORRUPT");
    } finally {
      privateBytes.fill(0);
    }
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }

  private async requireProtection() {
    const state = await this.protector.availability();
    if (!state.available || !state.secure || state.backend === "basic_text") {
      throw new Error("SECURE_DEVICE_KEY_STORAGE_UNAVAILABLE");
    }
    return state;
  }

  private async importIdentity(
    stored: StoredDeviceIdentity,
    privateBytes: Uint8Array,
  ): Promise<DeviceIdentity> {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(privateBytes),
      "Ed25519",
      false,
      ["sign"],
    );
    return {
      signer: {
        sign: (payload) => crypto.subtle.sign("Ed25519", privateKey, payload),
      },
      publicJwk: stored.publicKey,
      protection: "OS_PROTECTED_FALLBACK",
      protectionBackend: stored.protectionBackend,
    };
  }

  private hardwareIdentity(
    stored: StoredHardwareDeviceIdentity,
  ): DeviceIdentity {
    if (!this.hardware) throw new Error("SECURE_ENCLAVE_HELPER_UNAVAILABLE");
    return {
      signer: {
        sign: (payload) => this.hardware!.sign(stored.wrappedKey, payload),
      },
      publicJwk: stored.publicKey,
      protection: "HARDWARE_NON_EXPORTABLE",
      protectionBackend: stored.protectionBackend,
    };
  }

  private async write(
    stored: StoredDeviceIdentity | StoredHardwareDeviceIdentity,
    createOnly: boolean,
  ): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("DEVICE_IDENTITY_UNSAFE_PATH");
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(stored), {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      if (createOnly) {
        await link(temporary, this.path);
        await unlink(temporary);
      } else {
        await rename(temporary, this.path);
      }
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error("DEVICE_IDENTITY_ALREADY_EXISTS");
      }
      throw error;
    }
  }
}
