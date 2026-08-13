import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electronFuses from "@electron/fuses";

const { FuseV1Options, getCurrentFuseWire } = electronFuses;
const fuseDisabled = 48;
const fuseEnabled = 49;

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyPackagedMac(
  applicationPath = path.join(
    root,
    "apps/desktop/dist",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "Village.app",
  ),
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
  return { signature: "VALID", fuses: "VALID" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPackagedMac(process.argv[2]);
  console.log("Packaged macOS signature and fuses are valid.");
}
