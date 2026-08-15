import { describe, expect, it, vi } from "vitest";
import { InternalPairedBootstrap } from "../src/main/internal-paired-bootstrap.js";

describe("internal paired bootstrap", () => {
  it("reuses provisioning when coordination composition retries", async () => {
    const provision = vi.fn(async () => ({ browserSessionId: "brs_fixture" }));
    const compose = vi
      .fn()
      .mockRejectedValueOnce(new Error("COORDINATOR_OFFLINE"))
      .mockResolvedValueOnce({ coordinator: "connected" });
    const bootstrap = new InternalPairedBootstrap(provision, compose);

    await expect(bootstrap.result()).rejects.toThrow("COORDINATOR_OFFLINE");
    await expect(bootstrap.result()).resolves.toEqual({
      provisioned: { browserSessionId: "brs_fixture" },
      coordination: { coordinator: "connected" },
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledTimes(2);
  });

  it("retries provisioning when provisioning itself fails", async () => {
    const provision = vi
      .fn()
      .mockRejectedValueOnce(new Error("CONTROL_PLANE_OFFLINE"))
      .mockResolvedValueOnce({ browserSessionId: "brs_fixture" });
    const compose = vi.fn(async () => ({ coordinator: "connected" }));
    const bootstrap = new InternalPairedBootstrap(provision, compose);

    await expect(bootstrap.result()).rejects.toThrow("CONTROL_PLANE_OFFLINE");
    await expect(bootstrap.result()).resolves.toMatchObject({
      provisioned: { browserSessionId: "brs_fixture" },
    });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(compose).toHaveBeenCalledTimes(1);
  });
});
