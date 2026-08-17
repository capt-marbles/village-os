import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseAsarContents,
  assertReleaseSigner,
  parseCertificateFingerprint,
} from "./verify-packaged-mac.mjs";

test("normalizes the packaged certificate SHA-256 fingerprint", () => {
  const pairs = Array.from({ length: 32 }, () => "AB").join(":");
  assert.equal(
    parseCertificateFingerprint(`sha256 Fingerprint=${pairs}\n`),
    "ab".repeat(32),
  );
});

test("requires the packaged signer to match the release pin", () => {
  assert.doesNotThrow(() =>
    assertReleaseSigner("ab".repeat(32), "ab".repeat(32)),
  );
  assert.throws(
    () => assertReleaseSigner("cd".repeat(32), "ab".repeat(32)),
    /PACKAGED_SIGNER_MISMATCH/,
  );
  assert.throws(
    () => assertReleaseSigner("ab".repeat(32), "not-a-fingerprint"),
    /INVALID_RELEASE_SIGNER_PIN/,
  );
});

test("rejects internal proof and fixture automation in the release ASAR", () => {
  assert.doesNotThrow(() =>
    assertReleaseAsarContents([
      "/dist/main/production-entry.js",
      "/dist/main/runtime.js",
    ]),
  );
  for (const prohibited of [
    "/dist/main/browser-host-manager.js",
    "/dist/main/desktop-delegated-workflow.js",
    "/dist/main/fixture-session-handler.js",
    "/dist/main/internal-fixture-provisioner.js",
    "/dist/main/internal-delegated-proof.js",
    "/dist/main/internal-continuity-proof-entry.js",
    "/dist/main/internal-credential-proof-entry.js",
    "/dist/main/internal-proof-entry.js",
    "/dist/main/internal-proof-ids.js",
    "/dist/main/owned-fixture-credential-fill.js",
    "/dist/browser/owned-fixture-credential-destination.js",
    "/dist/main/abrupt-exit-barrier.js",
    "/dist/main/internal-paired-bootstrap.js",
    "/dist/main/lazy-delegated-workflow.js",
    "/dist/main/paired-proof-coordination.js",
    "/dist/main/proof-projection.js",
  ]) {
    assert.throws(
      () =>
        assertReleaseAsarContents([
          "/dist/main/production-entry.js",
          prohibited,
        ]),
      /PACKAGED_RELEASE_CONTAINS_INTERNAL_PROOF/,
    );
  }
});
