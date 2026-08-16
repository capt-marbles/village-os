import assert from "node:assert/strict";
import test from "node:test";

import { productionDeploymentCommands } from "./deploy-production-control-plane.mjs";

test("production deployment builds the shell before migrations and deployment", () => {
  assert.deepEqual(productionDeploymentCommands({ confirmed: true }), [
    ["pnpm", "--filter", "@village/web...", "build"],
    [
      "pnpm",
      "--dir",
      "apps/control-plane",
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "VILLAGE_DB",
      "--remote",
      "--config",
      "wrangler.production.generated.jsonc",
    ],
    [
      "pnpm",
      "--dir",
      "apps/control-plane",
      "exec",
      "wrangler",
      "deploy",
      "--config",
      "wrangler.production.generated.jsonc",
    ],
  ]);
});

test("production deployment requires confirmation while dry run stays read-only", () => {
  assert.throws(
    () => productionDeploymentCommands({ confirmed: false }),
    /VILLAGE_PRODUCTION_DEPLOYMENT_CONFIRMATION_REQUIRED/,
  );
  assert.deepEqual(productionDeploymentCommands({ dryRun: true }), [
    ["pnpm", "--filter", "@village/web...", "build"],
    [
      "pnpm",
      "--dir",
      "apps/control-plane",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--config",
      "wrangler.production.generated.jsonc",
    ],
  ]);
});
