import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}) {
  const errors = [];
  const electron = desktopPackage.devDependencies?.electron;
  if (typeof electron !== "string" || Number(electron.split(".")[0]) !== 43) {
    errors.push("Electron major 43 is required");
  }
  for (const required of [
    "electronVersion: 43.2.0",
    "runAsNode: false",
    "enableCookieEncryption: true",
    "enableNodeOptionsEnvironmentVariable: false",
    "enableNodeCliInspectArguments: false",
    "enableEmbeddedAsarIntegrityValidation: true",
    "onlyLoadAppFromAsar: true",
    "grantFileProtocolExtraPrivileges: false",
    "notarize: true",
    "url: https://updates.village.run/desktop/alpha",
    "channel: alpha",
  ]) {
    if (!releaseConfig.includes(required))
      errors.push(`Release config is missing: ${required}`);
  }
  if (/identity:\s*["']?-["']?/.test(releaseConfig)) {
    errors.push("Release config cannot use an ad-hoc signing identity");
  }
  for (const required of [
    "extends: ./electron-builder.yml",
    'identity: "-"',
    "notarize: false",
    "publish: null",
  ]) {
    if (!e2eConfig.includes(required))
      errors.push(`Local E2E config is missing: ${required}`);
  }
  return errors;
}

async function validateFiles() {
  const [desktopPackage, releaseConfig, e2eConfig] = await Promise.all([
    readFile(path.join(root, "apps/desktop/package.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(root, "apps/desktop/electron-builder.yml"), "utf8"),
    readFile(path.join(root, "apps/desktop/electron-builder.e2e.yml"), "utf8"),
  ]);
  return validateReleaseFiles({ desktopPackage, releaseConfig, e2eConfig });
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
