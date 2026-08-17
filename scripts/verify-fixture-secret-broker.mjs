import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApplicationPath = path.join(
  root,
  "apps/desktop/dist/credential-e2e",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "Village.app",
);

export async function runBoundedProcess(
  executable,
  arguments_,
  { timeoutMs, environment = process.env },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: [], stderr: [] };
    const outputBytes = { stdout: 0, stderr: 0 };
    const capture = (name, chunk) => {
      if (outputBytes[name] >= 4 * 1024 * 1024) return;
      const bytes = Buffer.from(chunk);
      output[name].push(bytes);
      outputBytes[name] += bytes.length;
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(output.stdout).toString("utf8");
      const stderr = Buffer.concat(output.stderr).toString("utf8");
      if (timedOut) {
        const stages = stderr
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("VILLAGE_PROOF_STAGE:"));
        const lastStage = stages.at(-1)?.slice("VILLAGE_PROOF_STAGE:".length);
        reject(
          new Error(
            `PACKAGED_FIXTURE_SECRET_TIMEOUT${lastStage ? `_AT_${lastStage}` : ""}`,
          ),
        );
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `PACKAGED_FIXTURE_SECRET_EXIT_${code ?? signal ?? "UNKNOWN"}${stderr ? `:${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

export function assertFixtureSecretBrokerEvidence(
  report,
  leakage,
  restartReport,
) {
  if (
    report.status !== "PASS" ||
    report.authorizationResult !== "OK" ||
    report.approvedFieldFilled !== true ||
    report.approvedDestinationRequest !== true ||
    report.requestCount !== 2 ||
    report.destinationRequestCount !== 1 ||
    report.secretBufferCleared !== true ||
    report.clipboardUnchanged !== true ||
    report.devToolsOpened !== false ||
    report.browserStorageSeeded !== true ||
    report.permissionPolicyEnforced !== true ||
    report.browserCrashFenced !== true ||
    report.browserCrashWaiting !== true ||
    report.trustedRendererRecovered !== true ||
    report.crashDiagnosticsBounded !== true ||
    report.bindingMatrixRejected !== true ||
    report.absentTokenRejected !== true ||
    report.expiredTokenRejected !== true ||
    report.replayRejected !== true ||
    report.mainProcessRequestPathUsed !== true ||
    report.cancelPreservedProfile !== true ||
    report.partialFailureObserved !== true ||
    report.erasureStaged !== true ||
    report.automationFenced !== true ||
    report.credentialReferenceRevoked !== true ||
    report.credentialAbsent !== true ||
    report.targetPresentUntilRestart !== true
  ) {
    throw new Error("PACKAGED_FIXTURE_SECRET_EVIDENCE_INCOMPLETE");
  }
  const missingRestartEvidence = [
    "targetAbsentAfterRestart",
    "targetLockAbsentAfterRestart",
    "siblingCookiePreserved",
    "siblingLocalStoragePreserved",
    "siblingIndexedDbPreserved",
    "siblingCachePreserved",
    "siblingPermissionPolicyPreserved",
    "siblingJournalPreserved",
    "siblingVaultReferencePreserved",
    "credentialReferenceAbsentAfterRestart",
    "pendingErasureConsumed",
  ].filter((field) => restartReport?.[field] !== true);
  if (missingRestartEvidence.length > 0) {
    throw new Error(
      `PACKAGED_FIXTURE_SESSION_ERASURE_INCOMPLETE_${missingRestartEvidence.join("_")}`,
    );
  }
  if (report.nonDestinationRequests !== 0) {
    throw new Error("PACKAGED_FIXTURE_SECRET_DESTINATION_NOT_EXCLUSIVE");
  }
  if (!leakage || !Array.isArray(leakage.matches)) {
    throw new Error("PACKAGED_FIXTURE_SECRET_LEAKAGE_SCAN_MISSING");
  }
  if (leakage.matches.length !== 0) {
    throw new Error("PACKAGED_FIXTURE_SECRET_LEAKED");
  }
  return report;
}

function variantsFor(secret) {
  const bytes = Buffer.from(secret);
  return new Map([
    ["plaintext", bytes],
    ["base64", Buffer.from(bytes.toString("base64"))],
    ["base64url", Buffer.from(bytes.toString("base64url"))],
    ["url-encoded", Buffer.from(encodeURIComponent(secret))],
    ["hex", Buffer.from(bytes.toString("hex"))],
    ["decimal-bytes", Buffer.from([...bytes].join(","))],
    ["decimal-bytes-spaced", Buffer.from([...bytes].join(", "))],
  ]);
}

async function* filesBelow(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesBelow(candidate);
    else if (entry.isFile()) yield candidate;
  }
}

async function scanFileForSecret(secret, name, file) {
  const variants = variantsFor(secret);
  const maximumNeedleLength = Math.max(
    ...[...variants.values()].map((needle) => needle.length),
  );
  const matches = new Set();
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.concat([carry, chunk]);
    for (const [variant, needle] of variants) {
      if (needle.length > 0 && bytes.includes(needle)) matches.add(variant);
    }
    carry = bytes.subarray(
      Math.max(0, bytes.length - Math.max(0, maximumNeedleLength - 1)),
    );
  }
  return [...matches].map((variant) => ({ sink: name, variant }));
}

