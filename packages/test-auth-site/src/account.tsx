import type { SetupFixtureVariant } from "./variants.js";
import { desiredProfileSpec, mutationCapabilityForStep } from "./setup.js";

export interface SanitizedProfileSnapshot {
  readonly presentFields: readonly (
    "DISPLAY_NAME" | "ROLE" | "PREFERRED_FOCUS"
  )[];
  readonly finalized: boolean;
}

export interface OwnedFixtureAccountView {
  readonly variant: SetupFixtureVariant;
  readonly profile: SanitizedProfileSnapshot;
  readonly localValues?: {
    readonly displayName?: string;
    readonly role?: string;
    readonly preferredFocus?: string;
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function optionList(values: readonly string[], selected: string): string {
  return values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`,
    )
    .join("");
}

export const contentSecurityPolicy = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'nonce-village-fixture-v1'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

const stepForCapability = Object.freeze(
  Object.fromEntries(
    Object.entries(mutationCapabilityForStep).map(
      ([logicalStep, capability]) => [capability, logicalStep],
    ),
  ),
);

/** Local-only HTML. Values render in the dedicated fixture session and nowhere else. */
export function renderOwnedFixtureAccount(
  view: OwnedFixtureAccountView,
): string {
  const variant = view.variant;
  const localValues = view.localValues ?? {};
  const gated = variant.humanGate !== "NONE";
  const actions = gated
    ? ""
    : variant.choiceOrder
        .map(
          (capability) =>
            `<button type="button" data-action="${capability}">${capability === "SELECT_ROLE" ? "Apply matching role" : "Check current setup"}</button>`,
        )
        .join("");
  const hostileNavigation = variant.hostileNavigation
    ? `<a href="${escapeHtml(variant.hostileNavigation)}">Untrusted external navigation</a>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
    <title>Village owned setup fixture</title>
  </head>
  <body>
    <main data-workflow="OWNED_FIXTURE_ACCOUNT_SETUP_V1" data-version="1" data-variant="${escapeHtml(variant.id)}" data-layout="${variant.layout}" data-human-gate="${variant.humanGate}">
      <p data-page-authored="true">${escapeHtml(variant.hostileText)}</p>
      ${hostileNavigation}
      <section aria-label="Local setup fields">
        <label>Display name <input data-field="DISPLAY_NAME" value="${escapeHtml(localValues.displayName ?? "")}"></label>
        <label>Role <select data-field="ROLE"><option value="">Choose a role</option>${optionList(desiredProfileSpec.roleOptions, localValues.role ?? "")}</select></label>
        <label>Preferred focus <select data-field="PREFERRED_FOCUS"><option value="">Choose a focus</option>${optionList(desiredProfileSpec.focusOptions, localValues.preferredFocus ?? "")}</select></label>
      </section>
      <output data-present-field-count="${view.profile.presentFields.length}" data-finalized="${String(view.profile.finalized)}"></output>
      <nav aria-label="Bounded semantic actions">${actions}</nav>
    </main>
    <script nonce="village-fixture-v1">
      (() => {
        const stepFor = Object.freeze(${JSON.stringify(stepForCapability)});
        const parameters = new URL(location.href).searchParams;
        const effectId = parameters.get("effectId");
        const logicalStep = parameters.get("logicalStep");
        const json = async (path, options) => {
          const response = await fetch(path, options);
          const body = await response.json();
          if (!response.ok) throw new Error(body.code || "FIXTURE_REQUEST_FAILED");
          return body;
        };
        globalThis.__villageOwnedFixture = Object.freeze({
          observe: () => json("/api/observe?logicalStep=" + encodeURIComponent(logicalStep) + "&effectId=" + encodeURIComponent(effectId)),
          perform: (capability) => {
            if (stepFor[capability] !== logicalStep) throw new Error("FIXTURE_ACTION_DENIED");
            return json("/api/action", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ logicalStep, effectId, capability })
            });
          },
          captureOwnerState: () => json("/api/owner-state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              logicalStep,
              effectId,
              displayName: document.querySelector('[data-field="DISPLAY_NAME"]').value,
              role: document.querySelector('[data-field="ROLE"]').value,
              preferredFocus: document.querySelector('[data-field="PREFERRED_FOCUS"]').value
            })
          })
        });
      })();
    </script>
  </body>
</html>`;
}
