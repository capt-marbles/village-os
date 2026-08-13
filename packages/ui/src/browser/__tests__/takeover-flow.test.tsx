import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserPane } from "../BrowserPane.js";
import type { BrowserUiSnapshot } from "../browser-ui-state-matrix.js";

const snapshot: BrowserUiSnapshot = {
  surface: "DESKTOP",
  jobState: "WAITING_FOR_USER",
  controller: "NONE",
  connection: "ONLINE",
  takeover: "QUIESCING",
  pairing: "PAIRED",
  verification: "unknown",
  profile: "PRESENT",
  humanGate: "TWO_FACTOR",
  erasure: "IDLE",
  lastUpdatedAt: "2026-08-13T03:00:00.000Z",
};

describe("browser takeover presentation", () => {
  it("announces pending takeover without exposing an enabled control claim", () => {
    const html = renderToStaticMarkup(
      <BrowserPane snapshot={snapshot} collapsed={false} />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Taking control safely");
    expect(html).toContain("Two-factor authentication needs you");
    expect(html).not.toContain("You have control");
  });

  it("preserves an accessible expand control when collapsed", () => {
    const html = renderToStaticMarkup(
      <BrowserPane snapshot={snapshot} collapsed />,
    );
    expect(html).toContain('aria-label="Expand browser pane"');
  });

  it("labels owner confirmation as distinct from automatic verification", () => {
    const html = renderToStaticMarkup(
      <BrowserPane
        snapshot={{ ...snapshot, jobState: "VERIFYING", takeover: "NONE" }}
        collapsed={false}
      />,
    );
    expect(html).toContain("Is this the expected account?");
    expect(html).toContain("owner-confirmed, not automatic verification");
    expect(html).toContain("No, keep status unknown");
  });

  it("renders modeled cancel and forget-session actions", () => {
    const html = renderToStaticMarkup(
      <BrowserPane
        snapshot={{
          ...snapshot,
          jobState: "RUNNING_AGENT",
          controller: "AGENT",
          takeover: "NONE",
          humanGate: null,
        }}
        collapsed={false}
      />,
    );
    expect(html).toContain("Cancel future automation");
    expect(html).toContain("Forget local session");
  });
});
