// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RitualBuilderWorkspace } from "../src/renderer/RitualBuilderWorkspace.js";
import { resolveDesktopRendererMode } from "../src/renderer/renderer-mode.js";

afterEach(cleanup);

const identity = {
  draftId: "rtd_01J00000000000000000000000",
  ritualId: "rtl_01J00000000000000000000000",
};

function bridge() {
  return {
    initialize: vi.fn(async () => ({ identity, approved: null })),
    draft: vi.fn(async (context) => ({
      status: "proposal" as const,
      draftId: context.draftId,
      requestRevision: context.requestRevision,
      stewardMessage: "I shaped a focused draft. When should it begin?",
      name: "Pipeline review",
      purpose: context.ownerPurpose,
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather the bounded information needed for the review.",
          actor: { kind: "STEWARD" as const, role: "Steward" },
          approval: "OWNER_REQUIRED" as const,
        },
      ],
      permissions: ["Read only connected records"],
      completion: "A reviewable result is ready.",
    })),
    approve: vi.fn(async (ritual) => ritual),
  };
}

describe("RitualBuilderWorkspace", () => {
  it("selects the builder only from its exact local query mode", () => {
    expect(
      resolveDesktopRendererMode(new URL("village://app/?mode=ritual-builder")),
    ).toBe("RITUAL_BUILDER");
    expect(
      resolveDesktopRendererMode(new URL("village://app/?mode=pairing")),
    ).toBe("PAIRING");
    expect(
      resolveDesktopRendererMode(
        new URL("village://app/?mode=ritual-builder-evil"),
      ),
    ).toBe("WORKSPACE");
  });

  it("does not call the Steward when local purpose validation fails", async () => {
    const activeBridge = bridge();
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Shape a Ritual with your Steward");
    fireEvent.change(screen.getByLabelText("What should become repeatable?"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start the draft" }));
    expect(screen.getByRole("alert").textContent).toContain("outcome");
    expect(activeBridge.draft).not.toHaveBeenCalled();
  });

  it("shows the bounded provider failure reason instead of a generic error", async () => {
    const activeBridge = bridge();
    activeBridge.draft.mockResolvedValueOnce({
      status: "waiting",
      draftId: identity.draftId,
      requestRevision: 1,
      reason: "MALFORMED_PROVIDER_OUTPUT",
    });
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Shape a Ritual with your Steward");
    fireEvent.change(screen.getByLabelText("What should become repeatable?"), {
      target: { value: "Prepare my pipeline review." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start the draft" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not safely validate",
    );
  });

  it("completes the live Steward-to-local-approval chain without starting a Run", async () => {
    const activeBridge = bridge();
    let persistApproval!: (
      ritual: Awaited<ReturnType<typeof activeBridge.approve>>,
    ) => void;
    activeBridge.approve.mockImplementation(
      (ritual) =>
        new Promise((resolve) => {
          persistApproval = resolve;
          void ritual;
        }),
    );
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Shape a Ritual with your Steward");

    fireEvent.change(screen.getByLabelText("What should become repeatable?"), {
      target: { value: "Prepare my pipeline review." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start the draft" }));
    expect(screen.getByRole("status").textContent).toContain("shaping");
    await screen.findByRole("button", { name: /On demand/u });
    fireEvent.click(screen.getByRole("button", { name: /On demand/u }));
    fireEvent.click(screen.getByRole("button", { name: /Review every Run/u }));
    fireEvent.click(screen.getByRole("button", { name: "Approve Ritual" }));

    await waitFor(() => expect(activeBridge.approve).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toContain("Saving approval");
    expect(screen.queryByText("Ritual approved")).toBeNull();
    persistApproval(activeBridge.approve.mock.calls[0]![0]);
    await screen.findByText("Ritual approved");
    expect(activeBridge.draft).toHaveBeenCalledWith({
      schemaVersion: 1,
      draftId: identity.draftId,
      requestRevision: 1,
      ownerPurpose: "Prepare my pipeline review.",
    });
    expect(screen.getByRole("status").textContent).toContain(
      "No Run has started",
    );
  });
});
