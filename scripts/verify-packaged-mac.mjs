import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electronFuses from "@electron/fuses";
import { releaseInternalModulePrefixes } from "./release-internal-boundary.mjs";

const { FuseV1Options, getCurrentFuseWire } = electronFuses;
const fuseDisabled = 48;
const fuseEnabled = 49;

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadAsar() {
  const desktopRequire = createRequire(
    path.join(root, "apps/desktop/package.json"),
  );
  const builderPackage = desktopRequire.resolve(
    "electron-builder/package.json",
  );
  const asarPath = desktopRequire.resolve("@electron/asar", {
    paths: [path.dirname(builderPackage)],
  });
  return desktopRequire(asarPath);
}

export function assertReleaseAsarContents(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => {
      const normalized = String(entry).replace(/^\//, "");
      return releaseInternalModulePrefixes.some((prefix) =>
        normalized.startsWith(prefix),
      );
    })
  ) {
    throw new Error("PACKAGED_RELEASE_CONTAINS_INTERNAL_PROOF");
  }
}

export function parseCertificateFingerprint(output) {
  const match = /sha256 Fingerprint=([0-9A-F:]{95})/i.exec(output);
  return match?.[1].replaceAll(":", "").toLowerCase();
}

export function assertReleaseSigner(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) {
    throw new Error("INVALID_RELEASE_SIGNER_PIN");
  }
  if (actual !== expected) throw new Error("PACKAGED_SIGNER_MISMATCH");
}

async function signingCertificateSha256(applicationPath) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "village-signing-certificate-"),
  );
  const certificatePrefix = path.join(temporaryDirectory, "certificate");
  try {
    await execFileAsync("/usr/bin/codesign", [
      "--display",
      `--extract-certificates=${certificatePrefix}`,
      applicationPath,
    ]);
    const { stdout } = await execFileAsync("/usr/bin/openssl", [
      "x509",
      "-inform",
      "DER",
      "-in",
      `${certificatePrefix}0`,
      "-noout",
      "-fingerprint",
      "-sha256",
    ]);
    const fingerprint = parseCertificateFingerprint(stdout);
    if (!fingerprint) throw new Error("PACKAGED_SIGNER_FINGERPRINT_UNREADABLE");
    return fingerprint;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function verifyPackagedMac(
  applicationPath = path.join(
    root,
    "apps/desktop/dist",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "Village.app",
  ),
  { expectedSignerSha256, verifyReleaseContents = false } = {},
) {
  await access(applicationPath);
  await execFileAsync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    applicationPath,
  ]);
  const fuses = await getCurrentFuseWire(applicationPath);
  const expected = new Map([
    [FuseV1Options.RunAsNode, fuseDisabled],
    [FuseV1Options.EnableCookieEncryption, fuseEnabled],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, fuseDisabled],
    [FuseV1Options.EnableNodeCliInspectArguments, fuseDisabled],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, fuseEnabled],
    [FuseV1Options.OnlyLoadAppFromAsar, fuseEnabled],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, fuseDisabled],
  ]);
  for (const [fuse, state] of expected) {
    if (fuses[fuse] !== state) {
      throw new Error(`PACKAGED_FUSE_MISMATCH_${fuse}`);
    }
  }
  if (expectedSignerSha256 !== undefined) {
    assertReleaseSigner(
      await signingCertificateSha256(applicationPath),
      expectedSignerSha256,
    );
  }
  if (verifyReleaseContents) {
    const archive = path.join(applicationPath, "Contents/Resources/app.asar");
    assertReleaseAsarContents(loadAsar().listPackage(archive));
  }
  return { signature: "VALID", fuses: "VALID" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = process.argv.includes("--release");
  const applicationPath = process.argv
    .slice(2)
    .find((argument) => argument !== "--release");
  await verifyPackagedMac(applicationPath, {
    expectedSignerSha256: release
      ? process.env.VILLAGE_RELEASE_SIGNER_SHA256
      : undefined,
    verifyReleaseContents: release,
  });
  console.log("Packaged macOS signature and fuses are valid.");
}
