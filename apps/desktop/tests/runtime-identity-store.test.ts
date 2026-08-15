import { describe, expect, it, vi } from "vitest";
import { SecretRuntimeIdentityStore } from "../src/main/runtime-identity-store.js";

describe("runtime identity store", () => {
  it("stores and loads only schema-valid paired identity", async () => {
    let stored = new Uint8Array();
    const vault = {
      store: vi.fn(async (_reference: string, value: Uint8Array) => {
        stored = new Uint8Array(value);
        value.fill(0);
        return { version: 1 };
      }),
      withSecret: vi.fn(
        async (_reference: string, use: (value: Uint8Array) => unknown) =>
          use(new Uint8Array(stored)),
      ),
    };
    const store = new SecretRuntimeIdentityStore(vault);
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      fixtureBrowserSessionId: "brs_01J00000000000000000000001",
      controlPlaneOrigin: "https://village.example",
    };
    await store.store(identity);
    await expect(store.load()).resolves.toEqual(identity);
  });
});
