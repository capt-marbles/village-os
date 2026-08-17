import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runPackagedDelegatedWorkflow } from "./verify-delegated-workflow.mjs";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApplicationPath = path.join(
  root,
  "apps/desktop/dist",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "Village.app",
);

export function assertCleanInstallEvidence(evidence) {
  if (
    evidence?.status !== "PASS" ||
    evidence.installLocation !== "TEMPORARY_APPLICATIONS" ||
    evidence.sourceBundleDistinct !== true ||
    evidence.packagedIntegrity !== "VALID" ||
    evidence.trustedUi !== "VISIBLE" ||
    evidence.terminalState !== "RECEIPTED_SUCCESS" ||
    evidence.finalizationEffects !== 1
  ) {
    throw new Error("PACKAGED_CLEAN_INSTALL_EVIDENCE_INCOMPLETE");
  }
  return evidence;
}

export async function runCleanInstallProof({
  applicationPath = defaultApplicationPath,
  timeoutMs = 180_000,
} = {}) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "village-clean-install-"),
  );
  const applicationsDirectory = path.join(temporaryRoot, "Applications");
  const installedApplicationPath = path.join(
    applicationsDirectory,
    "Village.app",
  );
  try {
    await mkdir(applicationsDirectory, { recursive: true, mode: 0o700 });
    await execFileAsync("/usr/bin/ditto", [
      applicationPath,
      installedApplicationPath,
    ]);
    const sourceBundleDistinct =
      (await realpath(applicationPath)) !==
      (await realpath(installedApplicationPath));
    const integrity = await verifyPackagedMac(installedApplicationPath);
    const workflow = await runPackagedDelegatedWorkflow({
      applicationPath: installedApplicationPath,
      mockKeychain: true,
      timeoutMs,
    });
    return assertCleanInstallEvidence({
      status: "PASS",
      installLocation: "TEMPORARY_APPLICATIONS",
      sourceBundleDistinct,
      packagedIntegrity:
        integrity.signature === "VALID" && integrity.fuses === "VALID"
          ? "VALID"
          : "INVALID",
      trustedUi:
        workflow.fixtureSurfaceVisible === true ? "VISIBLE" : "UNKNOWN",
      terminalState: workflow.terminal?.state,
      finalizationEffects: workflow.finalizationEffects,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const applicationIndex = process.argv.indexOf("--app");
  const applicationPath =
    applicationIndex === -1 ? undefined : process.argv[applicationIndex + 1];
  if (applicationIndex !== -1 && !applicationPath) {
    throw new Error("PACKAGED_CLEAN_INSTALL_APP_PATH_REQUIRED");
  }
  const evidence = await runCleanInstallProof({ applicationPath });
  console.log(
    `Packaged clean-install smoke passed: ${evidence.trustedUi}, ${evidence.terminalState}, ${evidence.finalizationEffects} finalization effect.`,
  );
}
