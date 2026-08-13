import { describe, expect, it } from "vitest";
import { DeviceRevocationRegistry } from "../src/main/device-revocation.js";

describe("device revocation", () => {
  it("blocks future work for the exact revoked device without revoking another device", () => {
    const registry = new DeviceRevocationRegistry();
    registry.revoke("dev_01J00000000000000000000000");
    expect(registry.authorize("dev_01J00000000000000000000000")).toEqual({
      ok: false,
      code: "DEVICE_REVOKED",
    });
    expect(registry.authorize("dev_01J00000000000000000000001")).toEqual({
      ok: true,
    });
  });
});
