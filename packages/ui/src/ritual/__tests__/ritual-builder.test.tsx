// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RitualBuilder } from "../RitualBuilder.js";
import {
  createRitualBuilderState,
  reduceRitualBuilder,
  type RitualBuilderEvent,
  type RitualBuilderState,
} from "../ritual-builder-state.js";

const identity = {
  draftId: "rtd_01J00000000000000000000000",
  ritualId: "rtl_01J00000000000000000000000",
} as const;

afterEach(cleanup);

function Harness() {
  const [state, dispatch] = useReducer(
    reduceRitualBuilder,
    undefined,
    createRitualBuilderState,
  );
  const onEvent = (event: RitualBuilderEvent) => {
    dispatch(event);
    if (event.type === "SUBMIT_PURPOSE") {
      dispatch(stewardProposal(event.purpose));
    }
  };
  return <RitualBuilder identity={identity} state={state} onEvent={onEvent} />;
}

function stewardProposal(purpose: string): RitualBuilderEvent {
  return {
    type: "STEWARD_PROPOSED",
    occurredAt: "2026-08-15T16:00:10.000Z",
    proposal: {
      status: "proposal",
      draftId: identity.draftId,
      requestRevision: 1,
      stewardMessage: "I shaped a focused draft. When should it begin?",
      name: "Pipeline review",
      purpose,
      steps: [
        {
          stepKey: "prepare-review",
          title: "Prepare the review",
          description: "Gather the bounded information needed for the review.",
          actor: { kind: "STEWARD", role: "Steward" },
          approval: "OWNER_REQUIRED",
        },
      ],
      permissions: ["Read only the sources connected to this Ritual"],
      completion: "A reviewable result is ready.",
    },
  };
}

function draftedState(purpose: string): RitualBuilderState {
  const drafting = reduceRitualBuilder(createRitualBuilderState(), {
    type: "SUBMIT_PURPOSE",
    draftId: identity.draftId,
    purpose,
  });
  return reduceRitualBuilder(drafting, stewardProposal(purpose));
}

describe("Ritual Builder", () => {
  it("presents the Steward conversation and Ritual draft as one labelled workspace", () => {
    render(
      <RitualBuilder
        identity={identity}
        state={createRitualBuilderState()}
        onEvent={vi.fn()}
        stewardDesk={<div>Steward inbox</div>}
      />,
    );
    expect(screen.getByText("Your Steward")).toBeTruthy();
    expect(screen.getByText("What should we make repeatable?")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Conversation with Steward" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/What regular work should I take care of\?/u),
    ).toBeTruthy();
    expect(
      screen
        .getByText("Steward inbox")
        .closest("aside")
        ?.getAttribute("aria-label"),
    ).toBe("Ritual agreement and activity");
  });

  it("offers a bounded 30-day signal starter without hiding the source limits", () => {
    const onEvent = vi.fn();
    render(
      <RitualBuilder
        identity={identity}
        state={createRitualBuilderState()}
        onEvent={onEvent}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /30-day signal brief/u }),
    );
    fireEvent.change(screen.getByLabelText("What topic should I track?"), {
      target: { value: "AI coding agents" },
    });
    expect(
      screen.getByText(/does not yet rank Reddit, X, or YouTube/u),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Shape the 30-day brief" }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: "SUBMIT_STARTER",
      draftId: identity.draftId,
      starter: { kind: "LAST_30_DAYS", topic: "AI coding agents" },
    });
  });

  it("shows graphical trigger choices and the exact draft revision for approval", () => {
    let state = draftedState("Review my pipeline and prepare next actions.");
    const triggerHtml = renderToStaticMarkup(
      <RitualBuilder identity={identity} state={state} onEvent={vi.fn()} />,
    );
    expect(triggerHtml).toContain("Weekdays");
    expect(triggerHtml).toContain("When new work arrives");

    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "WEEKDAYS",
      timeZone: "America/Chicago",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    const html = renderToStaticMarkup(
      <RitualBuilder identity={identity} state={state} onEvent={vi.fn()} />,
    );
    expect(html).toContain("Revision 3");
    expect(html).toContain("Approve Ritual");
    expect(html).toContain("No Run starts until you ask");
    expect(html).toContain("Read only the sources connected to this Ritual");
    expect(html).toContain("Review every Run");
  });

  it("keeps editable fields labelled and explains governed learning", () => {
    const state = draftedState("Review my pipeline and prepare next actions.");
    const html = renderToStaticMarkup(
      <RitualBuilder identity={identity} state={state} onEvent={vi.fn()} />,
    );
    expect(html).toContain('for="ritual-name"');
    expect(html).toContain('for="ritual-purpose"');
    expect(html).toContain("Suggest improvements after Review");
    expect(html).toContain("Changes always require your approval");
    expect(html).not.toContain("autonomously rewrite");
  });

  it("keeps displayed edits aligned with the exact approved revision", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("What should become repeatable?"), {
      target: { value: "Prepare a weekday pipeline review." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start the draft" }));
    fireEvent.click(screen.getByRole("button", { name: /Weekdays/u }));
    fireEvent.click(screen.getByRole("button", { name: /Review every Run/u }));

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "" } });
    fireEvent.blur(name);
    expect(screen.getByRole("alert").textContent).toContain("cannot be empty");
    expect(
      screen.getByRole("button", { name: "Approve Ritual" }),
    ).toHaveProperty("disabled", true);

    fireEvent.change(name, { target: { value: "Weekday pipeline briefing" } });
    fireEvent.blur(name);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve Ritual" }));

    expect(screen.getByRole("status").textContent).toContain(
      "No Run has started",
    );
    expect(
      screen.getByDisplayValue("Weekday pipeline briefing"),
    ).toHaveProperty("disabled", true);
  });
});
