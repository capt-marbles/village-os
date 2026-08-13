import { describe, expect, it } from "vitest";
import {
  deriveBrowserUiModel,
  type BrowserUiSnapshot,
} from "../browser-ui-state-matrix.js";

const snapshot: BrowserUiSnapshot = {
  surface: "DESKTOP",
  jobState: "RUNNING_AGENT",
  controller: "AGENT",
  connection: "ONLINE",
  takeover: "NONE",
  pairing: "PAIRED",
  verification: "unknown",
  profile: "PRESENT",
  humanGate: null,
  erasure: "IDLE",
  lastUpdatedAt: "2026-08-13T03:00:00.000Z",
};

describe("browser UI state matrix", () => {
  it("does not claim user control until takeover is acknowledged", () => {
    expect(
      deriveBrowserUiModel({ ...snapshot, takeover: "QUIESCING" }),
    ).toMatchObject({
      label: "Taking control safely…",
      browserInputEnabled: false,
      primaryAction: null,
    });
    expect(
      deriveBrowserUiModel({ ...snapshot, controller: "USER" }),
    ).toMatchObject({
      label: "You have control",
      browserInputEnabled: true,
      primaryAction: "RETURN_TO_AGENT",
    });
  });

  it("blocks hand-back while offline and explains reconciliation", () => {
    expect(
      deriveBrowserUiModel({
        ...snapshot,
        controller: "USER",
        connection: "OFFLINE",
        takeover: "OFFLINE_MARKED",
      }),
    ).toMatchObject({
      label: "You have local control — offline",
      browserInputEnabled: true,
      primaryAction: "RETURN_TO_AGENT",
      primaryEnabled: false,
    });
    expect(
      deriveBrowserUiModel({
        ...snapshot,
        controller: "NONE",
        takeover: "RECONCILING",
      }),
    ).toMatchObject({
      label: "Reconciling before hand-back…",
      browserInputEnabled: false,
    });
  });

  it("limits observer actions and never implies a live remote browser", () => {
    expect(
      deriveBrowserUiModel({ ...snapshot, surface: "OBSERVER" }),
    ).toMatchObject({
      primaryAction: null,
      browserInputEnabled: false,
      liveBrowserAvailable: false,
    });
  });

  it("keeps cancel and destructive erasure distinct", () => {
    const model = deriveBrowserUiModel(snapshot);
    expect(model.secondaryActions).toContain("CANCEL_AUTOMATION");
    expect(model.secondaryActions).toContain("BEGIN_FORGET_SESSION");
    expect(model.destructiveActionRequiresStepUp).toBe(true);
  });

  it.each([
    ["UNPAIRED", "Pair this desktop"],
    ["CONFIRMING", "Confirm this desktop"],
    ["EXPIRED", "Pairing expired"],
    ["REJECTED", "Pairing declined"],
    ["REVOKED", "Desktop access revoked"],
    ["RECOVERING", "Restoring desktop connection…"],
  ] as const)("gives pairing state %s distinct status", (pairing, label) => {
    expect(deriveBrowserUiModel({ ...snapshot, pairing }).label).toBe(label);
  });

  it("makes partial erasure retriable without claiming completion", () => {
    expect(
      deriveBrowserUiModel({
        ...snapshot,
        profile: "ERASURE_FAILED",
        erasure: "FAILED",
      }),
    ).toMatchObject({
      label: "Session removal needs attention",
      primaryAction: "RETRY_ERASURE",
      primaryEnabled: true,
    });
  });
});
