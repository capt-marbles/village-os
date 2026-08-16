import assert from "node:assert/strict";
import test from "node:test";

test("the local owner ceremony can target one isolated remote proof", async () => {
  process.env.VILLAGE_DEV_CONTROL_PLANE_URL =
    "https://village-continuity-proof.example.workers.dev";
  process.env.VILLAGE_DEV_PRINCIPAL_ID = "prn_01J00000000000000000000008";
  process.env.VILLAGE_DEV_CSRF = "csrf-owner-ceremony-proof-token-00000008";
  const { default: config } = await import(
    `../apps/web/vite.config.ts?owner-ceremony=${Date.now()}`
  );

  assert.equal(
    config.server.proxy["/api"].target,
    process.env.VILLAGE_DEV_CONTROL_PLANE_URL,
  );
  assert.equal(config.server.proxy["/api"].changeOrigin, true);
  assert.equal(
    config.server.proxy["/api"].headers["x-village-development-principal"],
    process.env.VILLAGE_DEV_PRINCIPAL_ID,
  );
  assert.equal(
    config.server.proxy["/api"].headers.cookie,
    `village_csrf=${process.env.VILLAGE_DEV_CSRF}`,
  );
  assert.match(
    config.server.headers["set-cookie"],
    new RegExp(`^village_csrf=${process.env.VILLAGE_DEV_CSRF};`),
  );
});
