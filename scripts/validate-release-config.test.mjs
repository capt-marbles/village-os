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
  const releaseConfig = {
    appId: "com.village.desktop",
    productName: "Village",
    electronVersion: "43.2.0",
    extraMetadata: {
      villageUpdateSignerSha256: "${env.VILLAGE_RELEASE_SIGNER_SHA256}",
    },
    electronFuses: {
      resetAdHocDarwinSignature: true,
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    files: [
      "dist/**",
      "!dist/mac*/**",
      "!dist/steward-default/**",
      "!dist/ritual-e2e/**",
      "!dist/e2e/**",
      "!dist/continuity-e2e/**",
      "!dist/credential-e2e/**",
      "!dist/main/browser-host-manager*",
      "!dist/main/desktop-delegated-workflow*",
      "!dist/main/fixture-session-handler*",
      "!dist/main/internal-fixture-provisioner*",
      "!dist/main/lazy-delegated-workflow*",
      "!dist/main/internal-delegated-proof*",
      "!dist/main/internal-continuity-proof-entry*",
      "!dist/main/internal-credential-proof-entry*",
      "!dist/main/internal-profile-protection*",
      "!dist/main/internal-proof-entry*",
      "!dist/main/internal-proof-ids*",
      "!dist/main/owned-fixture-credential-fill*",
      "!dist/browser/owned-fixture-credential-destination*",
      "!dist/main/abrupt-exit-barrier*",
      "!dist/main/internal-paired-bootstrap*",
      "!dist/main/paired-proof-coordination*",
      "!dist/main/proof-projection*",
      "package.json",
    ],
    mac: { hardenedRuntime: true, notarize: true },
    publish: null,
  };
  const e2eConfig = {
    extends: "./electron-builder.yml",
    publish: null,
    extraMetadata: { villageUpdateSignerSha256: null },
    mac: { identity: "-", notarize: false, target: "dir" },
  };
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
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig: { ...releaseConfig, extraMetadata: undefined },
      e2eConfig,
    }).some((error) => error.includes("villageUpdateSignerSha256")),
  );
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig: {
        ...releaseConfig,
        electronFuses: {
          ...releaseConfig.electronFuses,
          runAsNode: true,
        },
      },
      e2eConfig,
    }).some((error) => error.includes("electronFuses.runAsNode")),
  );
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig: {
        ...releaseConfig,
        files: releaseConfig.files.filter(
          (entry) => entry !== "!dist/main/internal-fixture-provisioner*",
        ),
      },
      e2eConfig,
    }).includes(
      "Release config must exclude !dist/main/internal-fixture-provisioner*",
    ),
  );
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig: {
        ...releaseConfig,
        files: releaseConfig.files.filter(
          (entry) => entry !== "!dist/main/lazy-delegated-workflow*",
        ),
      },
      e2eConfig,
    }).includes(
      "Release config must exclude !dist/main/lazy-delegated-workflow*",
    ),
  );
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig: {
        ...releaseConfig,
        files: releaseConfig.files.filter(
          (entry) => entry !== "!dist/main/internal-paired-bootstrap*",
        ),
      },
      e2eConfig,
    }).includes(
      "Release config must exclude !dist/main/internal-paired-bootstrap*",
    ),
  );
  assert.ok(
    validateReleaseFiles({
      desktopPackage: { devDependencies: { electron: "43.2.0" } },
      releaseConfig,
      e2eConfigs: [
        { name: "electron-builder.e2e.yml", config: e2eConfig },
        {
          name: "electron-builder.ritual-e2e.yml",
          config: {
            ...e2eConfig,
            extraMetadata: { villageUpdateSignerSha256: "unexpected-pin" },
          },
        },
      ],
    }).includes(
      "electron-builder.ritual-e2e.yml has invalid extraMetadata.villageUpdateSignerSha256: expected null",
    ),
  );
});
