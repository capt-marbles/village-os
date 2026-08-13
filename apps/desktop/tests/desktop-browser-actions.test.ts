import { describe, expect, it, vi } from "vitest";
import {
  dispatchDesktopBrowserAction,
  type VillageDesktopBridge,
} from "../src/renderer/DesktopBrowserPane.js";

function bridge(): VillageDesktopBridge {
  return {
    getBrowserUiState: vi.fn(),
    subscribeBrowserUiState: vi.fn(() => () => undefined),
    requestTakeover: vi.fn(),
    requestReturnControl: vi.fn(),
    setBrowserPane: vi.fn(),
    recordVerificationDecision: vi.fn(),
    requestForgetSession: vi.fn(),
    requestObserverIntent: vi.fn(),
  };
}

describe("desktop browser action dispatch", () => {
  it("routes cancel and forget-session through fixed bridge methods", async () => {
    const village = bridge();
    await dispatchDesktopBrowserAction(village, "CANCEL_AUTOMATION");
    await dispatchDesktopBrowserAction(village, "BEGIN_FORGET_SESSION");

    expect(village.requestObserverIntent).toHaveBeenCalledWith(
      "CANCEL_FUTURE_AUTOMATION",
    );
    expect(village.requestForgetSession).toHaveBeenCalledOnce();
  });
});
