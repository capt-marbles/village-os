import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RitualBuilderPrototype } from "../src/renderer/RitualBuilderPrototype.js";
import { resolveDesktopRendererMode } from "../src/renderer/renderer-mode.js";

describe("desktop Ritual Builder prototype", () => {
  it("renders the Steward-led builder without requiring a privileged bridge", () => {
    const html = renderToStaticMarkup(<RitualBuilderPrototype />);
    expect(html).toContain("Shape a Ritual with your Steward");
    expect(html).toContain('aria-label="Ritual draft side pane"');
    expect(html).toContain("Start the draft");
    expect(html).not.toContain("village:invoke");
  });

  it("selects the prototype only from its exact local query mode", () => {
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
});
