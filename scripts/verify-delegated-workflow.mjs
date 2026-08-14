import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

function requireTrue(value, code) {
  if (value !== true) throw new Error(code);
}

export function assertPackagedDelegatedWorkflowRun(report, provider) {
  if (report.status !== "PASS") {
    throw new Error(
      `PACKAGED_DELEGATED_WORKFLOW_DID_NOT_COMPLETE_${report.stopReason ?? report.terminal?.state ?? "UNKNOWN"}`,
    );
  }
  if (report.provider !== provider) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_PROVIDER_MISMATCH");
  }
  if (report.readyLabel !== "Ready for delegated setup") {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_NOT_OWNER_LEGIBLE");
  }
  if (report.terminal?.state !== "RECEIPTED_SUCCESS") {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_TERMINAL_MISSING");
  }
  if (report.finalizationEffects !== 1) {
    throw new Error("DELEGATED_WORKFLOW_FINALIZATION_NOT_EXACTLY_ONCE");
  }
  requireTrue(
    report.fixtureSurfaceVisible,
    "PACKAGED_DELEGATED_WORKFLOW_SURFACE_NOT_VISIBLE",
  );
  return report;
}

export function assertPackagedDelegatedWorkflowRecovery(
  interrupted,
  recovered,
  provider,
) {
  assertPackagedDelegatedWorkflowInterruption(interrupted, provider);
  assertPackagedDelegatedWorkflowRun(recovered, provider);
  if (recovered.resumedFrom !== "post-effect-before-receipt") {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_RECOVERY_MISSING");
  }
  return { interrupted, recovered };
}

export function assertPackagedDelegatedWorkflowAbruptRecovery(
  interruption,
  recovered,
  provider,
) {
  if (
    interruption.status !== "ABRUPT_EXIT" ||
    interruption.interruption !== "crash-after-effect-before-observation" ||
    interruption.exitCode !== 86 ||
    interruption.lastDurableActionPhase !== "DISPATCHED"
  ) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_ABRUPT_INTERRUPTION_MISSING");
  }
  assertPackagedDelegatedWorkflowRun(recovered, provider);
  if (recovered.resumedFrom !== "crash-after-effect-before-observation") {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_ABRUPT_RECOVERY_MISSING");
  }
  return { interruption, recovered };
}

function assertPackagedDelegatedWorkflowInterruption(report, provider) {
  if (
    report.status !== "INTERRUPTED" ||
    report.provider !== provider ||
    report.interruption !== "post-effect-before-receipt" ||
    report.actionPhase !== "RECONCILIATION_REQUIRED" ||
    report.finalizationEffects !== 1
  ) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_INTERRUPTION_MISSING");
  }
  return report;
}

export function packagedDelegatedWorkflowArguments({
  reportPath,
  profilePath,
  provider,
}) {
  if (!path.isAbsolute(profilePath)) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_PROFILE_UNSAFE");
  }
  return [
    "--village-proof-report",
    reportPath,
    "--village-proof-provider",
    provider === "CHATGPT_ACCOUNT" ? "chatgpt" : "deterministic",
    "--village-proof-profile",
    profilePath,
  ];
}

export function packagedDelegatedWorkflowRecoveryArguments({
  firstReportPath,
  secondReportPath,
  profilePath,
  provider,
}) {
  return {
    first: [
      ...packagedDelegatedWorkflowArguments({
        reportPath: firstReportPath,
        profilePath,
        provider,
      }),
      "--village-proof-interrupt",
      "post-effect-before-receipt",
    ],
    second: [
      ...packagedDelegatedWorkflowArguments({
        reportPath: secondReportPath,
        profilePath,
        provider,
      }),
      "--village-proof-resume",
      "post-effect-before-receipt",
    ],
  };
}

