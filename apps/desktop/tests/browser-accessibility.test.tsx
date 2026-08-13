import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopBrowserPane } from "../src/renderer/DesktopBrowserPane.js";

describe("desktop browser accessibility", () => {
  it("exposes keyboard controls, status announcements, and the native pane label", () => {
    const html = renderToStaticMarkup(
      <DesktopBrowserPane
        initialSnapshot={{
          surface: "DESKTOP",
          jobState: "RUNNING_AGENT",
          controller: "AGENT",
          connection: "ONLINE",
          takeover: "NONE",
          pairing: "PAIRED",
          verification: "unknown",
          profile: "PRESENT",
          humanGate: null,
          erasure: "IDLE",
          lastUpdatedAt: "2026-08-13T03:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-controls="village-browser-surface"');
    expect(html).toContain('type="button"');
    expect(html).toContain("Take control");
    expect(html).toContain('aria-label="Browser pane width"');
    expect(html).toContain('class="desktop-workspace"');
    expect(html).toContain('style="width:58%"');
  });
});
