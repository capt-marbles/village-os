import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPackagedDelegatedWorkflowAbruptRecovery,
  assertPackagedDelegatedWorkflowOwnerRecovery,
  assertPackagedDelegatedWorkflowRecovery,
  packagedDelegatedWorkflowArguments,
  packagedDelegatedWorkflowRecoveryArguments,
} from "./verify-delegated-workflow.mjs";

test("restart validation binds every packaged launch to one explicit profile", () => {
  const profilePath = "/tmp/village-proof-stable-profile";
  const first = packagedDelegatedWorkflowArguments({
    reportPath: "/tmp/village-proof-report-1.json",
    profilePath,
    provider: "DETERMINISTIC",
  });
  const second = packagedDelegatedWorkflowArguments({
    reportPath: "/tmp/village-proof-report-2.json",
    profilePath,
    provider: "DETERMINISTIC",
  });

  assert.deepEqual(first.slice(-2), ["--village-proof-profile", profilePath]);
  assert.deepEqual(second.slice(-2), ["--village-proof-profile", profilePath]);
});

test("the packaged proof rejects relative profile paths", () => {
  assert.throws(
    () =>
      packagedDelegatedWorkflowArguments({
        reportPath: "/tmp/village-proof-report.json",
        profilePath: "relative-profile",
        provider: "DETERMINISTIC",
      }),
    /PACKAGED_DELEGATED_WORKFLOW_PROFILE_UNSAFE/,
  );
});

test("post-effect recovery uses one profile and resumes instead of replaying", () => {
  const profilePath = "/tmp/village-proof-recovery-profile";
  const sequence = packagedDelegatedWorkflowRecoveryArguments({
    firstReportPath: "/tmp/village-proof-interrupted.json",
    secondReportPath: "/tmp/village-proof-recovered.json",
    profilePath,
    provider: "DETERMINISTIC",
  });

  assert.deepEqual(sequence.first.slice(-4), [
    "--village-proof-profile",
    profilePath,
    "--village-proof-interrupt",
    "post-effect-before-receipt",
  ]);
  assert.deepEqual(sequence.second.slice(-4), [
    "--village-proof-profile",
    profilePath,
    "--village-proof-resume",
    "post-effect-before-receipt",
  ]);
});

test("post-effect recovery requires durable interruption and one finalization", () => {
  assert.doesNotThrow(() =>
    assertPackagedDelegatedWorkflowRecovery(
      {
        status: "INTERRUPTED",
        provider: "DETERMINISTIC",
        interruption: "post-effect-before-receipt",
        actionPhase: "RECONCILIATION_REQUIRED",
        finalizationEffects: 1,
      },
      {
        status: "PASS",
        provider: "DETERMINISTIC",
        readyLabel: "Ready for delegated setup",
        terminal: { state: "RECEIPTED_SUCCESS" },
        finalizationEffects: 1,
        fixtureSurfaceVisible: true,
        resumedFrom: "post-effect-before-receipt",
      },
      "DETERMINISTIC",
    ),
  );
  assert.throws(
    () =>
      assertPackagedDelegatedWorkflowRecovery(
        {
          status: "INTERRUPTED",
          provider: "DETERMINISTIC",
          interruption: "post-effect-before-receipt",
          actionPhase: "RECONCILIATION_REQUIRED",
          finalizationEffects: 1,
        },
        {
          status: "PASS",
          provider: "DETERMINISTIC",
          readyLabel: "Ready for delegated setup",
          terminal: { state: "RECEIPTED_SUCCESS" },
          finalizationEffects: 2,
          fixtureSurfaceVisible: true,
          resumedFrom: "post-effect-before-receipt",
        },
        "DETERMINISTIC",
      ),
    /FINALIZATION_NOT_EXACTLY_ONCE/,
  );
});

test("abrupt recovery requires a dispatched-only final action before restart", () => {
  assert.doesNotThrow(() =>
    assertPackagedDelegatedWorkflowAbruptRecovery(
      {
        status: "ABRUPT_EXIT",
        interruption: "crash-after-effect-before-observation",
        exitCode: 86,
        lastDurableActionPhase: "DISPATCHED",
      },
      {
        status: "PASS",
        provider: "DETERMINISTIC",
        readyLabel: "Ready for delegated setup",
        terminal: { state: "RECEIPTED_SUCCESS" },
        finalizationEffects: 1,
        fixtureSurfaceVisible: true,
        resumedFrom: "crash-after-effect-before-observation",
      },
      "DETERMINISTIC",
    ),
  );
  assert.throws(
    () =>
      assertPackagedDelegatedWorkflowAbruptRecovery(
        {
          status: "ABRUPT_EXIT",
          interruption: "crash-after-effect-before-observation",
          exitCode: 86,
          lastDurableActionPhase: "EFFECT_OBSERVED",
        },
        {
          status: "PASS",
          provider: "DETERMINISTIC",
          readyLabel: "Ready for delegated setup",
          terminal: { state: "RECEIPTED_SUCCESS" },
          finalizationEffects: 1,
          fixtureSurfaceVisible: true,
          resumedFrom: "crash-after-effect-before-observation",
        },
        "DETERMINISTIC",
      ),
    /ABRUPT_INTERRUPTION_MISSING/,
  );
});

test("owner hand-back recovery requires attribution and a fresh lease", () => {
  assert.doesNotThrow(() =>
    assertPackagedDelegatedWorkflowOwnerRecovery(
      {
        status: "OWNER_CHECKPOINT",
        provider: "DETERMINISTIC",
        ownerControlVisible: true,
        returnControlVisible: true,
        lastEffectActor: "OWNER",
        logicalStep: "SET_PREFERRED_FOCUS",
        leaseEpoch: 3,
        completedEffectCount: 2,
      },
      {
        status: "PASS",
        provider: "DETERMINISTIC",
        readyLabel: "Ready for delegated setup",
        terminal: { state: "RECEIPTED_SUCCESS" },
        finalizationEffects: 1,
        fixtureSurfaceVisible: true,
        resumedFrom: "owner-handback-restart",
      },
      "DETERMINISTIC",
    ),
  );
  assert.throws(
    () =>
      assertPackagedDelegatedWorkflowOwnerRecovery(
        {
          status: "OWNER_CHECKPOINT",
          provider: "DETERMINISTIC",
          ownerControlVisible: true,
          returnControlVisible: true,
          lastEffectActor: "AGENT",
          logicalStep: "SET_PREFERRED_FOCUS",
          leaseEpoch: 3,
          completedEffectCount: 2,
        },
        {
          status: "PASS",
          provider: "DETERMINISTIC",
          readyLabel: "Ready for delegated setup",
          terminal: { state: "RECEIPTED_SUCCESS" },
          finalizationEffects: 1,
          fixtureSurfaceVisible: true,
          resumedFrom: "owner-handback-restart",
        },
        "DETERMINISTIC",
      ),
    /OWNER_CHECKPOINT_MISSING/,
  );
});
