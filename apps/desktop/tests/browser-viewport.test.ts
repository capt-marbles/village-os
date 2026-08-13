import { describe, expect, it } from "vitest";
import {
  BrowserViewportCoordinator,
  calculateBrowserBounds,
} from "../src/main/browser-viewport-coordinator.js";

describe("native browser viewport", () => {
  it("clamps the split and reserves trusted chrome", () => {
    expect(
      calculateBrowserBounds(
        { width: 1_200, height: 800 },
        { splitRatio: 0.4, topInset: 48, minWidth: 320 },
      ),
    ).toEqual({ x: 720, y: 48, width: 480, height: 752 });
    expect(
      calculateBrowserBounds(
        { width: 500, height: 200 },
        { splitRatio: 0.05, topInset: 500, minWidth: 320 },
      ),
    ).toEqual({ x: 180, y: 200, width: 320, height: 0 });
  });

  it("keeps remote input covered until takeover is acknowledged", () => {
    const calls: string[] = [];
    const coordinator = new BrowserViewportCoordinator({
      setBounds: () => calls.push("bounds"),
      setVisible: (visible) => calls.push(`visible:${visible}`),
      setInputEnabled: (enabled) => calls.push(`input:${enabled}`),
      focus: () => calls.push("focus"),
      destroy: () => calls.push("destroy"),
    });

    coordinator.layout({ width: 900, height: 600 });
    coordinator.beginTakeover();
    coordinator.acknowledgeTakeover();
    coordinator.destroy();

    expect(calls).toContain("input:false");
    expect(calls.indexOf("input:true")).toBeGreaterThan(
      calls.indexOf("input:false"),
    );
    expect(calls.at(-1)).toBe("destroy");
  });
});
