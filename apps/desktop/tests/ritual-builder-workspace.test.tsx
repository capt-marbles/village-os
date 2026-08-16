// @vitest-environment happy-dom

import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createRitualRun,
  createRitualRunReceipt,
  reduceRitualRun,
} from "@village/contracts";
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

const learningProposal = {
  status: "proposal" as const,
  proposalId: "rlp_01J00000000000000000000000",
  ritualId: approved.ritualId,
  fromRevision: 1,
  receiptId: receipt.receiptId,
  ownerFeedback: "Put existing customers first in the next result.",
  stewardMessage: "I’ve proposed one focused improvement for Review.",
  rationale: "This reflects the priority rule in your feedback.",
  proposedDefinition: {
    name: approved.name,
    purpose: "Prioritize existing customers in my pipeline review.",
    trigger: approved.trigger,
    steps: approved.steps,
    permissions: approved.permissions,
    completion: "A prioritized reviewable result is ready.",
    reviewPolicy: approved.reviewPolicy,
  },
};

let waitingRun = createRitualRun({
  approved,
  request: {
    schemaVersion: 1,
    ritualId: approved.ritualId,
    ritualRevision: approved.ritualRevision,
  },
  runId: "rrn_01J00000000000000000000001",
  createdAt: "2026-08-16T12:00:00.000Z",
});
waitingRun = reduceRitualRun(waitingRun, approved, {
  type: "START",
  occurredAt: "2026-08-16T12:00:01.000Z",
});
let completedRun = reduceRitualRun(waitingRun, approved, {
  type: "APPROVE_STEP",
  stepKey: "prepare-review",
  occurredAt: "2026-08-16T12:00:02.000Z",
});
completedRun = reduceRitualRun(completedRun, approved, {
  type: "COMPLETE_STEP",
  stepKey: "prepare-review",
  occurredAt: "2026-08-16T12:00:03.000Z",
});
completedRun = reduceRitualRun(completedRun, approved, {
  type: "COMPLETE_RUN",
  outcome: "NEEDS_REVIEW",
  occurredAt: "2026-08-16T12:00:04.000Z",
});
const runReceipt = createRitualRunReceipt({
  approved,
  run: completedRun,
  receiptId: "rcp_01J00000000000000000000001",
  summary: "The fixture completed the approved orchestration step.",
  recordedAt: "2026-08-16T12:00:04.000Z",
});
const canceledRun = reduceRitualRun(waitingRun, approved, {
  type: "CANCEL",
  occurredAt: "2026-08-16T12:00:05.000Z",
});
const researchApproved = {
  ...approved,
  steps: [{ ...approved.steps[0]!, approval: "NONE" as const }],
  research: {
    provider: "EXA" as const,
    query: "important AI agent announcements",
    maxResults: 3,
    lookbackDays: 30,
  },
};
let researchWaitingRun = createRitualRun({
  approved: researchApproved,
  request: {
    schemaVersion: 1,
    ritualId: researchApproved.ritualId,
    ritualRevision: researchApproved.ritualRevision,
  },
  runId: "rrn_01J00000000000000000000002",
  createdAt: "2026-08-16T13:00:00.000Z",
});
researchWaitingRun = reduceRitualRun(researchWaitingRun, researchApproved, {
  type: "START",
  occurredAt: "2026-08-16T13:00:01.000Z",
});
researchWaitingRun = reduceRitualRun(researchWaitingRun, researchApproved, {
  type: "WAIT_FOR_RESOURCE",
  reason: "AUTHENTICATION_REQUIRED",
  occurredAt: "2026-08-16T13:00:02.000Z",
});
let researchCompletedRun = reduceRitualRun(
  researchWaitingRun,
  researchApproved,
  { type: "RETRY_RESOURCE", occurredAt: "2026-08-16T13:00:03.000Z" },
);
researchCompletedRun = reduceRitualRun(researchCompletedRun, researchApproved, {
  type: "COMPLETE_STEP",
  stepKey: "prepare-review",
  research: {
    provider: "EXA",
    requestId: "exa-run-2",
    sources: [
      {
        title: "Agent announcement",
        url: "https://example.com/announcement",
        publishedAt: "2026-08-15T00:00:00.000Z",
        author: "Example author",
        highlights: ["A bounded untrusted excerpt."],
        taint: "UNTRUSTED_WEB",
      },
    ],
  },
  occurredAt: "2026-08-16T13:00:04.000Z",
});
researchCompletedRun = reduceRitualRun(researchCompletedRun, researchApproved, {
  type: "COMPLETE_RUN",
  outcome: "NEEDS_REVIEW",
  occurredAt: "2026-08-16T13:00:05.000Z",
});
const researchRunReceipt = createRitualRunReceipt({
  approved: researchApproved,
  run: researchCompletedRun,
  receiptId: "rcp_01J00000000000000000000002",
  summary: "The local Run completed with bounded Exa evidence.",
  recordedAt: "2026-08-16T13:00:05.000Z",
});
const researchCanceledRun = reduceRitualRun(
  researchWaitingRun,
  researchApproved,
  { type: "CANCEL", occurredAt: "2026-08-16T13:00:06.000Z" },
);

