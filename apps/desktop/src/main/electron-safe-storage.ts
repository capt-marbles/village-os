import { safeStorage } from "electron";
import type { PlatformKeyProtector } from "./device-identity-vault.js";

export class ElectronSafeStorageProtector implements PlatformKeyProtector {
  async availability() {
    const available = await safeStorage.isAsyncEncryptionAvailable();
    const backend =
      process.platform === "linux"
        ? safeStorage.getSelectedStorageBackend()
        : process.platform === "darwin"
          ? "keychain"
          : "dpapi";
    return {
      available,
      backend,
      secure: available && backend !== "basic_text" && backend !== "unknown",
    };
  }

  async encrypt(value: string): Promise<Uint8Array> {
    return new Uint8Array(await safeStorage.encryptStringAsync(value));
  }

  async decrypt(value: Uint8Array) {
    const result = await safeStorage.decryptStringAsync(Buffer.from(value));
    return {
      value: result.result,
      shouldReEncrypt: result.shouldReEncrypt,
    };
  }
}
