import { describe, expect, it, vi } from "vitest";
import { exitWithoutContinuation } from "../src/main/abrupt-exit-barrier.js";

describe("exitWithoutContinuation", () => {
  it("requests exit without allowing asynchronous work to continue", async () => {
    const stopped = new Error("PROCESS_EXITED");
    const exit = vi.fn((): never => {
      throw stopped;
    });

    expect(() => exitWithoutContinuation(exit, 86)).toThrow(stopped);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(86);
  });
});
