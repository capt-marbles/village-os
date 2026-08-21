import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredRecoveryKinds = ["TAKEOVER", "RECONNECT", "RESTART"];
const requiredAttentionKinds = ["OFFLINE", "CHALLENGE"];
const maximumEvidenceBytes = 128 * 1024;
const maximumEvidenceAgeMs = 24 * 60 * 60 * 1000;
const maximumFutureClockSkewMs = 5 * 60 * 1000;

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isBoundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isBoundedIntegerArray(value, minimumLength = 1) {
  return (
    Array.isArray(value) &&
    value.length >= minimumLength &&
    value.length <= 100 &&
    value.every((entry) => isBoundedInteger(entry, 0, 86_400_000))
  );
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function hasUniqueRequiredKinds(values, requiredKinds) {
  if (!Array.isArray(values) || values.length !== requiredKinds.length) {
    return false;
  }
  const kinds = values.map((value) => value?.kind);
  return (
    new Set(kinds).size === requiredKinds.length &&
    requiredKinds.every((kind) => kinds.includes(kind))
  );
}

export function validateReleaseMetrics(
  evidence,
  {
    expectedSourceCommit,
    expectedAppVersion,
    expectedArchitecture,
    nowMs = Date.now(),
  } = {},
) {
  const errors = [];
  if (!isRecord(evidence)) return ["RELEASE_METRICS_SCHEMA_INVALID"];
  if (
    !hasExactKeys(evidence, [
      "schemaVersion",
      "sourceCommit",
      "appVersion",
      "recordedAt",
      "environment",
      "setup",
      "forcedRecovery",
      "leakage",
      "attention",
      "observerReplay",
    ])
  ) {
    errors.push("RELEASE_METRICS_UNKNOWN_FIELD");
  }
  if (evidence.schemaVersion !== 1) {
    errors.push("RELEASE_METRICS_SCHEMA_VERSION_UNSUPPORTED");
  }
  if (!/^[a-f0-9]{40}$/.test(evidence.sourceCommit ?? "")) {
    errors.push("RELEASE_METRICS_SOURCE_COMMIT_INVALID");
  } else if (
    expectedSourceCommit !== undefined &&
    evidence.sourceCommit !== expectedSourceCommit
  ) {
    errors.push("RELEASE_METRICS_SOURCE_COMMIT_MISMATCH");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(evidence.appVersion ?? "")) {
    errors.push("RELEASE_METRICS_APP_VERSION_INVALID");
  } else if (
    expectedAppVersion !== undefined &&
    evidence.appVersion !== expectedAppVersion
  ) {
    errors.push("RELEASE_METRICS_APP_VERSION_MISMATCH");
  }
  const recordedAtMs = Date.parse(evidence.recordedAt);
  if (
    typeof evidence.recordedAt !== "string" ||
    Number.isNaN(recordedAtMs) ||
    new Date(evidence.recordedAt).toISOString() !== evidence.recordedAt
  ) {
    errors.push("RELEASE_METRICS_RECORDED_AT_INVALID");
  } else if (nowMs - recordedAtMs > maximumEvidenceAgeMs) {
    errors.push("RELEASE_METRICS_EVIDENCE_STALE");
  } else if (recordedAtMs - nowMs > maximumFutureClockSkewMs) {
    errors.push("RELEASE_METRICS_RECORDED_AT_FUTURE");
  }
  const supportedEnvironment =
    hasExactKeys(evidence.environment, ["platform", "architecture"]) &&
    evidence.environment.platform === "darwin" &&
    ["arm64", "x64"].includes(evidence.environment.architecture);
  if (!supportedEnvironment) {
    errors.push("RELEASE_METRICS_ENVIRONMENT_UNSUPPORTED");
  } else if (
    expectedArchitecture !== undefined &&
    evidence.environment.architecture !== expectedArchitecture
  ) {
    errors.push("RELEASE_METRICS_ARCHITECTURE_MISMATCH");
  }

  const setupSamples = evidence.setup?.firstLaunchToRetainedSessionMs;
  if (
    !hasExactKeys(evidence.setup, ["firstLaunchToRetainedSessionMs"]) ||
    !isBoundedIntegerArray(setupSamples, 3)
  ) {
    errors.push("RELEASE_METRICS_SETUP_SAMPLE_INCOMPLETE");
  } else if (median(setupSamples) >= 600_000) {
    errors.push("RELEASE_METRICS_SETUP_THRESHOLD_MISSED");
  }

  const recoveryScenarios = evidence.forcedRecovery?.scenarios;
  if (
    !hasExactKeys(evidence.forcedRecovery, ["scenarios"]) ||
    !hasUniqueRequiredKinds(recoveryScenarios, requiredRecoveryKinds)
  ) {
    errors.push("RELEASE_METRICS_RECOVERY_SCENARIOS_INCOMPLETE");
  } else {
    for (const scenario of recoveryScenarios) {
      if (
        !hasExactKeys(scenario, [
          "kind",
          "attempts",
          "converged",
          "duplicateContinuations",
          "convergenceLatencyMs",
        ]) ||
        !isBoundedInteger(scenario.attempts, 1, 100) ||
        !isBoundedInteger(scenario.converged, 0, 100) ||
        !isBoundedInteger(scenario.duplicateContinuations, 0, 100)
      ) {
        errors.push("RELEASE_METRICS_RECOVERY_SCENARIO_INVALID");
        continue;
      }
      if (
        !isBoundedIntegerArray(scenario.convergenceLatencyMs) ||
        scenario.convergenceLatencyMs.length !== scenario.attempts
      ) {
        errors.push("RELEASE_METRICS_RECOVERY_LATENCIES_INCOMPLETE");
      }
      if (scenario.converged !== scenario.attempts) {
        errors.push("RELEASE_METRICS_RECOVERY_DID_NOT_CONVERGE");
      }
      if (scenario.duplicateContinuations !== 0) {
        errors.push("RELEASE_METRICS_DUPLICATE_CONTINUATION");
      }
    }
  }

  if (
    !hasExactKeys(evidence.leakage, ["corpusCases", "prohibitedMatches"]) ||
    !isBoundedInteger(evidence.leakage?.corpusCases, 1, 1_000_000) ||
    !isBoundedInteger(evidence.leakage?.prohibitedMatches, 0, 1_000_000)
  ) {
    errors.push("RELEASE_METRICS_LEAKAGE_EVIDENCE_INVALID");
  } else if (evidence.leakage.prohibitedMatches !== 0) {
    errors.push("RELEASE_METRICS_SECRET_LEAKAGE");
  }

  const attentionScenarios = evidence.attention?.scenarios;
  if (
    !hasExactKeys(evidence.attention, [
      "controlHeartbeatMs",
      "uiPropagationBudgetMs",
      "scenarios",
    ]) ||
    !isBoundedInteger(evidence.attention?.controlHeartbeatMs, 1, 300_000) ||
    !isBoundedInteger(evidence.attention?.uiPropagationBudgetMs, 0, 300_000) ||
    !hasUniqueRequiredKinds(attentionScenarios, requiredAttentionKinds) ||
    !attentionScenarios.every(
      (scenario) =>
        hasExactKeys(scenario, ["kind", "latencyMs"]) &&
        isBoundedInteger(scenario.latencyMs, 0, 600_000),
    )
  ) {
    errors.push("RELEASE_METRICS_ATTENTION_SCENARIOS_INVALID");
  } else {
    const attentionLimit =
      evidence.attention.controlHeartbeatMs +
      evidence.attention.uiPropagationBudgetMs;
    if (
      attentionScenarios.some((scenario) => scenario.latencyMs > attentionLimit)
    ) {
      errors.push("RELEASE_METRICS_ATTENTION_THRESHOLD_MISSED");
    }
  }

  if (
    !hasExactKeys(evidence.observerReplay, [
      "attempts",
      "stateMatches",
      "sensitivePayloadMatches",
    ]) ||
    !isBoundedInteger(evidence.observerReplay?.attempts, 1, 100) ||
    !isBoundedInteger(evidence.observerReplay?.stateMatches, 0, 100) ||
    !isBoundedInteger(evidence.observerReplay?.sensitivePayloadMatches, 0, 100)
  ) {
    errors.push("RELEASE_METRICS_OBSERVER_REPLAY_INVALID");
  } else {
    if (
      evidence.observerReplay.stateMatches !== evidence.observerReplay.attempts
    ) {
      errors.push("RELEASE_METRICS_OBSERVER_REPLAY_MISMATCH");
    }
    if (evidence.observerReplay.sensitivePayloadMatches !== 0) {
      errors.push("RELEASE_METRICS_OBSERVER_REPLAY_LEAKAGE");
    }
  }
  return [...new Set(errors)];
}

export function verifyReleaseMetrics(evidence, options) {
  const errors = validateReleaseMetrics(evidence, options);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const recoveryScenarios = evidence.forcedRecovery.scenarios;
  return {
    setupMedianMs: median(evidence.setup.firstLaunchToRetainedSessionMs),
    recoveryAttempts: recoveryScenarios.reduce(
      (total, scenario) => total + scenario.attempts,
      0,
    ),
    worstRecoveryLatencyMs: Math.max(
      ...recoveryScenarios.flatMap((scenario) => scenario.convergenceLatencyMs),
    ),
    leakageCorpusCases: evidence.leakage.corpusCases,
    worstAttentionLatencyMs: Math.max(
      ...evidence.attention.scenarios.map((scenario) => scenario.latencyMs),
    ),
    observerReplayAttempts: evidence.observerReplay.attempts,
  };
}

function evidencePathFromArguments(arguments_, environment) {
  if (
    arguments_.length !== 0 &&
    !(
      arguments_.length === 2 &&
      arguments_[0] === "--evidence" &&
      arguments_[1].length > 0
    )
  ) {
    throw new Error("RELEASE_METRICS_ARGUMENT_INVALID");
  }
  const candidate =
    arguments_.length === 0
      ? environment.VILLAGE_RELEASE_METRICS_PATH
      : arguments_[1];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("RELEASE_METRICS_EVIDENCE_REQUIRED");
  }
  return path.resolve(candidate);
}

