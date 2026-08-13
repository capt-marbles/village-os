import assert from "node:assert/strict";
import test from "node:test";
import {
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
