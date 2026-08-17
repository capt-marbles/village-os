import assert from "node:assert/strict";
import test from "node:test";
import { assertCleanInstallEvidence } from "./verify-clean-install.mjs";

const passingEvidence = {
  status: "PASS",
  installLocation: "TEMPORARY_APPLICATIONS",
  sourceBundleDistinct: true,
  packagedIntegrity: "VALID",
  trustedUi: "VISIBLE",
  terminalState: "RECEIPTED_SUCCESS",
  finalizationEffects: 1,
};

test("accepts a fresh installed bundle that completes the trusted packaged workflow", () => {
  assert.deepEqual(
    assertCleanInstallEvidence(passingEvidence),
    passingEvidence,
  );
});

test("rejects build-directory launches and incomplete installed UI evidence", () => {
  for (const evidence of [
    { ...passingEvidence, sourceBundleDistinct: false },
    { ...passingEvidence, installLocation: "BUILD_DIRECTORY" },
    { ...passingEvidence, trustedUi: "UNKNOWN" },
    { ...passingEvidence, terminalState: "WAITING" },
    { ...passingEvidence, finalizationEffects: 2 },
  ]) {
    assert.throws(
      () => assertCleanInstallEvidence(evidence),
      /PACKAGED_CLEAN_INSTALL_EVIDENCE_INCOMPLETE/,
    );
  }
});
