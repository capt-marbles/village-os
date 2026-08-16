import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObserverBrowserCard } from "../ObserverBrowserCard.js";
import { unavailableObserverSnapshot } from "../observer-client.js";

describe("observer presentation", () => {
  it("presents the owned fixture workflow without exposing its protocol name", () => {
    const html = renderToStaticMarkup(
      <ObserverBrowserCard
        snapshot={{
          ...unavailableObserverSnapshot("2026-08-15T21:00:00.000Z"),
          workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
          workflowVersion: 1,
        }}
      />,
    );

    expect(html).toContain("Owned fixture setup");
    expect(html).not.toContain("OWNED_FIXTURE_ACCOUNT_SETUP_V1");
  });
});
