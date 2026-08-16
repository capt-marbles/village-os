import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertOwnerCeremonyTwoMacContinuity,
  assertTwoMacSiteSessionContinuity,
  awaitOwnerApprovedGrant,
  awaitOwnerDeletedGrant,
  awaitOwnerGrantState,
  createOwnerCeremonyConfiguration,
} from "./verify-site-session-continuity-two-mac.mjs";

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

test("requires explicit owner-ceremony evidence for the interactive gate", () => {
  const ceremonyReport = {
    ...passingReport,
    ownerCeremony: true,
    ownerApprovedGrant: true,
    ownerObservedLogout: true,
    ownerStoppedHandoff: true,
    ownerDeletedHandoff: true,
  };
  assert.deepEqual(
    assertOwnerCeremonyTwoMacContinuity(ceremonyReport),
    ceremonyReport,
  );
  for (const field of [
    "ownerApprovedGrant",
    "ownerObservedLogout",
    "ownerStoppedHandoff",
    "ownerDeletedHandoff",
  ]) {
    assert.throws(
      () =>
        assertOwnerCeremonyTwoMacContinuity({
          ...ceremonyReport,
          [field]: false,
        }),
      /TWO_MAC_OWNER_CEREMONY_FAILED/,
    );
  }
});

test("waits for the owner to approve the exact prepared Mac handoff", async () => {
  const expected = {
    grantId: "cgr_01J00000000000000000000008",
    sourceDeviceId: "dev_01J00000000000000000000001",
    destinationDeviceId: "dev_01J00000000000000000000002",
    sourceBrowserSessionId: "brs_01J00000000000000000000001",
    destinationBrowserSessionId: "brs_01J00000000000000000000002",
    site: "OWNED_FIXTURE",
    state: "ACTIVE",
    createdAt: "2026-08-15T21:00:00.000Z",
    expiresAt: "2026-08-22T21:00:00.000Z",
  };
  const snapshots = [
    { ok: true, sessions: [], grants: [] },
    {
      ok: true,
      sessions: [],
      grants: [
        { ...expected, sourceDeviceId: expected.destinationDeviceId },
        expected,
      ],
    },
  ];
  const request = async () => Response.json(snapshots.shift());

  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await awaitOwnerApprovedGrant({
        baseUrl: "https://continuity.example.test",
        principalId: "prn_01J00000000000000000000000",
        csrf: "csrf-token-that-is-at-least-thirty-two-bytes-long",
        binding: expected,
        request,
        pause: async () => undefined,
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
        timeoutMs: 10,
      }),
      expected,
    );
  });
});

test("waits for owner stop and deletion without performing either action", async () => {
  const grantId = "cgr_01J00000000000000000000008";
  const active = Response.json({
    ok: true,
    grant: { grantId, state: "ACTIVE" },
    transfer: {
      state: "ACTIVE",
      publishedRevision: 21,
      appliedRevision: 21,
      pendingRevisions: 0,
    },
  });
  const revoked = Response.json({
    ok: true,
    grant: { grantId, state: "REVOKED" },
    transfer: {
      state: "REVOKED",
      publishedRevision: 21,
      appliedRevision: 21,
      pendingRevisions: 0,
    },
  });
  const responses = [active, revoked];
  const common = {
    baseUrl: "https://continuity.example.test",
    principalId: "prn_01J00000000000000000000000",
    csrf: "csrf-token-that-is-at-least-thirty-two-bytes-long",
    grantId,
    pause: async () => undefined,
    now: (() => {
      let value = 0;
      return () => value++;
    })(),
    timeoutMs: 10,
  };

  assert.equal(
    (
      await awaitOwnerGrantState({
        ...common,
        expectedState: "REVOKED",
        request: async () => responses.shift(),
      })
    ).grant.state,
    "REVOKED",
  );
  await assert.doesNotReject(() =>
    awaitOwnerDeletedGrant({
      ...common,
      request: async () => Response.json({ ok: false }, { status: 404 }),
    }),
  );
});

test("keeps owner proof credentials in a local mode-600 configuration", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "village-owner-proof-"),
  );
  const configurationPath = path.join(directory, "owner-ceremony.json");
  try {
    const event = await createOwnerCeremonyConfiguration({
      configurationPath,
      controlPlane: "https://continuity.example.test",
      principalId: "prn_01J00000000000000000000000",
      csrf: "csrf-token-that-is-at-least-thirty-two-bytes-long",
      sourceDeviceName: "Mac Studio",
      destinationDeviceName: "MacBook Air",
    });
    assert.deepEqual(event, {
      event: "OWNER_CEREMONY_READY",
      configurationPath,
      webOrigin: "http://localhost:5174",
      sourceDeviceName: "Mac Studio",
      destinationDeviceName: "MacBook Air",
    });
    assert.doesNotMatch(JSON.stringify(event), /csrf|principalId/);
    assert.deepEqual(JSON.parse(await readFile(configurationPath, "utf8")), {
      controlPlane: "https://continuity.example.test",
      principalId: "prn_01J00000000000000000000000",
      csrf: "csrf-token-that-is-at-least-thirty-two-bytes-long",
    });
    assert.equal((await stat(configurationPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
