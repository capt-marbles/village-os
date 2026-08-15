// @vitest-environment happy-dom

import {
  cleanup,
  act,
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
const nextIdentity = {
  draftId: "rtd_01J00000000000000000000001",
  ritualId: "rtl_01J00000000000000000000001",
};

const approved = {
  schemaVersion: 1 as const,
  ritualId: identity.ritualId,
  ritualRevision: 1 as const,
  status: "APPROVED" as const,
  approvedDraftId: identity.draftId,
  approvedDraftRevision: 3,
  name: "Pipeline review",
  purpose: "Prepare my pipeline review.",
  trigger: { kind: "ON_DEMAND" as const, summary: "Whenever I ask" },
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
  reviewPolicy: {
    ownerReview: "EVERY_RUN" as const,
    learning: "PROPOSE_ONLY" as const,
  },
  approvedAt: "2026-08-15T16:03:00.000Z",
};

const receipt = {
  schemaVersion: 1 as const,
  receiptId: "rcp_01J00000000000000000000000",
  runId: "rrn_01J00000000000000000000000",
  ritualId: approved.ritualId,
  ritualRevision: 1,
  mode: "TEST" as const,
  outcome: "NEEDS_REVIEW" as const,
  summary: "Customer A should receive the first response.",
  evidence: ["The supplied deadline is Friday."],
  uncertainties: ["Commercial impact was not supplied."],
  sampleDigest: "a".repeat(64),
  sampleCharacterCount: 42,
  externalEffects: [] as const,
  recordedAt: "2026-08-15T18:03:00.000Z",
};

function bridge() {
  return {
    initialize: vi.fn(async () => ({
      identity,
      approved: null,
      receipt: null,
    })),
    createDraftIdentity: vi.fn(async () => nextIdentity),
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
    testRun: vi.fn(async () => ({ status: "receipt" as const, receipt })),
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

  it("turns a supplied sample into a reviewable no-effects Receipt", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
    });
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Ritual approved");

    fireEvent.click(screen.getByRole("button", { name: "Test this Ritual" }));
    fireEvent.change(screen.getByLabelText("Representative sample"), {
      target: { value: "Customer A needs an answer before Friday." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run safe test" }));

    await screen.findByText("Test Receipt");
    expect(activeBridge.testRun).toHaveBeenCalledWith({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: 1,
      sample: "Customer A needs an answer before Friday.",
    });
    expect(screen.getByText(receipt.summary)).toBeTruthy();
    expect(screen.getByText("No external effects")).toBeTruthy();
    expect(screen.getByText(/Commercial impact/u)).toBeTruthy();
    expect(screen.queryByLabelText("Representative sample")).toBeNull();
  });

  it("coalesces rapid duplicate submits into one paid Test Run", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
    });
    activeBridge.testRun.mockImplementation(() => new Promise(() => undefined));
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Ritual approved");
    fireEvent.click(screen.getByRole("button", { name: "Test this Ritual" }));
    fireEvent.change(screen.getByLabelText("Representative sample"), {
      target: { value: "A representative sample." },
    });
    const submit = screen.getByRole("button", { name: "Run safe test" });

    act(() => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => expect(activeBridge.testRun).toHaveBeenCalledOnce());
  });

  it("restores the latest Receipt beside its exact approved Ritual", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt,
    });

    render(<RitualBuilderWorkspace bridge={activeBridge} />);

    await screen.findByText("Test Receipt");
    expect(screen.getByText(receipt.summary)).toBeTruthy();
    expect(screen.getByText("No external effects")).toBeTruthy();
    expect(activeBridge.testRun).not.toHaveBeenCalled();
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

  it("starts another Ritual with a fresh identity while preserving the approval", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
    });
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Ritual approved");

    fireEvent.click(
      screen.getByRole("button", { name: "Shape another Ritual" }),
    );
    await screen.findByLabelText("What should become repeatable?");
    expect(activeBridge.createDraftIdentity).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText("What should become repeatable?"), {
      target: { value: "Review new support requests." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start the draft" }));
    await waitFor(() => expect(activeBridge.draft).toHaveBeenCalledOnce());
    expect(activeBridge.draft).toHaveBeenCalledWith({
      schemaVersion: 1,
      draftId: nextIdentity.draftId,
      requestRevision: 1,
      ownerPurpose: "Review new support requests.",
    });
    expect(screen.getByText(/Pipeline review remains saved/u)).toBeTruthy();
  });

  it("keeps the approved Ritual available when fresh identity creation fails", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
    });
    activeBridge.createDraftIdentity.mockRejectedValueOnce(
      new Error("IDENTITY_UNAVAILABLE"),
    );
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Ritual approved");

    fireEvent.click(
      screen.getByRole("button", { name: "Shape another Ritual" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not prepare another Ritual",
    );
    expect(screen.getByText("Pipeline review")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Shape another Ritual" }),
    ).toBeTruthy();
  });
});
