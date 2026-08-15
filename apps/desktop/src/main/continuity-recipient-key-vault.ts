import { x25519PublicKeySchema } from "@village/contracts";
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
import type { PlatformKeyProtector } from "./device-identity-vault.js";

type StoredRecipientKey = {
  version: 1;
  algorithm: "X25519";
  encryptedPrivateKey: string;
  publicKey: { kty: "OKP"; crv: "X25519"; x: string };
  protectionBackend: string;
  createdAt: string;
};

export type ContinuityRecipientKey = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: StoredRecipientKey["publicKey"];
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

function parseStoredRecipientKey(value: string): StoredRecipientKey {
  const candidate = JSON.parse(value) as Partial<StoredRecipientKey>;
  const publicKey = x25519PublicKeySchema.safeParse(candidate.publicKey);
  if (
    candidate.version !== 1 ||
    candidate.algorithm !== "X25519" ||
    typeof candidate.encryptedPrivateKey !== "string" ||
    candidate.encryptedPrivateKey.length > 16_384 ||
    !publicKey.success ||
    typeof candidate.protectionBackend !== "string" ||
    typeof candidate.createdAt !== "string" ||
    Number.isNaN(Date.parse(candidate.createdAt))
  ) {
    throw new Error("RECIPIENT_KEY_CORRUPT");
  }
  return { ...candidate, publicKey: publicKey.data } as StoredRecipientKey;
}

export class ContinuityRecipientKeyVault {
  constructor(
    private readonly path: string,
    private readonly protector: PlatformKeyProtector,
  ) {}

  async create(): Promise<ContinuityRecipientKey> {
    const protection = await this.requireProtection();
    try {
      await lstat(this.path);
      throw new Error("RECIPIENT_KEY_ALREADY_EXISTS");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }

    const generated = (await crypto.subtle.generateKey("X25519", true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const privateBytes = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", generated.privateKey),
    );
    try {
      const exportedPublicKey = await crypto.subtle.exportKey(
        "jwk",
        generated.publicKey,
      );
      const publicJwk = x25519PublicKeySchema.parse({
        kty: exportedPublicKey.kty,
        crv: exportedPublicKey.crv,
        x: exportedPublicKey.x,
      });
      const protectedBytes = await this.protector.encrypt(encode(privateBytes));
      const stored: StoredRecipientKey = {
        version: 1,
        algorithm: "X25519",
        encryptedPrivateKey: encode(protectedBytes),
        publicKey: publicJwk,
        protectionBackend: protection.backend,
        createdAt: new Date().toISOString(),
      };
      await this.write(stored, true);
      return await this.importKey(stored, privateBytes);
    } finally {
      privateBytes.fill(0);
    }
  }

  async load(): Promise<ContinuityRecipientKey> {
    await this.requireProtection();
    const metadata = await lstat(this.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("RECIPIENT_KEY_UNSAFE_PATH");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("RECIPIENT_KEY_PERMISSIONS_TOO_BROAD");
    }
    if (metadata.size > 32_768) throw new Error("RECIPIENT_KEY_CORRUPT");
    const raw = await readFile(this.path, "utf8");
    if (raw.length > 32_768) throw new Error("RECIPIENT_KEY_CORRUPT");
    let stored: StoredRecipientKey;
    try {
      stored = parseStoredRecipientKey(raw);
    } catch {
      throw new Error("RECIPIENT_KEY_CORRUPT");
    }
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
      return await this.importKey(stored, privateBytes);
    } catch {
      throw new Error("RECIPIENT_KEY_CORRUPT");
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
      throw new Error("SECURE_RECIPIENT_KEY_STORAGE_UNAVAILABLE");
    }
    return state;
  }

  private async importKey(
    stored: StoredRecipientKey,
    privateBytes: Uint8Array,
  ): Promise<ContinuityRecipientKey> {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(privateBytes),
      "X25519",
      false,
      ["deriveBits"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      stored.publicKey,
      "X25519",
      true,
      [],
    );
    const result = {
      privateKey,
      publicKey,
      publicJwk: stored.publicKey,
      protectionBackend: stored.protectionBackend,
    };
    if (!(await recipientKeyPairMatches(result))) {
      throw new Error("RECIPIENT_KEY_CORRUPT");
    }
    return result;
  }

  private async write(
    stored: StoredRecipientKey,
    createOnly: boolean,
  ): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("RECIPIENT_KEY_UNSAFE_PATH");
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
        throw new Error("RECIPIENT_KEY_ALREADY_EXISTS");
      }
      throw error;
    }
  }
}

async function recipientKeyPairMatches(
  key: Pick<ContinuityRecipientKey, "privateKey" | "publicKey">,
): Promise<boolean> {
  const probe = (await crypto.subtle.generateKey("X25519", false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const [fromStoredPublic, fromStoredPrivate] = await Promise.all([
    crypto.subtle.deriveBits(
      { name: "X25519", public: key.publicKey },
      probe.privateKey,
      256,
    ),
    crypto.subtle.deriveBits(
      { name: "X25519", public: probe.publicKey },
      key.privateKey,
      256,
    ),
  ]);
  return Buffer.from(fromStoredPublic).equals(Buffer.from(fromStoredPrivate));
}
