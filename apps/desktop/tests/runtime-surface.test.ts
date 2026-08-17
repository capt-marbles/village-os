import { describe, expect, it } from "vitest";
import { resolveRuntimeSurface } from "../src/main/runtime-surface.js";

describe("runtime surface", () => {
  it("opens the Steward workspace by default and keeps the browser explicit", () => {
    expect(resolveRuntimeSurface(["Village"])).toBe("RITUAL_BUILDER");
    expect(resolveRuntimeSurface(["Village", "--ritual-builder"])).toBe(
      "RITUAL_BUILDER",
    );
    expect(resolveRuntimeSurface(["Village", "--browser-workspace"])).toBe(
      "WORKSPACE",
    );
    expect(resolveRuntimeSurface(["Village", "--browser-workspace-evil"])).toBe(
      "RITUAL_BUILDER",
    );
  });
});
