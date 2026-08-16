import { describe, expect, it, vi } from "vitest";
import { ExaCredentialController } from "../src/research/exa-credential-controller.js";
import { ExaApiKeyValidationError } from "../src/research/exa-api-key-store.js";

describe("Exa credential controller", () => {
  it("returns only bounded status while configuring and removing the local key", async () => {
    let configured = false;
    let version = 0;
    const store = {
      status: vi.fn(async () =>
        configured
          ? { configured: true as const, version }
          : { configured: false as const },
      ),
      configure: vi.fn(async (candidate: Uint8Array) => {
        configured = true;
        version += 1;
        candidate.fill(0);
        return { configured: true as const, version };
      }),
      revoke: vi.fn(async () => {
        configured = false;
      }),
    };
    const controller = new ExaCredentialController(store);
    const candidate = new TextEncoder().encode("exa-owner-secret");

    await expect(controller.status()).resolves.toEqual({
      provider: "EXA",
      state: "CONFIGURATION_REQUIRED",
    });
    await expect(controller.configure(candidate)).resolves.toEqual({
      status: "snapshot",
      snapshot: { provider: "EXA", state: "CONFIGURED", version: 1 },
    });
    expect(candidate.every((byte) => byte === 0)).toBe(true);
    await expect(controller.revoke(1)).resolves.toEqual({
      status: "snapshot",
      snapshot: { provider: "EXA", state: "CONFIGURATION_REQUIRED" },
    });
  });

  it("rejects malformed IPC input without echoing it and bounds vault failures", async () => {
    const store = {
      status: vi.fn(async () => {
        throw new Error("credential-shaped storage detail");
      }),
      configure: vi.fn(async () => {
        throw new ExaApiKeyValidationError();
      }),
      revoke: vi.fn(async () => {
        throw new Error("credential-shaped storage detail");
      }),
    };
    const controller = new ExaCredentialController(store);

    await expect(controller.configure("exa-secret")).resolves.toEqual({
      status: "rejected",
      reason: "INVALID_API_KEY",
    });
    expect(store.configure).not.toHaveBeenCalled();
    await expect(
      controller.configure(new TextEncoder().encode("malformed-key")),
    ).resolves.toEqual({ status: "rejected", reason: "INVALID_API_KEY" });
    await expect(controller.status()).resolves.toEqual({
      provider: "EXA",
      state: "UNAVAILABLE",
      reason: "CREDENTIAL_STORE_UNAVAILABLE",
    });
    await expect(controller.revoke(1)).resolves.toEqual({
      status: "rejected",
      reason: "CREDENTIAL_STORE_UNAVAILABLE",
    });
  });

  it("does not revoke a key replaced after removal confirmation began", async () => {
    const store = {
      status: vi.fn(async () => ({ configured: true as const, version: 2 })),
      configure: vi.fn(),
      revoke: vi.fn(async () => undefined),
    };
    const controller = new ExaCredentialController(store);

    await expect(controller.revoke(1)).resolves.toEqual({
      status: "rejected",
      reason: "CREDENTIAL_CHANGED",
    });
    expect(store.revoke).not.toHaveBeenCalled();
  });
});