async function loadEvidence(evidencePath) {
  const handle = await open(evidencePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumEvidenceBytes) {
      throw new Error("RELEASE_METRICS_EVIDENCE_UNSAFE");
    }
    const contents = Buffer.alloc(maximumEvidenceBytes + 1);
    const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
    if (bytesRead > maximumEvidenceBytes) {
      throw new Error("RELEASE_METRICS_EVIDENCE_UNSAFE");
    }
    try {
      return JSON.parse(contents.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new Error("RELEASE_METRICS_EVIDENCE_INVALID_JSON");
    }
  } finally {
    await handle.close();
  }
}

async function currentReleaseBinding() {
  let commit;
  let status;
  let desktopPackage;
  try {
    [{ stdout: commit }, { stdout: status }, desktopPackage] =
      await Promise.all([
        execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          timeout: 10_000,
          killSignal: "SIGKILL",
        }),
        execFileAsync(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all"],
          {
            cwd: root,
            timeout: 10_000,
            killSignal: "SIGKILL",
          },
        ),
        readFile(path.join(root, "apps/desktop/package.json"), "utf8").then(
          JSON.parse,
        ),
      ]);
  } catch {
    throw new Error("RELEASE_METRICS_BINDING_UNAVAILABLE");
  }
  if (status.trim().length > 0) {
    throw new Error("RELEASE_METRICS_WORKTREE_DIRTY");
  }
  return {
    expectedSourceCommit: commit.trim(),
    expectedAppVersion: desktopPackage.version,
    expectedArchitecture: process.arch,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const evidencePath = evidencePathFromArguments(
      process.argv.slice(2),
      process.env,
    );
    const [evidence, binding] = await Promise.all([
      loadEvidence(evidencePath),
      currentReleaseBinding(),
    ]);
    const summary = verifyReleaseMetrics(evidence, binding);
    console.log(
      `Release metrics passed: setup median ${summary.setupMedianMs} ms; ${summary.recoveryAttempts} recovery attempts; worst recovery ${summary.worstRecoveryLatencyMs} ms; ${summary.leakageCorpusCases} leakage cases; ${summary.observerReplayAttempts} replay attempts.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "RELEASE_METRICS_UNKNOWN_ERROR",
    );
    process.exitCode = 1;
  }
}
