import type { SetupFixtureVariant } from "./variants.js";
import { desiredProfileSpec } from "./setup.js";

export interface SanitizedProfileSnapshot {
  readonly presentFields: readonly (
    "DISPLAY_NAME" | "ROLE" | "PREFERRED_FOCUS"
  )[];
  readonly finalized: boolean;
}

export interface OwnedFixtureAccountView {
  readonly variant: SetupFixtureVariant;
  readonly profile: SanitizedProfileSnapshot;
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

const contentSecurityPolicy = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

/** Local-only HTML. Values render in the dedicated fixture session and nowhere else. */
export function renderOwnedFixtureAccount(
  view: OwnedFixtureAccountView,
): string {
  const variant = view.variant;
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
        <label>Display name <input data-field="DISPLAY_NAME" value="${escapeHtml(desiredProfileSpec.displayName)}"></label>
        <label>Role <select data-field="ROLE">${optionList(desiredProfileSpec.roleOptions, desiredProfileSpec.role)}</select></label>
        <label>Preferred focus <select data-field="PREFERRED_FOCUS">${optionList(desiredProfileSpec.focusOptions, desiredProfileSpec.preferredFocus)}</select></label>
      </section>
      <output data-present-field-count="${view.profile.presentFields.length}" data-finalized="${String(view.profile.finalized)}"></output>
      <nav aria-label="Bounded semantic actions">${actions}</nav>
    </main>
  </body>
</html>`;
}
