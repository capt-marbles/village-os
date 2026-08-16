import assert from "node:assert/strict";
import test from "node:test";
import { assertTwoMacSiteSessionContinuity } from "./verify-site-session-continuity-two-mac.mjs";

const passingReport = {
  status: "PASS",
  sourceHost: "A's Mac Studio",
  destinationHost: "A's MacBook Air",
  sourceMachineId: "studio-machine",
  destinationMachineId: "laptop-machine",
  transfersApplied: 20,
  destinationRevision: 20,
  restartRevision: 20,
  restartNoNewRevision: true,
  authenticatedAfterRestart: true,
  logoutRevision: 21,
  logoutPropagated: true,
  revokedActivationAbsent: true,
  revokedFetchRejected: true,
  grantDeleted: true,
  destinationOfflineDuringPublish: true,
  sourceProfileDistinct: true,
  destinationProfileDistinct: true,
  keychainMode: "MOCK_TEST_ONLY",
  site: "OWNED_FIXTURE",
};

test("accepts physical two-Mac continuity evidence at the fixture boundary", () => {
  assert.deepEqual(
    assertTwoMacSiteSessionContinuity(passingReport),
    passingReport,
  );
});

test("rejects a same-machine or non-fixture continuity claim", () => {
  assert.throws(
    () =>
      assertTwoMacSiteSessionContinuity({
        ...passingReport,
        destinationMachineId: passingReport.sourceMachineId,
      }),
    /TWO_MAC_CONTINUITY_MACHINE_ISOLATION_FAILED/,
  );
  assert.throws(
    () =>
      assertTwoMacSiteSessionContinuity({
        ...passingReport,
        site: "LINKEDIN",
      }),
    /TWO_MAC_CONTINUITY_SITE_BOUNDARY_FAILED/,
  );
});

test("rejects incomplete restart, logout, or revocation evidence", () => {
  for (const report of [
    { ...passingReport, restartNoNewRevision: false },
    { ...passingReport, logoutPropagated: false },
    { ...passingReport, revokedFetchRejected: false },
    { ...passingReport, grantDeleted: false },
  ]) {
    assert.throws(
      () => assertTwoMacSiteSessionContinuity(report),
      /TWO_MAC_CONTINUITY_(RESTART|LOGOUT|REVOCATION)_FAILED/,
    );
  }
});
