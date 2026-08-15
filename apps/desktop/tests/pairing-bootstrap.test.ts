import { describe, expect, it, vi } from "vitest";
import { PairingBootstrapService } from "../src/main/pairing-bootstrap.js";

const publicJwk = {
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  x: "cHVibGljX2tleV9mb3JfdmlsbGFnZQ",
};

describe("pairing bootstrap", () => {
  it("exposes only public device material and persists confirmed runtime identity", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const identityVault = {
      load: vi.fn().mockRejectedValue(missing),
      create: vi.fn().mockResolvedValue({
        publicJwk,
        protectionBackend: "keychain",
      }),
    };
    const pairingClient = {
      consume: vi.fn().mockResolvedValue({
        deviceId: "dev_01J00000000000000000000000",
      }),
    };
    const runtimeStore = { store: vi.fn() };
    const service = new PairingBootstrapService(
      identityVault,
      pairingClient,
      runtimeStore,
      () => "dev_01J00000000000000000000000",
      "Village desktop",
      () => "a".repeat(43),
      "https://village.example",
    );

    await expect(service.request()).resolves.toMatchObject({
      deviceId: "dev_01J00000000000000000000000",
      deviceDisplayName: "Village desktop",
      publicKey: publicJwk,
      protection: "OS_PROTECTED_FALLBACK",
      secretHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const paired = await service.complete({
      principalId: "prn_01J00000000000000000000000",
      pairingId: "par_01J00000000000000000000000",
    });
    const identity = await service.attachSession({
      ...paired,
      browserSessionId: "brs_01J00000000000000000000000",
    });
    expect(pairingClient.consume).toHaveBeenCalledWith({
      principalId: identity.principalId,
      pairingId: "par_01J00000000000000000000000",
      secret: "a".repeat(43),
    });
    expect(runtimeStore.store).toHaveBeenCalledWith(identity);
    expect(identity).toMatchObject({
      controlPlaneOrigin: "https://village.example",
    });
  });

  it("rejects a challenge registered for another device", async () => {
    const service = new PairingBootstrapService(
      {
        load: vi.fn().mockResolvedValue({
          publicJwk,
          protectionBackend: "keychain",
        }),
        create: vi.fn(),
      },
      {
        consume: vi.fn().mockResolvedValue({
          deviceId: "dev_01J00000000000000000000001",
        }),
      },
      { store: vi.fn() },
      () => "dev_01J00000000000000000000000",
    );
    await expect(
      service.complete({
        principalId: "prn_01J00000000000000000000000",
        pairingId: "par_01J00000000000000000000000",
        secret: "a".repeat(43),
      }),
    ).rejects.toThrow("PAIRING_DEVICE_MISMATCH");
  });
});
