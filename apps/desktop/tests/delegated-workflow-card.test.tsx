import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  delegatedWorkflowStates,
  deriveDelegatedWorkflowModel,
  type DelegatedWorkflowSnapshot,
} from "@village/ui";
import {
  DelegatedWorkflowCard,
  desktopTaskSelectionError,
} from "../src/renderer/DelegatedWorkflowCard.js";

const base: DelegatedWorkflowSnapshot = {
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
  state: "WORKING",
  logicalStep: "SET_DISPLAY_NAME",
  controller: "AGENT",
  connection: "ONLINE",
  actionPhase: "DISPATCHED",
  lastEffectActor: "AGENT",
  humanGate: null,
  inputOwner: "NONE",
  lastDurableUpdateAt: "2026-08-13T12:00:00.000Z",
};

describe("delegated workflow card", () => {
  it("defines truthful controls and input ownership for every interaction state", () => {
    expect(delegatedWorkflowStates).toHaveLength(13);
    for (const state of delegatedWorkflowStates) {
      const model = deriveDelegatedWorkflowModel({ ...base, state });
      expect(model.label).not.toBe("");
      expect(model.explanation).not.toBe("");
      expect(model.inputOwner).toBe(
        state === "OWNER_CONTROL" ? "OWNER" : "NONE",
      );
      if (state === "RECEIPTED_SUCCESS") {
        expect(model.label).toBe("Setup complete");
        expect(model.primaryAction).toBeNull();
      }
    }
  });

  it("renders labeled tasks, durable time, live status, and keyboard buttons", () => {
    const html = renderToStaticMarkup(
      <DelegatedWorkflowCard
        snapshot={base}
        activeTask="VILLAGE_FIXTURE"
        pendingAction={null}
        onAction={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );
    expect(html).toContain("LinkedIn (personal)");
    expect(html).toContain("Village demo setup");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Last durable update");
    expect(html).toContain("Take control");
    expect(html).toContain('type="button"');
  });

  it("never calls a receipted action phase complete unless workflow state is success", () => {
    expect(
      deriveDelegatedWorkflowModel({
        ...base,
        state: "WORKING",
        actionPhase: "RECEIPTED",
      }).label,
    ).not.toBe("Setup complete");
  });

  it("explains that the fixture task must be started before selection", () => {
    expect(
      desktopTaskSelectionError(
        "VILLAGE_FIXTURE",
        new Error("FIXTURE_TASK_NOT_STARTED"),
      ),
    ).toBe("Start the demo setup before opening the Village demo browser.");
    expect(
      desktopTaskSelectionError("VILLAGE_FIXTURE", new Error("FENCED")),
    ).toContain("Return control explicitly");
  });
});
