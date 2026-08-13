import { describe, expect, it, vi } from "vitest";
import { ControlTransferGate } from "../src/main/control-transfer-gate.js";

describe("control transfer gate", () => {
  it("coalesces duplicate transfer requests", async () => {
    const gate = new ControlTransferGate();
    let resolve!: (value: string) => void;
    const operation = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );

    const first = gate.run(operation);
    const second = gate.run(operation);
    expect(first).toBe(second);
    expect(operation).toHaveBeenCalledTimes(1);

    resolve("done");
    await expect(first).resolves.toBe("done");
  });

  it("accepts a new transfer after failure", async () => {
    const gate = new ControlTransferGate();
    await expect(
      gate.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(gate.run(async () => "retried")).resolves.toBe("retried");
  });
});
