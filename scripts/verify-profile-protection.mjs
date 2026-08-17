import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApplicationPath = path.join(
  root,
  "apps/desktop/dist",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "Village.app",
);

export function assertEncryptedCookieFiles(files, sentinel, cookieName) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("PACKAGED_PROFILE_COOKIE_STORE_MISSING");
  }
  const secret = Buffer.from(sentinel);
  const name = Buffer.from(cookieName);
  if (files.some((file) => file.includes(secret))) {
    throw new Error("PACKAGED_PROFILE_COOKIE_PLAINTEXT_FOUND");
  }
  if (!files.some((file) => file.includes(name))) {
    throw new Error("PACKAGED_PROFILE_COOKIE_RECORD_MISSING");
  }
  const prefixes = ["v10", "v11", "v20"].map((value) => Buffer.from(value));
  if (!files.some((file) => prefixes.some((prefix) => file.includes(prefix)))) {
    throw new Error("PACKAGED_PROFILE_COOKIE_ENCRYPTION_PREFIX_MISSING");
  }
}

async function filesNamed(rootPath, accepted) {
  const results = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && accepted(entry.name)) results.push(entryPath);
    }
  };
  await visit(rootPath);
  return results;
}

async function timeoutPhase(reportPath) {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return typeof report?.status === "string" &&
      /^[A-Z][A-Z_]{1,63}$/.test(report.status)
      ? report.status
      : "UNKNOWN";
  } catch {
    return "NO_REPORT";
  }
}

async function runPackagedProof(
  executable,
  arguments_,
  environment,
  reportPath,
) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let outputBytes = 0;
    let timedOut = false;
    const capture = (chunk) => {
      if (outputBytes < 64 * 1024) {
        const value = Buffer.from(chunk);
        output.push(value);
        outputBytes += value.length;
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `PACKAGED_PROFILE_PROTECTION_TIMEOUT_AT_${await timeoutPhase(reportPath)}`,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        const diagnostic = Buffer.concat(output).toString("utf8").trim();
        reject(
          new Error(
            `PACKAGED_PROFILE_PROTECTION_EXIT_${code ?? signal ?? "UNKNOWN"}${diagnostic ? `:${diagnostic}` : ""}`,
          ),
        );
      }
    });
  });
}

export function assertProfileProtectionReport(report) {
  const expectedKeys = [
    "backupExclusion",
    "cookieName",
    "indexExclusion",
    "nativeConfirmation",
    "osCryptBackend",
    "ownerPresence",
    "status",
  ];
  if (
    !report ||
    typeof report !== "object" ||
    Object.keys(report).sort().join(",") !== expectedKeys.join(",") ||
    report.status !== "READY_FOR_DISK_VERIFICATION" ||
    report.cookieName !== "__Host-village_oscrypt_probe" ||
    report.osCryptBackend !== "keychain" ||
    report.backupExclusion !== "VERIFIED" ||
    report.indexExclusion !== "VERIFIED" ||
    report.ownerPresence !== "VERIFIED" ||
    report.nativeConfirmation !== "VERIFIED"
  ) {
    throw new Error("PACKAGED_PROFILE_PROTECTION_REPORT_INVALID");
  }
}

export async function verifyPackagedProfileProtection(
  applicationPath = defaultApplicationPath,
) {
  await verifyPackagedMac(applicationPath);
  const applicationSupport = path.join(
    os.homedir(),
    "Library",
    "Application Support",
  );
  await mkdir(applicationSupport, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    path.join(applicationSupport, "Village Profile Protection Proof-"),
  );
  const profilePath = path.join(temporaryDirectory, "profile");
  const reportPath = path.join(temporaryDirectory, "report.json");
  const profileRoot = path.join(profilePath, "browser-profiles");
  const sentinel = randomBytes(32).toString("hex");
  try {
    console.log(
      "Village will request Keychain access, macOS owner authorization, and native forget-session confirmation.",
    );
    await runPackagedProof(
      path.join(applicationPath, "Contents/MacOS/Village"),
      [
        "--village-proof-profile",
        profilePath,
        "--village-profile-protection-report",
        reportPath,
      ],
      {
        ...process.env,
        VILLAGE_PROFILE_PROTECTION_SENTINEL: sentinel,
      },
      reportPath,
    );
    assertProfileProtectionReport(
      JSON.parse(await readFile(reportPath, "utf8")),
    );
    const marker = await lstat(path.join(profileRoot, ".metadata_never_index"));
    if (
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      (marker.mode & 0o077) !== 0
    ) {
      throw new Error("PACKAGED_PROFILE_INDEX_EXCLUSION_UNVERIFIED");
    }
    const { stdout } = await execFileAsync("/usr/bin/tmutil", [
      "isexcluded",
      profileRoot,
    ]);
    if (!/^\[Excluded\]\s+/m.test(stdout)) {
      throw new Error("PACKAGED_PROFILE_BACKUP_EXCLUSION_UNVERIFIED");
    }
    const cookiePaths = await filesNamed(profileRoot, (name) =>
      /^(Cookies|Cookies-(journal|shm|wal))$/.test(name),
    );
    assertEncryptedCookieFiles(
      await Promise.all(cookiePaths.map((cookiePath) => readFile(cookiePath))),
      sentinel,
      "__Host-village_oscrypt_probe",
    );
    return {
      cookieEncryption: "VERIFIED",
      backupExclusion: "VERIFIED",
      indexExclusion: "VERIFIED",
      ownerPresence: "VERIFIED",
      nativeConfirmation: "VERIFIED",
    };
  } finally {
    await execFileAsync("/usr/bin/tmutil", [
      "removeexclusion",
      profileRoot,
    ]).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPackagedProfileProtection(process.argv[2]);
  console.log(
    "Packaged macOS profile encryption, Time Machine exclusion, Spotlight exclusion, owner authorization, and native confirmation are valid.",
  );
}
