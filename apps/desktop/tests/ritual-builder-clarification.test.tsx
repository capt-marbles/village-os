// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  RitualStewardContext,
  RitualStewardResult,
} from "@village/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RitualBuilderWorkspace,
  type RitualBuilderBridge,
} from "../src/renderer/RitualBuilderWorkspace.js";

afterEach(cleanup);

const identity = {
  draftId: "rtd_01J00000000000000000000000",
  ritualId: "rtl_01J00000000000000000000000",
};

const question = {
  status: "question" as const,
  draftId: identity.draftId,
  requestRevision: 1,
  stewardMessage: "One choice will make this Ritual more useful.",
  questionId: "delivery-rhythm",
  prompt: "When should I prepare the review?",
  options: [
    {
      optionId: "on-demand",
      label: "Only when I ask",
      detail: "Keep it manual while it learns.",
    },
    {
      optionId: "weekdays",
      label: "Every weekday",
      detail: "Prepare it each weekday morning.",
    },
  ],
  allowFreeText: true as const,
};

function setup() {
  const draft =
    vi.fn<(context: RitualStewardContext) => Promise<RitualStewardResult>>();
  draft
    .mockResolvedValueOnce(question)
    .mockImplementationOnce(async (request): Promise<RitualStewardResult> => ({
      status: "proposal",
      draftId: request.draftId,
      requestRevision: request.requestRevision,
      stewardMessage: "I shaped the agreement around that rhythm.",
      name: "Priority email review",
      purpose: request.ownerPurpose,
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather the bounded information needed for the review.",
          actor: { kind: "STEWARD", role: "Steward" },
          approval: "OWNER_REQUIRED",
        },
      ],
      permissions: ["Read only connected records"],
      completion: "A reviewable result is ready.",
    }));
  const activeBridge = {
    getExaCredentialStatus: vi.fn(async () => ({
      provider: "EXA" as const,
      state: "CONFIGURATION_REQUIRED" as const,
    })),
    initialize: vi.fn(async () => ({
      identity,
      approved: null,
      receipt: null,
      run: null,
      runReceipt: null,
      schedule: null,
      inbox: [],
    })),
    getAutomationState: vi.fn(async () => ({ schedule: null, inbox: [] })),
    draft,
  } as unknown as RitualBuilderBridge;
  render(<RitualBuilderWorkspace bridge={activeBridge} />);
  return draft;
}

async function beginClarification() {
  await screen.findByText("What should we make repeatable?");
  fireEvent.change(screen.getByLabelText("What should become repeatable?"), {
    target: {
      value: "Review my email and identify the highest priority reply.",
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start the draft" }));
  return screen.findByRole("group", {
    name: "When should I prepare the review?",
  });
}

describe("Ritual Builder clarification", () => {
  it("renders one trusted decision and sends the selected option once", async () => {
    const draft = setup();
    const decision = await beginClarification();
    const answer = within(decision).getByRole("button", {
      name: /Every weekday/u,
    });
    fireEvent.click(answer);
    fireEvent.click(answer);

    await screen.findByText("Priority email review");
    expect(draft).toHaveBeenCalledTimes(2);
    expect(draft.mock.calls[1]?.[0]).toMatchObject({
      requestRevision: 2,
      clarifications: [
        { questionId: "delivery-rhythm", answer: "Every weekday" },
      ],
    });
  });

  it("always lets the owner answer in their own words", async () => {
    const draft = setup();
    await beginClarification();
    fireEvent.change(screen.getByLabelText("Something else"), {
      target: { value: "Every weekday after the morning inbox sync." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this answer" }));

    await screen.findByText("Priority email review");
    expect(draft.mock.calls[1]?.[0]).toMatchObject({
      clarifications: [
        {
          questionId: "delivery-rhythm",
          answer: "Every weekday after the morning inbox sync.",
        },
      ],
    });
  });
});
