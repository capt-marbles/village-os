import { describe, expect, it, vi } from "vitest";
import { MacSecureEnclaveProvider } from "../src/main/mac-secure-enclave-provider.js";

const publicKey = {
  kty: "EC" as const,
  crv: "P-256" as const,
  x: "a".repeat(43),
  y: "b".repeat(43),
};

describe("macOS Secure Enclave provider", () => {
  it("keeps wrapped key material and payloads on bounded stdin", async () => {
    const run = vi.fn(async (request: unknown) => {
      const operation = (request as { operation: string }).operation;
      if (operation === "status") return { available: true };
      if (operation === "create") {
        return { wrappedKey: "wrapped-device-key", publicKey };
      }
      if (operation === "publicKey") return { publicKey };
      return { signature: "c".repeat(86) };
    });
    const provider = new MacSecureEnclaveProvider(run);

    await expect(provider.availability()).resolves.toEqual({
      available: true,
      backend: "secure_enclave",
    });
    await expect(provider.create()).resolves.toEqual({
      wrappedKey: "wrapped-device-key",
      publicKey,
    });
    await expect(provider.publicKey("wrapped-device-key")).resolves.toEqual(
      publicKey,
    );
    await expect(
      provider.sign(
        "wrapped-device-key",
        new TextEncoder().encode("bounded payload").buffer,
      ),
    ).resolves.toHaveProperty("byteLength", 64);
    expect(JSON.stringify(run.mock.calls)).not.toContain("privateKey");
  });

  it("fails closed on malformed or oversized helper responses", async () => {
    await expect(
      new MacSecureEnclaveProvider(async () => ({
        available: "yes",
      })).availability(),
    ).rejects.toThrow("SECURE_ENCLAVE_HELPER_INVALID_RESPONSE");
    await expect(
      new MacSecureEnclaveProvider(async () => ({
        signature: "a".repeat(90_000),
      })).sign("wrapped-device-key", new ArrayBuffer(1)),
    ).rejects.toThrow("SECURE_ENCLAVE_HELPER_INVALID_RESPONSE");
  });
});
