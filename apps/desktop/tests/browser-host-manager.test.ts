import { describe, expect, it, vi } from "vitest";
import { BrowserHostManager } from "../src/main/browser-host-manager.js";

function host(name: string) {
  return {
    name,
    view: {
      setVisible: vi.fn(),
      webContents: { focus: vi.fn(), isDestroyed: () => false },
    },
    close: vi.fn(async () => undefined),
  };
}

describe("browser host manager", () => {
  it("keeps separate hosts and fences the fixture whenever LinkedIn becomes visible", async () => {
    const linkedin = host("linkedin");
    const fixture = host("fixture");
    const fence = vi.fn();
    const manager = new BrowserHostManager(
      linkedin as never,
      fixture as never,
      {
        fenceFixture: fence,
      },
    );

    manager.show("VILLAGE_FIXTURE");
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(true);
    manager.show("LINKEDIN_PERSONAL");
    expect(fence).toHaveBeenCalledWith("TASK_SWITCH");
    expect(linkedin.view.setVisible).toHaveBeenLastCalledWith(true);
    expect(fixture.view.setVisible).toHaveBeenLastCalledWith(false);
    expect(manager.fixtureRequiresHandBack()).toBe(true);
    expect(() => manager.show("VILLAGE_FIXTURE")).toThrow(
      "FIXTURE_HAND_BACK_REQUIRED",
    );
    manager.allowFixtureAfterHandBack();
    manager.show("VILLAGE_FIXTURE");
    expect(fixture.view.webContents.focus).toHaveBeenCalled();
  });
});
