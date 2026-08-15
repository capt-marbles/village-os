// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RitualBuilder } from "../RitualBuilder.js";
import {
  createRitualBuilderState,
  reduceRitualBuilder,
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
  return <RitualBuilder identity={identity} state={state} onEvent={dispatch} />;
}

describe("Ritual Builder", () => {
  it("presents the Steward conversation and Ritual draft as one labelled workspace", () => {
    const html = renderToStaticMarkup(
      <RitualBuilder
        identity={identity}
        state={createRitualBuilderState()}
        onEvent={vi.fn()}
      />,
    );
    expect(html).toContain("Shape a Ritual with your Steward");
    expect(html).toContain("Ritual draft");
    expect(html).toContain('aria-label="Conversation with Steward"');
    expect(html).toContain('aria-label="Ritual draft side pane"');
    expect(html).toContain("What regular work should I take care of?");
  });

  it("shows graphical trigger choices and the exact draft revision for approval", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId: identity.draftId,
      purpose: "Review my pipeline and prepare next actions.",
      occurredAt: "2026-08-15T16:00:00.000Z",
    });
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
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      draftId: identity.draftId,
      purpose: "Review my pipeline and prepare next actions.",
      occurredAt: "2026-08-15T16:00:00.000Z",
    });
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
