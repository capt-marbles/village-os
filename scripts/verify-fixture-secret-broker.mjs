import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyPackagedMac } from "./verify-packaged-mac.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultApplicationPath = path.join(
  root,
  "apps/desktop/dist/credential-e2e",
  process.arch === "arm64" ? "mac-arm64" : "mac",
  "Village.app",
);

export function assertFixtureSecretBrokerEvidence(report, leakage) {
  if (
    report.status !== "PASS" ||
    report.authorizationResult !== "OK" ||
    report.approvedFieldFilled !== true ||
    report.approvedDestinationRequest !== true ||
    report.requestCount !== 2 ||
    report.destinationRequestCount !== 1 ||
    report.secretBufferCleared !== true ||
    report.clipboardUnchanged !== true ||
    report.devToolsOpened !== false
  ) {
    throw new Error("PACKAGED_FIXTURE_SECRET_EVIDENCE_INCOMPLETE");
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
  const profilePath = path.join(temporaryDirectory, "profile");
  const secret = `village-${randomBytes(24).toString("base64url")}`;
  await writeFile(seedPath, secret, { mode: 0o600, flag: "wx" });
  try {
    const executable = path.join(applicationPath, "Contents/MacOS/Village");
    const { stdout, stderr } = await execFileAsync(
      executable,
      [
        "--village-fixture-secret-seed",
        seedPath,
        "--village-fixture-secret-report",
        reportPath,
        "--village-fixture-secret-profile",
        profilePath,
      ],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const leakage = await scanFixtureSecretSinks(secret, [
      { name: "stdout", value: stdout },
      { name: "stderr", value: stderr },
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
    return assertFixtureSecretBrokerEvidence(report, leakage);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPackagedFixtureSecretBroker()
    .then((report) => {
      console.log(
        `Packaged fixture secret broker passed: ${report.destinationRequestCount} destination request, 0 prohibited-sink matches.`,
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
