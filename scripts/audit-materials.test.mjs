import assert from "node:assert/strict";
import test from "node:test";
import { findUnknownAssets } from "./audit-assets.mjs";
import { hasUnknownLicense } from "./audit-licenses.mjs";

test("flags unknown dependency license material", () => {
  assert.equal(hasUnknownLicense('{"license":"MIT"}'), false);
  assert.equal(hasUnknownLicense('{"license":"UNKNOWN"}'), true);
  assert.equal(
    hasUnknownLicense('{"license":"SEE LICENSE IN LICENSE.txt"}'),
    true,
  );
});

test("flags assets missing from the provenance registry", () => {
  assert.deepEqual(
    findUnknownAssets(
      ["apps/web/logo.svg", "apps/web/owned.svg"],
      ["apps/web/owned.svg"],
    ),
    ["apps/web/logo.svg"],
  );
});
