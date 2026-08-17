import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { requiredInternalReleaseExclusions } from "./release-internal-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateReleaseEnvironment(environment) {
  const errors = [];
  if (!environment.CSC_LINK && !environment.CSC_NAME) {
    errors.push("Developer ID signing requires CSC_LINK or CSC_NAME");
  }
  const apiCredentials =
    environment.APPLE_API_KEY &&
    environment.APPLE_API_KEY_ID &&
    environment.APPLE_API_ISSUER;
  const accountCredentials =
    environment.APPLE_ID &&
    environment.APPLE_APP_SPECIFIC_PASSWORD &&
    environment.APPLE_TEAM_ID;
  const keychainCredentials =
    environment.APPLE_KEYCHAIN && environment.APPLE_KEYCHAIN_PROFILE;
  if (!apiCredentials && !accountCredentials && !keychainCredentials) {
    errors.push("Apple notarization credentials are required");
  }
  if (!/^[a-f0-9]{64}$/.test(environment.VILLAGE_RELEASE_SIGNER_SHA256 ?? "")) {
    errors.push(
      "VILLAGE_RELEASE_SIGNER_SHA256 must pin the release certificate",
    );
  }
  return errors;
}

export function validateReleaseFiles({
  desktopPackage,
  releaseConfig,
  e2eConfig,
  e2eConfigs = [{ name: "electron-builder.e2e.yml", config: e2eConfig }],
}) {
  const errors = [];
  const electron = desktopPackage.devDependencies?.electron;
  if (typeof electron !== "string" || Number(electron.split(".")[0]) !== 43) {
    errors.push("Electron major 43 is required");
  }
  const expectedRelease = [
    ["appId", releaseConfig.appId, "com.village.desktop"],
    ["productName", releaseConfig.productName, "Village"],
    ["electronVersion", releaseConfig.electronVersion, "43.2.0"],
    [
      "extraMetadata.villageUpdateSignerSha256",
      releaseConfig.extraMetadata?.villageUpdateSignerSha256,
      "${env.VILLAGE_RELEASE_SIGNER_SHA256}",
    ],
    [
      "electronFuses.resetAdHocDarwinSignature",
      releaseConfig.electronFuses?.resetAdHocDarwinSignature,
      true,
    ],
    ["electronFuses.runAsNode", releaseConfig.electronFuses?.runAsNode, false],
    [
      "electronFuses.enableCookieEncryption",
      releaseConfig.electronFuses?.enableCookieEncryption,
      true,
    ],
    [
      "electronFuses.enableNodeOptionsEnvironmentVariable",
      releaseConfig.electronFuses?.enableNodeOptionsEnvironmentVariable,
      false,
    ],
    [
      "electronFuses.enableNodeCliInspectArguments",
      releaseConfig.electronFuses?.enableNodeCliInspectArguments,
      false,
    ],
    [
      "electronFuses.enableEmbeddedAsarIntegrityValidation",
      releaseConfig.electronFuses?.enableEmbeddedAsarIntegrityValidation,
      true,
    ],
    [
      "electronFuses.onlyLoadAppFromAsar",
      releaseConfig.electronFuses?.onlyLoadAppFromAsar,
      true,
    ],
    [
      "electronFuses.grantFileProtocolExtraPrivileges",
      releaseConfig.electronFuses?.grantFileProtocolExtraPrivileges,
      false,
    ],
    ["mac.hardenedRuntime", releaseConfig.mac?.hardenedRuntime, true],
    ["mac.notarize", releaseConfig.mac?.notarize, true],
    ["publish", releaseConfig.publish, null],
  ];
  for (const [field, actual, expected] of expectedRelease) {
    if (actual !== expected)
      errors.push(`Release config has invalid ${field}: expected ${expected}`);
  }
  const releaseFiles = new Set(releaseConfig.files ?? []);
  for (const exclusion of requiredInternalReleaseExclusions) {
    if (!releaseFiles.has(exclusion)) {
      errors.push(`Release config must exclude ${exclusion}`);
    }
  }
  if (releaseConfig.mac?.identity === "-") {
    errors.push("Release config cannot use an ad-hoc signing identity");
  }
  for (const { name, config } of e2eConfigs) {
    const expectedE2e = [
      ["extends", config.extends, "./electron-builder.yml"],
      ["publish", config.publish, null],
      [
        "extraMetadata.villageUpdateSignerSha256",
        config.extraMetadata?.villageUpdateSignerSha256,
        null,
      ],
      ["mac.identity", config.mac?.identity, "-"],
      ["mac.notarize", config.mac?.notarize, false],
      ["mac.target", config.mac?.target, "dir"],
    ];
    for (const [field, actual, expected] of expectedE2e) {
      if (actual !== expected) {
        errors.push(
          `${name} has invalid ${field}: expected ${String(expected)}`,
        );
      }
    }
  }
  return errors;
}

async function validateFiles() {
  const e2eConfigNames = [
    "electron-builder.e2e.yml",
    "electron-builder.ritual-e2e.yml",
    "electron-builder.continuity-e2e.yml",
    "electron-builder.credential-e2e.yml",
  ];
  const [desktopPackage, releaseConfig, ...e2eConfigs] = await Promise.all([
    readFile(path.join(root, "apps/desktop/package.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "apps/desktop/electron-builder.yml"), "utf8").then(
      parse,
    ),
    ...e2eConfigNames.map((name) =>
      readFile(path.join(root, "apps/desktop", name), "utf8").then(parse),
    ),
  ]);
  return validateReleaseFiles({
    desktopPackage,
    releaseConfig,
    e2eConfigs: e2eConfigNames.map((name, index) => ({
      name,
      config: e2eConfigs[index],
    })),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = await validateFiles();
  if (process.argv.includes("--release")) {
    errors.push(...validateReleaseEnvironment(process.env));
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(
      process.argv.includes("--release")
        ? "Release configuration and credentials are valid."
        : "Static release configuration is valid.",
    );
  }
}
