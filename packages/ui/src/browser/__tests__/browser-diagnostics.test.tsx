import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserDiagnostics } from "../BrowserDiagnostics.js";

describe("browser diagnostics", () => {
  it("shows a bounded local-only preview without claiming upload", () => {
    const markup = renderToStaticMarkup(
      <BrowserDiagnostics
        entries={[
          {
            component: "BROWSER_HOST",
            code: "HOST_RESTART_REQUIRED",
            retriable: true,
          },
        ]}
      />,
    );
    expect(markup).toContain("Diagnostics stay on this Mac. Uploads are off.");
    expect(markup).toContain("HOST_RESTART_REQUIRED");
    expect(markup).toContain("retry available");
  });
});
