import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  validateReleaseMetrics,
  verifyReleaseMetrics,
} from "./verify-release-metrics.mjs";

const sourceCommit = "a".repeat(40);
const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function passingEvidence() {
  return {
    schemaVersion: 1,
    sourceCommit,
    appVersion: "0.1.0",
    recordedAt: "2026-08-20T15:30:00.000Z",
    environment: {
      platform: "darwin",
      architecture: "arm64",
    },
    setup: {
      firstLaunchToRetainedSessionMs: [540_000, 480_000, 570_000],
    },
    forcedRecovery: {
      scenarios: [
        {
          kind: "TAKEOVER",
          attempts: 3,
          converged: 3,
          duplicateContinuations: 0,
          convergenceLatencyMs: [220, 240, 260],
        },
        {
          kind: "RECONNECT",
          attempts: 3,
          converged: 3,
          duplicateContinuations: 0,
          convergenceLatencyMs: [900, 940, 980],
        },
        {
          kind: "RESTART",
          attempts: 3,
          converged: 3,
          duplicateContinuations: 0,
          convergenceLatencyMs: [1_800, 1_900, 2_000],
        },
      ],
    },
    leakage: {
      corpusCases: 120,
      prohibitedMatches: 0,
    },
    attention: {
      controlHeartbeatMs: 5_000,
      uiPropagationBudgetMs: 1_000,
      scenarios: [
        { kind: "OFFLINE", latencyMs: 5_800 },
        { kind: "CHALLENGE", latencyMs: 900 },
      ],
    },
    observerReplay: {
      attempts: 3,
      stateMatches: 3,
      sensitivePayloadMatches: 0,
    },
  };
}

test("accepts measured alpha evidence only when every release metric passes", () => {
  const result = verifyReleaseMetrics(passingEvidence(), {
    expectedSourceCommit: sourceCommit,
    expectedAppVersion: "0.1.0",
  });

  assert.deepEqual(result, {
    setupMedianMs: 540_000,
    recoveryAttempts: 9,
    worstRecoveryLatencyMs: 2_000,
    leakageCorpusCases: 120,
    worstAttentionLatencyMs: 5_800,
    observerReplayAttempts: 3,
  });
});

