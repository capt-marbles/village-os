import assert from "node:assert/strict";
import test from "node:test";
import { auditTelemetrySource } from "./audit-telemetry-egress.mjs";

test("accepts a compile-time bounded primitive diagnostic projection", () => {
  assert.deepEqual(
    auditTelemetrySource(
      `
        export const diagnosticFieldAllowlist = ["component", "code", "retriable"] as const;
        const preview = { component: input.component, code: input.code, retriable: input.retriable };
        const upload = "DISABLED";
      `,
      "crash-reporting.ts",
    ),
    [],
  );
});

test("rejects outbound transports, forbidden page-derived fields and dynamic projections", () => {
  const errors = auditTelemetrySource(
    `
      const preview = { ...input, [input.key]: input.value, pageUrl: input.url };
      fetch("https://telemetry.invalid", { body: JSON.stringify(preview) });
    `,
    "crash-reporting.ts",
  );
  assert.ok(errors.some((error) => error.includes("outbound transport")));
  assert.ok(errors.some((error) => error.includes("page-derived field")));
  assert.ok(errors.some((error) => error.includes("dynamic projection")));
});

test("allows only the fixed Exa research egress contract", () => {
  const file = "apps/desktop/src/research/exa-search-provider.ts";
  assert.deepEqual(
    auditTelemetrySource(
      `
        const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
        const request = globalThis.fetch;
        response = await this.request(EXA_SEARCH_ENDPOINT, {});
      `,
      file,
    ),
    [],
  );
  assert.ok(
    auditTelemetrySource(
      `
        const EXA_SEARCH_ENDPOINT = "https://attacker.invalid";
        const request = globalThis.fetch;
        response = await this.request(EXA_SEARCH_ENDPOINT, {});
      `,
      file,
    ).some((error) => error.includes("fixed Exa egress contract")),
  );
});

test("allows only the updater's policy-gated fetch seam", () => {
  const file = "apps/desktop/src/main/update-runtime.ts";
  assert.deepEqual(
    auditTelemetrySource(
      `
        export function desktopUpdateFetch(input, init) {
          return globalThis.fetch(input, init);
        }
        const manifestResponse = await beginTimedFetch(
          this.dependencies.fetch,
          this.dependencies.policy.endpoint,
          "application/json",
          "MANIFEST_UNAVAILABLE",
        );
        prevalidateManifest(policy, currentVersion, manifest, manifestUrl);
        const artifactResponse = await beginTimedFetch(
          this.dependencies.fetch,
          manifest.artifactUrl,
          "application/zip",
          "ARTIFACT_UNAVAILABLE",
        );
      `,
      file,
    ),
    [],
  );
  assert.ok(
    auditTelemetrySource(
      `export const desktopUpdateFetch = globalThis.fetch;`,
      file,
    ).some((error) => error.includes("policy-gated updater egress contract")),
  );
});