function bridge() {
  return {
    getExaCredentialStatus: vi.fn(async () => ({
      provider: "EXA" as const,
      state: "CONFIGURATION_REQUIRED" as const,
    })),
    configureExaApiKey: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "EXA" as const,
        state: "CONFIGURED" as const,
        version: 1,
      },
    })),
    removeExaApiKey: vi.fn(async () => ({
      status: "snapshot" as const,
      snapshot: {
        provider: "EXA" as const,
        state: "CONFIGURATION_REQUIRED" as const,
      },
    })),
    openExaDashboard: vi.fn(async () => undefined),
    initialize: vi.fn(async () => ({
      identity,
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
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
    startRun: vi.fn(async () => ({ status: "run" as const, run: waitingRun })),
    approveRunStep: vi.fn(async () => ({
      status: "receipt" as const,
      run: completedRun,
      receipt: runReceipt,
    })),
    cancelRun: vi.fn(async () => ({
      status: "run" as const,
      run: waitingRun,
    })),
    proposeLearning: vi.fn(async () => learningProposal),
    approveLearning: vi.fn(async () => ({
      ...approved,
      ritualRevision: 2,
      learningProposalId: learningProposal.proposalId,
      basedOnReceiptId: receipt.receiptId,
      purpose: learningProposal.proposedDefinition.purpose,
      completion: learningProposal.proposedDefinition.completion,
    })),
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
      run: null,
      runReceipt: null,
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

  it("runs the durable Ritual through an explicit owner gate and Receipt", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
      run: null,
      runReceipt: null,
    });
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Ritual approved");

    fireEvent.click(screen.getByRole("button", { name: "Run Ritual" }));
    await screen.findByText("Owner approval required");
    expect(activeBridge.startRun).toHaveBeenCalledWith({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve step" }));
    await screen.findByText("Run Receipt");
    expect(activeBridge.approveRunStep).toHaveBeenCalledWith({
      schemaVersion: 1,
      runId: waitingRun.runId,
      stepKey: "prepare-review",
    });
    expect(screen.getByText(runReceipt.summary)).toBeTruthy();
    expect(screen.getByText(/orchestration only/u)).toBeTruthy();
  });

  it("restores an Exa wait, retries the exact Run, and shows bounded sources", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved: researchApproved,
      receipt: null,
      run: researchWaitingRun,
      runReceipt: null,
    });
    activeBridge.startRun.mockResolvedValueOnce({
      status: "receipt",
      run: researchCompletedRun,
      receipt: researchRunReceipt,
    });

    render(<RitualBuilderWorkspace bridge={activeBridge} />);

    await screen.findByText("Exa research is waiting");
    expect(screen.getByText(/Add or replace the Exa key/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry research" }));
    await screen.findByText("Run Receipt");
    expect(activeBridge.startRun).toHaveBeenCalledWith({
      schemaVersion: 1,
      ritualId: researchApproved.ritualId,
      ritualRevision: researchApproved.ritualRevision,
    });
    expect(screen.getByText("Agent announcement")).toBeTruthy();
    expect(screen.getByText("A bounded untrusted excerpt.")).toBeTruthy();
    expect(screen.getByText("https://example.com/announcement")).toBeTruthy();
    expect(
      screen.getByText("No external mutations; public-web search only"),
    ).toBeTruthy();
  });

  it("keeps cancellation available during a deferred research retry and ignores its late result", async () => {
    let resolveRetry!: (value: {
      status: "receipt";
      run: typeof researchCompletedRun;
      receipt: typeof researchRunReceipt;
    }) => void;
    const retry = new Promise<{
      status: "receipt";
      run: typeof researchCompletedRun;
      receipt: typeof researchRunReceipt;
    }>((resolve) => {
      resolveRetry = resolve;
    });
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved: researchApproved,
      receipt: null,
      run: researchWaitingRun,
      runReceipt: null,
    });
    activeBridge.startRun.mockImplementationOnce(() => retry);
    activeBridge.cancelRun.mockResolvedValueOnce({
      status: "run",
      run: researchCanceledRun,
    });

    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Exa research is waiting");
    fireEvent.click(screen.getByRole("button", { name: "Retry research" }));
    await screen.findByText("Run in progress");

    fireEvent.click(screen.getByRole("button", { name: "Cancel Run" }));
    await screen.findByText("Run canceled");
    expect(activeBridge.cancelRun).toHaveBeenCalledWith({
      schemaVersion: 1,
      runId: researchWaitingRun.runId,
    });

    resolveRetry({
      status: "receipt",
      run: researchCompletedRun,
      receipt: researchRunReceipt,
    });
    await act(async () => Promise.resolve());
    expect(screen.getByText("Run canceled")).toBeTruthy();
    expect(screen.queryByText("Run Receipt")).toBeNull();
  });

  it("releases the Run guard after start, approval, and cancellation failures", async () => {
    const startBridge = bridge();
    startBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
      run: null,
      runReceipt: null,
    });
    startBridge.startRun
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: "run", run: waitingRun });
    const startView = render(<RitualBuilderWorkspace bridge={startBridge} />);
    await screen.findByText("Ritual approved");
    fireEvent.click(screen.getByRole("button", { name: "Run Ritual" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "may already exist",
    );
    fireEvent.click(screen.getByRole("button", { name: "Run Ritual" }));
    await screen.findByText("Owner approval required");
    expect(startBridge.startRun).toHaveBeenCalledTimes(2);
    startView.unmount();

    const approvalBridge = bridge();
    approvalBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
      run: waitingRun,
      runReceipt: null,
    });
    approvalBridge.approveRunStep
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        status: "receipt",
        run: completedRun,
        receipt: runReceipt,
      });
    const approvalView = render(
      <RitualBuilderWorkspace bridge={approvalBridge} />,
    );
    await screen.findByText("Owner approval required");
    fireEvent.click(screen.getByRole("button", { name: "Approve step" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "did not advance",
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve step" }));
    await screen.findByText("Run Receipt");
    expect(approvalBridge.approveRunStep).toHaveBeenCalledTimes(2);
    approvalView.unmount();

    const cancelBridge = bridge();
    cancelBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
      run: waitingRun,
      runReceipt: null,
    });
    cancelBridge.cancelRun
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: "run", run: canceledRun });
    render(<RitualBuilderWorkspace bridge={cancelBridge} />);
    await screen.findByText("Owner approval required");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Run" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not confirm cancellation",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel Run" }));
    await screen.findByText("Run canceled");
    expect(cancelBridge.cancelRun).toHaveBeenCalledTimes(2);
  });

  it("coalesces rapid duplicate submits into one paid Test Run", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt: null,
      run: null,
      runReceipt: null,
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
      run: null,
      runReceipt: null,
    });

    render(<RitualBuilderWorkspace bridge={activeBridge} />);

    await screen.findByText("Test Receipt");
    expect(screen.getByText(receipt.summary)).toBeTruthy();
    expect(screen.getByText("No external effects")).toBeTruthy();
    expect(activeBridge.testRun).not.toHaveBeenCalled();
  });

  it("turns Receipt feedback into an explicit revision approval", async () => {
    const activeBridge = bridge();
    activeBridge.initialize.mockResolvedValueOnce({
      identity,
      approved,
      receipt,
      run: null,
      runReceipt: null,
    });
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Test Receipt");

    fireEvent.click(screen.getByRole("button", { name: "Give feedback" }));
    fireEvent.change(
      screen.getByLabelText("What should the Steward keep or change?"),
      { target: { value: learningProposal.ownerFeedback } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Propose an improvement" }),
    );

    await screen.findByText("Review revision 2");
    expect(activeBridge.proposeLearning).toHaveBeenCalledWith({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: 1,
      receiptId: receipt.receiptId,
      feedback: learningProposal.ownerFeedback,
    });
    expect(
      screen.getByLabelText("Current and proposed Ritual comparison"),
    ).toBeTruthy();
    expect(screen.getByText("No change yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Approve revision 2" }));
    await screen.findByText("Ritual approved");
    expect(activeBridge.approveLearning).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: learningProposal.proposalId,
        ritualId: approved.ritualId,
        expectedFromRevision: 1,
      }),
    );
    expect(screen.getByText("Approved · Revision 2")).toBeTruthy();
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

  it("sends the curated 30-day starter through the strict Steward boundary", async () => {
    const activeBridge = bridge();
    render(<RitualBuilderWorkspace bridge={activeBridge} />);
    await screen.findByText("Shape a Ritual with your Steward");

    fireEvent.click(
      screen.getByRole("button", { name: /30-day signal brief/u }),
    );
    fireEvent.change(screen.getByLabelText("What topic should I track?"), {
      target: { value: "AI coding agents" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Shape the 30-day brief" }),
    );

    await waitFor(() => expect(activeBridge.draft).toHaveBeenCalledOnce());
    expect(activeBridge.draft).toHaveBeenCalledWith({
      schemaVersion: 1,
      draftId: identity.draftId,
      requestRevision: 1,
      ownerPurpose:
        "Prepare a grounded brief on the most important public-web developments about AI coding agents from the last 30 days.",
      starter: { kind: "LAST_30_DAYS", topic: "AI coding agents" },
    });
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
      run: null,
      runReceipt: null,
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
      run: null,
      runReceipt: null,
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
