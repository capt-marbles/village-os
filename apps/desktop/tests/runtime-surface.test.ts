import { describe, expect, it } from "vitest";
import { resolveRuntimeSurface } from "../src/main/runtime-surface.js";

describe("runtime surface", () => {
  it("opens the isolated Ritual Builder only for the exact preview argument", () => {
    expect(resolveRuntimeSurface(["Village", "--ritual-builder"])).toBe(
      "RITUAL_BUILDER",
    );
    expect(resolveRuntimeSurface(["Village", "--ritual-builder-evil"])).toBe(
      "WORKSPACE",
    );
    expect(resolveRuntimeSurface(["Village"])).toBe("WORKSPACE");
  });
});
