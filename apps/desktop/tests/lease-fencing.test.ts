import { describe, expect, it } from "vitest";
import { LocalActionExecutor } from "../src/browser/local-action-executor.js";

describe("local action lease fencing", () => {
  it("rejects stale epochs and blocks dequeue after offline takeover", async () => {
    const executor = new LocalActionExecutor({ leaseEpoch: 4 });
    await expect(
      executor.execute({
        actionId: "act_01J00000000000000000000000",
        leaseEpoch: 3,
        mutationClass: "IDEMPOTENT",
        run: async () => "SATISFIED",
      }),
    ).rejects.toThrow("STALE_LEASE_EPOCH");

    executor.markOfflineTakeover();
    await expect(
      executor.execute({
        actionId: "act_01J00000000000000000000001",
        leaseEpoch: 4,
        mutationClass: "IDEMPOTENT",
        run: async () => "SATISFIED",
      }),
    ).rejects.toThrow("AUTOMATION_BLOCKED");
  });

  it("waits for one in-flight action before acknowledging takeover", async () => {
    let finish!: (value: "SATISFIED") => void;
    const executor = new LocalActionExecutor({ leaseEpoch: 1 });
    const running = executor.execute({
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      mutationClass: "NON_IDEMPOTENT",
      run: () => new Promise((resolve) => (finish = resolve)),
    });
    const takeover = executor.beginOnlineTakeover(2, 1_000);
    expect(executor.isAutomationBlocked()).toBe(true);
    finish("SATISFIED");
    await expect(takeover).resolves.toEqual({ status: "QUIESCED" });
    await running;
  });

  it("reports uncertainty when forced takeover times out", async () => {
    const executor = new LocalActionExecutor({ leaseEpoch: 1 });
    void executor.execute({
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 1,
      mutationClass: "NON_IDEMPOTENT",
      run: () => new Promise(() => undefined),
    });
    await expect(executor.beginOnlineTakeover(2, 1)).resolves.toEqual({
      status: "OUTCOME_UNKNOWN",
      actionId: "act_01J00000000000000000000000",
    });
  });
});
