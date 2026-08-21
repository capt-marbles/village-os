import { spawn } from "node:child_process";
import { p256DevicePublicKeySchema } from "@village/contracts";
import { z } from "zod";
import type { HardwareDeviceKeyProvider } from "./device-identity-vault.js";

type SecureEnclaveHelperRun = (request: unknown) => Promise<unknown>;

const statusResponseSchema = z.strictObject({ available: z.boolean() });
const createResponseSchema = z.strictObject({
  wrappedKey: z.string().regex(/^[A-Za-z0-9_-]{8,16384}$/),
  publicKey: p256DevicePublicKeySchema,
});
const publicKeyResponseSchema = z.strictObject({
  publicKey: p256DevicePublicKeySchema,
});
const signatureResponseSchema = z.strictObject({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export class MacSecureEnclaveProvider implements HardwareDeviceKeyProvider {
  constructor(private readonly run: SecureEnclaveHelperRun) {}

  static forHelper(path: string): MacSecureEnclaveProvider {
    return new MacSecureEnclaveProvider(createHelperRunner(path));
  }

  async availability() {
    const response = parseResponse(
      statusResponseSchema,
      await this.run({ operation: "status" }),
    );
    return { available: response.available, backend: "secure_enclave" };
  }

  async create() {
    return parseResponse(
      createResponseSchema,
      await this.run({ operation: "create" }),
    );
  }

  async publicKey(wrappedKey: string) {
    assertWrappedKey(wrappedKey);
    return parseResponse(
      publicKeyResponseSchema,
      await this.run({ operation: "publicKey", wrappedKey }),
    ).publicKey;
  }

  async sign(wrappedKey: string, payload: ArrayBuffer): Promise<ArrayBuffer> {
    assertWrappedKey(wrappedKey);
    if (payload.byteLength === 0 || payload.byteLength > 1_048_576) {
      throw new Error("SECURE_ENCLAVE_PAYLOAD_INVALID");
    }
    const response = parseResponse(
      signatureResponseSchema,
      await this.run({
        operation: "sign",
        wrappedKey,
        payload: Buffer.from(payload).toString("base64url"),
      }),
    );
    return Uint8Array.from(Buffer.from(response.signature, "base64url")).buffer;
  }
}

function parseResponse<T>(schema: z.ZodType<T>, candidate: unknown): T {
  if (JSON.stringify(candidate).length > 65_536) {
    throw new Error("SECURE_ENCLAVE_HELPER_INVALID_RESPONSE");
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("SECURE_ENCLAVE_HELPER_INVALID_RESPONSE");
  }
  return parsed.data;
}

function assertWrappedKey(value: string): void {
  if (!/^[A-Za-z0-9_-]{8,16384}$/.test(value)) {
    throw new Error("SECURE_ENCLAVE_WRAPPED_KEY_INVALID");
  }
}

function createHelperRunner(path: string): SecureEnclaveHelperRun {
  return (request) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(request);
    } catch {
      return Promise.reject(new Error("SECURE_ENCLAVE_HELPER_REQUEST_INVALID"));
    }
    if (Buffer.byteLength(serialized) > 1_100_000) {
      return Promise.reject(
        new Error("SECURE_ENCLAVE_HELPER_REQUEST_TOO_LARGE"),
      );
    }
    return new Promise((resolve, reject) => {
      const child = spawn(path, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const output: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail("SECURE_ENCLAVE_HELPER_TIMEOUT");
      }, 10_000);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const fail = (code: string) => finish(() => reject(new Error(code)));
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 65_536) {
          child.kill("SIGKILL");
          fail("SECURE_ENCLAVE_HELPER_INVALID_RESPONSE");
          return;
        }
        output.push(chunk);
      });
      child.stderr.resume();
      child.on("error", () => fail("SECURE_ENCLAVE_HELPER_UNAVAILABLE"));
      child.on("close", (code) => {
        if (code !== 0) {
          fail("SECURE_ENCLAVE_HELPER_FAILED");
          return;
        }
        finish(() => {
          try {
            resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
          } catch {
            reject(new Error("SECURE_ENCLAVE_HELPER_INVALID_RESPONSE"));
          }
        });
      });
      child.stdin.end(serialized);
    });
  };
}