test("rejects stale, incomplete, unsafe, or threshold-missing evidence", () => {
  const cases = [
    [
      "stale commit",
      (evidence) => evidence,
      { expectedSourceCommit: "b".repeat(40), expectedAppVersion: "0.1.0" },
      "RELEASE_METRICS_SOURCE_COMMIT_MISMATCH",
    ],
    [
      "stale app version",
      (evidence) => evidence,
      { expectedAppVersion: "0.2.0" },
      "RELEASE_METRICS_APP_VERSION_MISMATCH",
    ],
    [
      "wrong package architecture",
      (evidence) => evidence,
      { expectedArchitecture: "x64" },
      "RELEASE_METRICS_ARCHITECTURE_MISMATCH",
    ],
    [
      "setup median at the limit",
      (evidence) => {
        evidence.setup.firstLaunchToRetainedSessionMs = [600_000, 600_000, 1];
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_SETUP_THRESHOLD_MISSED",
    ],
    [
      "missing restart recovery",
      (evidence) => {
        evidence.forcedRecovery.scenarios.pop();
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_RECOVERY_SCENARIOS_INCOMPLETE",
    ],
    [
      "partial recovery",
      (evidence) => {
        evidence.forcedRecovery.scenarios[0].converged = 2;
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_RECOVERY_DID_NOT_CONVERGE",
    ],
    [
      "duplicate continuation",
      (evidence) => {
        evidence.forcedRecovery.scenarios[1].duplicateContinuations = 1;
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_DUPLICATE_CONTINUATION",
    ],
    [
      "leakage match",
      (evidence) => {
        evidence.leakage.prohibitedMatches = 1;
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_SECRET_LEAKAGE",
    ],
    [
      "attention exceeds heartbeat plus propagation",
      (evidence) => {
        evidence.attention.scenarios[0].latencyMs = 6_001;
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_ATTENTION_THRESHOLD_MISSED",
    ],
    [
      "observer mismatch",
      (evidence) => {
        evidence.observerReplay.stateMatches = 2;
        return evidence;
      },
      undefined,
      "RELEASE_METRICS_OBSERVER_REPLAY_MISMATCH",
    ],
    [
      "unknown field",
      (evidence) => ({ ...evidence, notes: "unbounded" }),
      undefined,
      "RELEASE_METRICS_UNKNOWN_FIELD",
    ],
  ];

  for (const [name, mutate, options, expected] of cases) {
    const errors = validateReleaseMetrics(mutate(passingEvidence()), {
      expectedSourceCommit: sourceCommit,
      expectedAppVersion: "0.1.0",
      ...options,
    });
    assert.ok(errors.includes(expected), `${name}: ${errors.join(", ")}`);
  }
});

test("rejects malformed and undersampled evidence without throwing", () => {
  const evidence = passingEvidence();
  evidence.setup.firstLaunchToRetainedSessionMs = [500_000, 510_000];
  evidence.forcedRecovery.scenarios[0].convergenceLatencyMs = [1];
  evidence.attention.scenarios = [
    ...evidence.attention.scenarios,
    { kind: "OFFLINE", latencyMs: 1 },
  ];
  evidence.recordedAt = "not-an-instant";

  assert.deepEqual(
    validateReleaseMetrics(evidence, {
      expectedSourceCommit: sourceCommit,
      expectedAppVersion: "0.1.0",
    }),
    [
      "RELEASE_METRICS_RECORDED_AT_INVALID",
      "RELEASE_METRICS_SETUP_SAMPLE_INCOMPLETE",
      "RELEASE_METRICS_RECOVERY_LATENCIES_INCOMPLETE",
      "RELEASE_METRICS_ATTENTION_SCENARIOS_INVALID",
    ],
  );
});

test("the release CLI binds evidence to a clean source and its production environment path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "village-metrics-"));
  try {
    const repository = path.join(directory, "repository");
    const evidencePath = path.join(directory, "release-metrics.json");
    await Promise.all([
      mkdir(path.join(repository, "scripts"), { recursive: true }),
      mkdir(path.join(repository, "apps/desktop"), { recursive: true }),
    ]);
    await Promise.all([
      cp(
        path.join(root, "scripts/verify-release-metrics.mjs"),
        path.join(repository, "scripts/verify-release-metrics.mjs"),
      ),
      writeFile(
        path.join(repository, "apps/desktop/package.json"),
        JSON.stringify({ version: "0.1.0" }),
      ),
    ]);
    await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Village Test",
        "-c",
        "user.email=village@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: repository },
    );
    const { stdout: commit } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repository },
    );
    const evidence = passingEvidence();
    evidence.sourceCommit = commit.trim();
    evidence.environment.architecture = process.arch;
    await writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o600 });

    const accepted = await execFileAsync(
      process.execPath,
      ["scripts/verify-release-metrics.mjs"],
      {
        cwd: repository,
        env: {
          ...process.env,
          VILLAGE_RELEASE_METRICS_PATH: evidencePath,
        },
      },
    );
    assert.match(accepted.stdout, /Release metrics passed/u);
    assert.match(accepted.stdout, /worst recovery 2000 ms/u);

    const environmentWithoutEvidence = { ...process.env };
    delete environmentWithoutEvidence.VILLAGE_RELEASE_METRICS_PATH;
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/verify-release-metrics.mjs"], {
        cwd: repository,
        env: environmentWithoutEvidence,
      }),
      (error) => {
        assert.match(error.stderr, /RELEASE_METRICS_EVIDENCE_REQUIRED/u);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/verify-release-metrics.mjs", "--unknown"],
        { cwd: repository },
      ),
      (error) => {
        assert.match(error.stderr, /RELEASE_METRICS_ARGUMENT_INVALID/u);
        return true;
      },
    );

    await writeFile(evidencePath, "{".repeat(128 * 1024 + 1));
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/verify-release-metrics.mjs", "--evidence", evidencePath],
        { cwd: repository },
      ),
      (error) => {
        assert.match(error.stderr, /RELEASE_METRICS_EVIDENCE_UNSAFE/u);
        return true;
      },
    );

    await writeFile(evidencePath, "not-json");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/verify-release-metrics.mjs", "--evidence", evidencePath],
        { cwd: repository },
      ),
      (error) => {
        assert.match(error.stderr, /RELEASE_METRICS_EVIDENCE_INVALID_JSON/u);
        return true;
      },
    );

    await writeFile(evidencePath, JSON.stringify(evidence), { mode: 0o600 });

    const uncommittedSource = path.join(repository, "uncommitted-source.mjs");
    await writeFile(uncommittedSource, "export {};\n");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/verify-release-metrics.mjs", "--evidence", evidencePath],
        { cwd: repository },
      ),
      (error) => {
        assert.match(error.stderr, /RELEASE_METRICS_WORKTREE_DIRTY/u);
        return true;
      },
    );

    await rm(uncommittedSource);
    await writeFile(
      path.join(repository, "apps/desktop/package.json"),
      JSON.stringify({ version: "0.1.1" }),
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["scripts/verify-release-metrics.mjs", "--evidence", evidencePath],
        { cwd: repository },
      ),
      (error) => {
        assert.match(error.stderr, /RELEASE_METRICS_WORKTREE_DIRTY/u);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