export async function scanFixtureSecretSinks(secret, sinks) {
  const matches = [];
  const variants = variantsFor(secret);
  for (const sink of sinks) {
    const bytes = Buffer.isBuffer(sink.value)
      ? sink.value
      : Buffer.from(String(sink.value));
    for (const [variant, needle] of variants) {
      if (needle.length > 0 && bytes.includes(needle)) {
        matches.push({ sink: sink.name, variant });
      }
    }
  }
  return { matches };
}

export async function runPackagedFixtureSecretBroker({
  applicationPath = defaultApplicationPath,
  timeoutMs = 90_000,
} = {}) {
  await verifyPackagedMac(applicationPath);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "village-fixture-secret-"),
  );
  const seedPath = path.join(temporaryDirectory, "seed.bin");
  const reportPath = path.join(temporaryDirectory, "report.json");
  const restartReportPath = path.join(
    temporaryDirectory,
    "restart-report.json",
  );
  const profilePath = path.join(temporaryDirectory, "profile");
  const secret = `village-${randomBytes(24).toString("base64url")}`;
  await writeFile(seedPath, secret, { mode: 0o600, flag: "wx" });
  try {
    const executable = path.join(applicationPath, "Contents/MacOS/Village");
    const { stdout, stderr } = await runBoundedProcess(
      executable,
      [
        "--village-fixture-secret-seed",
        seedPath,
        "--village-fixture-secret-report",
        reportPath,
        "--village-fixture-secret-profile",
        profilePath,
      ],
      { timeoutMs },
    );
    const { stdout: restartStdout, stderr: restartStderr } =
      await runBoundedProcess(
        executable,
        [
          "--village-fixture-secret-profile",
          profilePath,
          "--village-fixture-erasure-restart-report",
          restartReportPath,
        ],
        { timeoutMs },
      );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const restartReport = JSON.parse(await readFile(restartReportPath, "utf8"));
    const leakage = await scanFixtureSecretSinks(secret, [
      { name: "stdout", value: stdout },
      { name: "stderr", value: stderr },
      { name: "restart-stdout", value: restartStdout },
      { name: "restart-stderr", value: restartStderr },
    ]);
    for await (const file of filesBelow(temporaryDirectory)) {
      leakage.matches.push(
        ...(await scanFileForSecret(
          secret,
          path.relative(temporaryDirectory, file),
          file,
        )),
      );
    }
    return assertFixtureSecretBrokerEvidence(report, leakage, restartReport);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPackagedFixtureSecretBroker()
    .then((report) => {
      console.log(
        `Packaged fixture secret broker and restart-safe erasure passed: ${report.destinationRequestCount} destination request, 0 prohibited-sink matches.`,
      );
    })
    .catch((error) => {
      console.error(
        "Packaged fixture secret broker failed:",
        error instanceof Error ? error.message : "UNKNOWN_FAILURE",
      );
      process.exitCode = 1;
    });
}
