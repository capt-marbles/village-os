import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RitualBuilder } from "../RitualBuilder.js";
import {
  createRitualBuilderState,
  reduceRitualBuilder,
} from "../ritual-builder-state.js";

describe("Ritual Builder", () => {
  it("presents the Steward conversation and Ritual draft as one labelled workspace", () => {
    const html = renderToStaticMarkup(
      <RitualBuilder state={createRitualBuilderState()} onEvent={vi.fn()} />,
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
      purpose: "Review my pipeline and prepare next actions.",
      occurredAt: "2026-08-15T16:00:00.000Z",
    });
    const triggerHtml = renderToStaticMarkup(
      <RitualBuilder state={state} onEvent={vi.fn()} />,
    );
    expect(triggerHtml).toContain("Weekdays");
    expect(triggerHtml).toContain("When new work arrives");

    state = reduceRitualBuilder(state, {
      type: "SELECT_TRIGGER",
      trigger: "WEEKDAYS",
      occurredAt: "2026-08-15T16:01:00.000Z",
    });
    state = reduceRitualBuilder(state, {
      type: "SELECT_REVIEW",
      ownerReview: "EVERY_RUN",
      occurredAt: "2026-08-15T16:02:00.000Z",
    });
    const html = renderToStaticMarkup(
      <RitualBuilder state={state} onEvent={vi.fn()} />,
    );
    expect(html).toContain("Revision 3");
    expect(html).toContain("Approve Ritual");
    expect(html).toContain("No Run starts until you ask");
  });

  it("keeps editable fields labelled and explains governed learning", () => {
    let state = createRitualBuilderState();
    state = reduceRitualBuilder(state, {
      type: "SUBMIT_PURPOSE",
      purpose: "Review my pipeline and prepare next actions.",
      occurredAt: "2026-08-15T16:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      <RitualBuilder state={state} onEvent={vi.fn()} />,
    );
    expect(html).toContain('for="ritual-name"');
    expect(html).toContain('for="ritual-purpose"');
    expect(html).toContain("Suggest improvements after Review");
    expect(html).toContain("Changes always require your approval");
    expect(html).not.toContain("autonomously rewrite");
  });
});