export async function runPackagedDelegatedWorkflow({
  applicationPath = defaultApplicationPath,
  provider = "DETERMINISTIC",
  profilePath,
  interruption,
  resumedFrom,
  timeoutMs = 180_000,
} = {}) {
  await verifyPackagedMac(applicationPath);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "village-delegated-workflow-"),
  );
  const reportPath = path.join(temporaryDirectory, "report.json");
  const effectiveProfilePath =
    profilePath ?? path.join(temporaryDirectory, "profile");
  const executable = path.join(applicationPath, "Contents/MacOS/Village");
  try {
    await mkdir(effectiveProfilePath, { recursive: true, mode: 0o700 });
    const arguments_ = packagedDelegatedWorkflowArguments({
      reportPath,
      profilePath: effectiveProfilePath,
      provider,
    });
    if (interruption) {
      arguments_.push("--village-proof-interrupt", interruption);
    }
    if (resumedFrom) {
      arguments_.push("--village-proof-resume", resumedFrom);
    }
    await execFileAsync(executable, arguments_, {
      cwd: root,
      timeout: timeoutMs,
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return interruption
      ? assertPackagedDelegatedWorkflowInterruption(report, provider)
      : assertPackagedDelegatedWorkflowRun(report, provider);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runPackagedDelegatedWorkflowRecovery({
  applicationPath = defaultApplicationPath,
  provider = "DETERMINISTIC",
  timeoutMs = 180_000,
} = {}) {
  const profileRoot = await mkdtemp(
    path.join(os.tmpdir(), "village-recovery-profile-"),
  );
  const profilePath = path.join(profileRoot, "profile");
  try {
    const interrupted = await runPackagedDelegatedWorkflow({
      applicationPath,
      provider,
      profilePath,
      interruption: "post-effect-before-receipt",
      timeoutMs,
    });
    const recovered = await runPackagedDelegatedWorkflow({
      applicationPath,
      provider,
      profilePath,
      resumedFrom: "post-effect-before-receipt",
      timeoutMs,
    });
    return assertPackagedDelegatedWorkflowRecovery(
      interrupted,
      recovered,
      provider,
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

async function runAbruptPackagedInterruption({
  applicationPath,
  provider,
  profilePath,
  timeoutMs,
}) {
  await verifyPackagedMac(applicationPath);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "village-abrupt-interruption-"),
  );
  const reportPath = path.join(temporaryDirectory, "unexpected-report.json");
  const executable = path.join(applicationPath, "Contents/MacOS/Village");
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    let exitCode;
    try {
      await execFileAsync(
        executable,
        [
          ...packagedDelegatedWorkflowArguments({
            reportPath,
            profilePath,
            provider,
          }),
          "--village-proof-interrupt",
          "crash-after-effect-before-observation",
        ],
        { cwd: root, timeout: timeoutMs },
      );
      throw new Error("PACKAGED_DELEGATED_WORKFLOW_ABRUPT_EXIT_MISSING");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        Number(error.code) === 86
      ) {
        exitCode = 86;
      } else {
        throw error;
      }
    }
    const journalPath = path.join(
      profilePath,
      "proof-state/internal-proof/journal.json",
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const finalizationEntries = Array.isArray(journal)
      ? journal.filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            entry.logicalStep === "FINALIZE_SETUP",
        )
      : [];
    const lastDurableActionPhase = finalizationEntries.at(-1)?.phase;
    return {
      status: "ABRUPT_EXIT",
      interruption: "crash-after-effect-before-observation",
      exitCode,
      lastDurableActionPhase,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runPackagedDelegatedWorkflowAbruptRecovery({
  applicationPath = defaultApplicationPath,
  provider = "DETERMINISTIC",
  timeoutMs = 180_000,
} = {}) {
  const profileRoot = await mkdtemp(
    path.join(os.tmpdir(), "village-abrupt-recovery-profile-"),
  );
  const profilePath = path.join(profileRoot, "profile");
  try {
    const interruption = await runAbruptPackagedInterruption({
      applicationPath,
      provider,
      profilePath,
      timeoutMs,
    });
    const recovered = await runPackagedDelegatedWorkflow({
      applicationPath,
      provider,
      profilePath,
      resumedFrom: "crash-after-effect-before-observation",
      timeoutMs,
    });
    return assertPackagedDelegatedWorkflowAbruptRecovery(
      interruption,
      recovered,
      provider,
    );
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.argv.includes("--genuine")
    ? "CHATGPT_ACCOUNT"
    : "DETERMINISTIC";
  const applicationIndex = process.argv.indexOf("--app");
  const profileIndex = process.argv.indexOf("--profile");
  const repeatIndex = process.argv.indexOf("--repeat");
  const recovery = process.argv.includes("--recovery");
  const abruptRecovery = process.argv.includes("--abrupt-recovery");
  const repeat =
    repeatIndex === -1 ? 1 : Number.parseInt(process.argv[repeatIndex + 1], 10);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    throw new Error("PACKAGED_DELEGATED_WORKFLOW_REPEAT_INVALID");
  }
  let ownedProfileRoot;
  try {
    if (abruptRecovery) {
      console.log(
        JSON.stringify(
          await runPackagedDelegatedWorkflowAbruptRecovery({
            applicationPath:
              applicationIndex === -1
                ? defaultApplicationPath
                : process.argv[applicationIndex + 1],
            provider,
          }),
        ),
      );
      process.exitCode = 0;
    } else if (recovery) {
      console.log(
        JSON.stringify(
          await runPackagedDelegatedWorkflowRecovery({
            applicationPath:
              applicationIndex === -1
                ? defaultApplicationPath
                : process.argv[applicationIndex + 1],
            provider,
          }),
        ),
      );
      process.exitCode = 0;
    } else {
      const profilePath =
        profileIndex === -1
          ? repeat === 1
            ? undefined
            : ((ownedProfileRoot = await mkdtemp(
                path.join(os.tmpdir(), "village-restart-profile-"),
              )),
              path.join(ownedProfileRoot, "profile"))
          : process.argv[profileIndex + 1];
      const reports = [];
      for (let launch = 1; launch <= repeat; launch += 1) {
        reports.push(
          await runPackagedDelegatedWorkflow({
            applicationPath:
              applicationIndex === -1
                ? defaultApplicationPath
                : process.argv[applicationIndex + 1],
            provider,
            ...(profilePath ? { profilePath } : {}),
          }),
        );
      }
      console.log(
        JSON.stringify(
          repeat === 1
            ? reports[0]
            : { status: "PASS", profileContinuity: true, reports },
        ),
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "BLOCKED",
        code: error instanceof Error ? error.message : "UNKNOWN_FAILURE",
      }),
    );
    process.exitCode = 1;
  } finally {
    if (ownedProfileRoot) {
      await rm(ownedProfileRoot, { recursive: true, force: true });
    }
  }
}
