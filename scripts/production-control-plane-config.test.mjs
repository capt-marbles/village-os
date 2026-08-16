import assert from "node:assert/strict";
import test from "node:test";

import { createProductionControlPlaneConfig } from "./production-control-plane-config.mjs";

const productionEnvironment = {
  VILLAGE_PRODUCTION_WORKER_NAME: "village-andrew",
  VILLAGE_PRODUCTION_ORIGIN: "https://village.example.com",
  VILLAGE_CLOUDFLARE_D1_DATABASE_NAME: "village-production",
  VILLAGE_CLOUDFLARE_D1_DATABASE_ID: "519a568c-d0eb-4793-9e5a-489c01f91b0d",
  CF_ACCESS_TEAM_DOMAIN: "https://andrew.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
};

test("production control plane serves the authenticated web shell and API on one origin", () => {
  const config = createProductionControlPlaneConfig(productionEnvironment);

  assert.equal(config.name, "village-andrew");
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, [
    { pattern: "village.example.com", custom_domain: true },
  ]);
  assert.deepEqual(config.assets, {
    directory: "../web/dist",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  });
  assert.deepEqual(config.vars, {
    VILLAGE_DEPLOYMENT_NAME: "production",
    VILLAGE_AUTH_MODE: "cloudflare-access",
    VILLAGE_ENVIRONMENT: "production",
    VILLAGE_ALLOWED_ORIGINS: "https://village.example.com",
    CF_ACCESS_TEAM_DOMAIN: "https://andrew.cloudflareaccess.com",
    CF_ACCESS_AUD: "a".repeat(64),
  });
  assert.equal(
    config.d1_databases[0].database_id,
    productionEnvironment.VILLAGE_CLOUDFLARE_D1_DATABASE_ID,
  );
});

test("production control plane rejects unsafe or placeholder identity configuration", () => {
  for (const override of [
    { VILLAGE_PRODUCTION_ORIGIN: "http://village.example.com" },
    { VILLAGE_PRODUCTION_ORIGIN: "https://village.example.com/path" },
    { CF_ACCESS_TEAM_DOMAIN: "https://example.com" },
    { CF_ACCESS_AUD: "short" },
    {
      VILLAGE_CLOUDFLARE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
    },
  ]) {
    assert.throws(
      () =>
        createProductionControlPlaneConfig({
          ...productionEnvironment,
          ...override,
        }),
      /VILLAGE_PRODUCTION_CONFIGURATION_INVALID/,
    );
  }
});
