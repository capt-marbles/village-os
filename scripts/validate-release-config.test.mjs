import assert from "node:assert/strict";
import test from "node:test";
import {
  validateReleaseEnvironment,
  validateReleaseFiles,
} from "./validate-release-config.mjs";

test("release credentials require signing, notarization and a pinned signer", () => {
  assert.deepEqual(validateReleaseEnvironment({}), [
    "Developer ID signing requires CSC_LINK or CSC_NAME",
    "Apple notarization credentials are required",
    "VILLAGE_RELEASE_SIGNER_SHA256 must pin the release certificate",
  ]);
  assert.deepEqual(
    validateReleaseEnvironment({
      CSC_NAME: "Developer ID Application: Village",
      APPLE_API_KEY: "/private/key.p8",
      APPLE_API_KEY_ID: "KEYID",
      APPLE_API_ISSUER: "ISSUER",
      VILLAGE_RELEASE_SIGNER_SHA256: "a".repeat(64),
    }),
    [],
  );
});

test("static release config requires Electron 43, hardened fuses and a separate local package path", () => {
  const releaseConfig = `
electronVersion: 43.2.0
runAsNode: false
enableCookieEncryption: true
enableNodeOptionsEnvironmentVariable: false
enableNodeCliInspectArguments: false
enableEmbeddedAsarIntegrityValidation: true
onlyLoadAppFromAsar: true
grantFileProtocolExtraPrivileges: false
notarize: true
url: https://updates.village.run/desktop/alpha
channel: alpha
`;
  const e2eConfig = `
extends: ./electron-builder.yml
publish: null
identity: "-"
notarize: false
`;
  assert.deepEqual(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig,
      e2eConfig,
    }),
    [],
  );
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "42.0.0" } },
      releaseConfig,
      e2eConfig,
    }).includes("Electron major 43 is required"),
  );
});
