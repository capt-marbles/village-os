import { deriveObserverCancellationModel } from "@village/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ObserverBrowserCard } from "../ObserverBrowserCard.js";
import { unavailableObserverSnapshot } from "../observer-client.js";

const snapshot = {
  ...unavailableObserverSnapshot("2026-08-13T03:00:00.000Z"),
  pairing: "PAIRED" as const,
  jobState: "RUNNING_AGENT" as const,
  controller: "AGENT" as const,
  connection: "ONLINE" as const,
  logicalStep: "SELECT_ROLE" as const,
  actionPhase: "DISPATCHED" as const,
  lastEffectActor: "AGENT" as const,
  automationFenced: false,
};

describe("observer browser status", () => {
  it("renders sanitized logical progress without browser control or hostile markup", () => {
    const html = renderToStaticMarkup(
      <ObserverBrowserCard snapshot={snapshot} onIntent={() => undefined} />,
    );
    expect(html).toContain("select role");
    expect(html).toContain("dispatched");
    expect(html).toContain("AGENT");
    expect(html).toContain("Browser stays on your paired desktop");
    expect(html).not.toContain("Take control");
    expect(html).toContain("Notify this Mac");
    for (const prohibited of [
      "<script>alert(1)</script>",
      "https://evil.test/?token=x",
      "#password",
      "sid=secret",
      "data:image/png",
      "Andrew's private value",
    ])
      expect(html).not.toContain(prohibited);
  });

  it.each([
    ["READY", false, false],
    ["SUBMITTING", true, false],
    ["DURABLY_ACCEPTED", true, false],
    ["PENDING_DESKTOP_SYNC", true, false],
    ["AUTOMATION_FENCED", true, false],
    ["ALREADY_TERMINAL", true, false],
    ["FAILED", false, true],
  ] as const)("models cancellation state %s", (state, disabled, retry) => {
    expect(deriveObserverCancellationModel(state)).toMatchObject({
      disabled,
      retry,
    });
  });

  it("shows truthful offline pending and durable acknowledgement copy", () => {
    const html = renderToStaticMarkup(
      <ObserverBrowserCard
        snapshot={{
          ...snapshot,
          jobState: "CANCELED",
          connection: "OFFLINE",
          terminalEvidence: "CANCELLED",
          cancellationAcknowledgedAt: "2026-08-13T03:01:00.000Z",
          automationFenced: false,
        }}
      />,
    );
    expect(html).toContain("desktop offline");
    expect(html).toContain("Durably acknowledged");
    expect(html).toContain("disabled");
  });

  it("renders the durable OWNER actor without inferring it from controller", () => {
    const html = renderToStaticMarkup(
      <ObserverBrowserCard
        snapshot={{
          ...snapshot,
          controller: "AGENT",
          lastEffectActor: "OWNER",
        }}
      />,
    );
    expect(html).toContain("<dt>Last effect</dt><dd>OWNER</dd>");
    expect(html).toContain("<dt>Controller</dt><dd>agent</dd>");
  });
});
