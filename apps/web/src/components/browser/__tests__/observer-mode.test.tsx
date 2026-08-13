import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObserverBrowserCard } from "../ObserverBrowserCard.js";

describe("observer browser status", () => {
  it("offers supervision without claiming browser control or pixels", () => {
    const html = renderToStaticMarkup(
      <ObserverBrowserCard
        snapshot={{
          surface: "OBSERVER",
          jobState: "RUNNING_USER",
          controller: "USER",
          connection: "ONLINE",
          takeover: "NONE",
          pairing: "PAIRED",
          verification: "unknown",
          profile: "PRESENT",
          humanGate: "TWO_FACTOR",
          erasure: "IDLE",
          lastUpdatedAt: "2026-08-13T03:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain("Browser stays on your paired desktop");
    expect(html).toContain("Notify desktop");
    expect(html).toContain("Cancel future automation");
    expect(html).not.toContain("Take control");
  });

  it("disables intents when no authenticated transport is available", () => {
    const html = renderToStaticMarkup(
      <ObserverBrowserCard
        snapshot={{
          surface: "OBSERVER",
          jobState: "WAITING_FOR_BROWSER",
          controller: "NONE",
          connection: "ABSENT",
          takeover: "NONE",
          pairing: "UNPAIRED",
          verification: "unknown",
          profile: "ABSENT",
          humanGate: null,
          erasure: "IDLE",
          lastUpdatedAt: "2026-08-13T03:00:00.000Z",
        }}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
