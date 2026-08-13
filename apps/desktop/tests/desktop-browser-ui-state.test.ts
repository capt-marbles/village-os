import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserUiState } from "../src/main/desktop-browser-ui-state.js";

describe("desktop browser UI projection", () => {
  it("publishes takeover only after quiescence acknowledgement", () => {
    const state = new DesktopBrowserUiState();
    const observed: string[] = [];
    state.subscribe((snapshot) =>
      observed.push(`${snapshot.controller}:${snapshot.takeover}`),
    );

    state.beginTakeover();
    expect(state.current()).toMatchObject({
      controller: "NONE",
      takeover: "QUIESCING",
    });
    state.completeTakeover();
    expect(state.current()).toMatchObject({
      controller: "USER",
      takeover: "NONE",
      jobState: "RUNNING_USER",
    });
    expect(observed).toEqual(["NONE:QUIESCING", "USER:NONE"]);
  });

  it("records a fenced takeover recovery as user-controlled", () => {
    const state = new DesktopBrowserUiState();
    state.beginTakeover();
    state.completeTakeover("UNKNOWN_CHALLENGE");

    expect(state.current()).toMatchObject({
      controller: "USER",
      takeover: "NONE",
      jobState: "RUNNING_USER",
      humanGate: "UNKNOWN_CHALLENGE",
    });
  });

  it("restores user control when hand-back reconciliation fails", () => {
    const state = new DesktopBrowserUiState({
      controller: "USER",
      jobState: "RUNNING_USER",
    });
    state.beginReturnControl();
    state.restoreUserAfterFailedReturn();

    expect(state.current()).toMatchObject({
      controller: "USER",
      takeover: "NONE",
      jobState: "RUNNING_USER",
      humanGate: "UNKNOWN_CHALLENGE",
    });
  });

  it("keeps offline human control but rejects hand-back", () => {
    const state = new DesktopBrowserUiState({
      controller: "USER",
      jobState: "RUNNING_USER",
    });
    state.markConnection("OFFLINE");
    expect(state.current()).toMatchObject({
      controller: "USER",
      connection: "OFFLINE",
      takeover: "OFFLINE_MARKED",
    });
    expect(() => state.beginReturnControl()).toThrow(
      "RETURN_REQUIRES_ONLINE_USER_CONTROL",
    );
  });

  it("records owner confirmation distinctly from automatic authentication", () => {
    const state = new DesktopBrowserUiState({ jobState: "VERIFYING" });
    state.recordVerification("confirmed_by_user");
    expect(state.current()).toMatchObject({
      verification: "confirmed_by_user",
      jobState: "SUCCEEDED",
    });
  });

  it("separates cancellation from step-up session erasure", () => {
    const state = new DesktopBrowserUiState();
    state.cancelFutureAutomation();
    expect(state.current()).toMatchObject({
      jobState: "CANCELED",
      profile: "PRESENT",
      erasure: "IDLE",
    });
    state.requireStepUpForErasure();
    expect(state.current()).toMatchObject({
      profile: "PRESENT",
      erasure: "STEP_UP_REQUIRED",
    });
  });

  it("does not broadcast an identical state update", () => {
    const state = new DesktopBrowserUiState();
    const listener = vi.fn();
    state.subscribe(listener);
    state.markConnection("ONLINE");
    expect(listener).not.toHaveBeenCalled();
  });
});
