import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface SecretEncryptionProvider {
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

type StoredSecret = {
  version: number;
  encryptedBlob: string;
  protectionBackend: string;
  updatedAt: string;
};

type StoredVault = {
  schemaVersion: 1;
  secrets: Record<string, StoredSecret>;
};

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function assertSecretRef(secretRef: string): void {
  if (!/^sec_[A-Za-z0-9_-]{1,120}$/.test(secretRef)) {
    throw new Error("INVALID_SECRET_REFERENCE");
  }
}

function parseVault(raw: string): StoredVault {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error("SECRET_VAULT_CORRUPT");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    (candidate as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (candidate as { secrets?: unknown }).secrets !== "object" ||
    (candidate as { secrets?: unknown }).secrets === null ||
    Array.isArray((candidate as { secrets?: unknown }).secrets)
  ) {
    throw new Error("SECRET_VAULT_CORRUPT");
  }
  const secrets = (candidate as StoredVault).secrets;
  for (const [secretRef, secret] of Object.entries(secrets)) {
    try {
      assertSecretRef(secretRef);
    } catch {
      throw new Error("SECRET_VAULT_CORRUPT");
    }
    if (
      typeof secret !== "object" ||
      secret === null ||
      !Number.isSafeInteger(secret.version) ||
      secret.version < 1 ||
      typeof secret.encryptedBlob !== "string" ||
      secret.encryptedBlob.length > 131_072 ||
      !/^[A-Za-z0-9_-]+$/.test(secret.encryptedBlob) ||
      typeof secret.protectionBackend !== "string" ||
      secret.protectionBackend.length > 128 ||
      typeof secret.updatedAt !== "string" ||
      Number.isNaN(Date.parse(secret.updatedAt))
    ) {
      throw new Error("SECRET_VAULT_CORRUPT");
    }
  }
  return { schemaVersion: 1, secrets };
}

export class SecretVault {
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly provider: SecretEncryptionProvider,
  ) {}

  async store(
    secretRef: string,
    plaintext: Uint8Array,
  ): Promise<{ version: number }> {
    return this.runExclusive(() => this.storeExclusive(secretRef, plaintext));
  }

  private async storeExclusive(
    secretRef: string,
    plaintext: Uint8Array,
  ): Promise<{ version: number }> {
    const transient = new Uint8Array(plaintext);
    let text = "";
    try {
      assertSecretRef(secretRef);
      if (plaintext.byteLength < 1 || plaintext.byteLength > 65_536) {
        throw new Error("INVALID_SECRET_VALUE");
      }
      const protection = await this.requireProtection();
      const vault = await this.readOrEmpty();
      text = new TextDecoder("utf-8", { fatal: true }).decode(transient);
      const encrypted = await this.provider.encrypt(text);
      const version = (vault.secrets[secretRef]?.version ?? 0) + 1;
      vault.secrets[secretRef] = {
        version,
        encryptedBlob: encode(encrypted),
        protectionBackend: protection.backend,
        updatedAt: new Date().toISOString(),
      };
      encrypted.fill(0);
      await this.write(vault);
      return { version };
    } catch (error) {
      if (error instanceof TypeError) throw new Error("INVALID_SECRET_VALUE");
      throw error;
    } finally {
      transient.fill(0);
      plaintext.fill(0);
      text = "";
    }
  }

  async configured(
    secretRef: string,
  ): Promise<{ configured: false } | { configured: true; version: number }> {
    await this.mutation;
    assertSecretRef(secretRef);
    await this.requireProtection();
    const vault = await this.readOrEmpty();
    const secret = vault.secrets[secretRef];
    return secret
      ? { configured: true, version: secret.version }
      : { configured: false };
  }

  async withSecret<T>(
    secretRef: string,
    use: (plaintext: Uint8Array) => Promise<T>,
  ): Promise<T> {
    return this.runExclusive(() => this.withSecretExclusive(secretRef, use));
  }

  private async withSecretExclusive<T>(
    secretRef: string,
    use: (plaintext: Uint8Array) => Promise<T>,
  ): Promise<T> {
    assertSecretRef(secretRef);
    await this.requireProtection();
    const vault = await this.readOrEmpty();
    const secret = vault.secrets[secretRef];
    if (!secret) throw new Error("SECRET_REVOKED");
    let decrypted: Awaited<ReturnType<SecretEncryptionProvider["decrypt"]>>;
    const encrypted = decode(secret.encryptedBlob);
    try {
      decrypted = await this.provider.decrypt(encrypted);
    } catch {
      throw new Error("SECRET_VAULT_CORRUPT");
    } finally {
      encrypted.fill(0);
    }
    if (
      typeof decrypted.value !== "string" ||
      typeof decrypted.shouldReEncrypt !== "boolean"
    ) {
      throw new Error("SECRET_VAULT_CORRUPT");
    }
    const plaintext = new TextEncoder().encode(decrypted.value);
    try {
      if (decrypted.shouldReEncrypt) {
        const protection = await this.requireProtection();
        const encrypted = await this.provider.encrypt(decrypted.value);
        secret.encryptedBlob = encode(encrypted);
        secret.protectionBackend = protection.backend;
        secret.updatedAt = new Date().toISOString();
        encrypted.fill(0);
        await this.write(vault);
      }
      return await use(plaintext);
    } finally {
      plaintext.fill(0);
      decrypted.value = "";
    }
  }

  async revoke(secretRef: string): Promise<void> {
    return this.runExclusive(() => this.revokeExclusive(secretRef));
  }

  private async revokeExclusive(secretRef: string): Promise<void> {
    assertSecretRef(secretRef);
    await this.requireProtection();
    const vault = await this.readOrEmpty();
    if (!(secretRef in vault.secrets)) return;
    delete vault.secrets[secretRef];
    await this.write(vault);
  }

  async delete(): Promise<void> {
    return this.runExclusive(() => this.deleteExclusive());
  }

  private async deleteExclusive(): Promise<void> {
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

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const next = this.mutation.then(async () => {
      result = await operation();
    });
    this.mutation = next.catch(() => undefined);
    await next;
    return result;
  }

  private async requireProtection() {
    const state = await this.provider.availability();
    if (
      !state.available ||
      !state.secure ||
      state.backend === "basic_text" ||
      state.backend === "unknown"
    ) {
      throw new Error("SECURE_SECRET_STORAGE_UNAVAILABLE");
    }
    return state;
  }

  private async readOrEmpty(): Promise<StoredVault> {
    let metadata;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { schemaVersion: 1, secrets: {} };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("SECRET_VAULT_UNSAFE_PATH");
    }
    const directoryMetadata = await lstat(dirname(this.path));
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("SECRET_VAULT_UNSAFE_PATH");
    }
    if (
      process.platform !== "win32" &&
      (directoryMetadata.mode & 0o077) !== 0
    ) {
      throw new Error("SECRET_VAULT_DIRECTORY_PERMISSIONS_TOO_BROAD");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("SECRET_VAULT_PERMISSIONS_TOO_BROAD");
    }
    if (metadata.size > 1_048_576) throw new Error("SECRET_VAULT_CORRUPT");
    const raw = await readFile(this.path, "utf8");
    return parseVault(raw);
  }

  private async write(vault: StoredVault): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory()
    ) {
      throw new Error("SECRET_VAULT_UNSAFE_PATH");
    }
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(vault), {
        mode: 0o600,
        flag: "wx",
      });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      if (process.platform !== "win32") await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
