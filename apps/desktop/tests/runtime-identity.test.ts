import { describe, expect, it } from "vitest";
import {
  LOCAL_DEVELOPMENT_FIXTURE_IDENTITY,
  resolveRuntimeIdentity,
  type PairedRuntimeIdentitySource,
} from "../src/main/runtime-identity.js";

const pairedIdentity = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
};

function source(value: unknown): PairedRuntimeIdentitySource {
  return { load: async () => value };
}

describe("runtime identity resolution", () => {
  it("uses clearly named fixture identity only for unpackaged development", async () => {
    await expect(
      resolveRuntimeIdentity({ isPackaged: false }),
    ).resolves.toEqual(LOCAL_DEVELOPMENT_FIXTURE_IDENTITY);
  });

  it("fails closed for a packaged app without paired identity bootstrap", async () => {
    await expect(resolveRuntimeIdentity({ isPackaged: true })).rejects.toThrow(
      "PAIRED_RUNTIME_IDENTITY_REQUIRED",
    );
  });

  it("rejects malformed paired identity instead of accepting fixture scope", async () => {
    await expect(
      resolveRuntimeIdentity({
        isPackaged: true,
        pairedIdentitySource: source({
          ...pairedIdentity,
          deviceId: "dev_bad",
        }),
      }),
    ).rejects.toThrow("PAIRED_RUNTIME_IDENTITY_REQUIRED");
  });

  it("uses the paired identity source for a packaged app", async () => {
    await expect(
      resolveRuntimeIdentity({
        isPackaged: true,
        pairedIdentitySource: source(pairedIdentity),
      }),
    ).resolves.toEqual(pairedIdentity);
  });
});
