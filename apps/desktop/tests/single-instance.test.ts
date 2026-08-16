import { describe, expect, it, vi } from "vitest";
import { claimVillageInstance } from "../src/main/single-instance.js";

describe("Village single-instance ownership", () => {
  it("continues only for the process that owns the application lock", () => {
    const owner = {
      requestSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
    };
    const duplicate = {
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn(),
    };

    expect(claimVillageInstance(owner)).toBe(true);
    expect(owner.quit).not.toHaveBeenCalled();
    expect(claimVillageInstance(duplicate)).toBe(false);
    expect(duplicate.quit).toHaveBeenCalledOnce();
  });
});
