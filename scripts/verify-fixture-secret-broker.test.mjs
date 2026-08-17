import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixtureSecretBrokerEvidence,
  runBoundedProcess,
  scanFixtureSecretSinks,
} from "./verify-fixture-secret-broker.mjs";

const passingReport = {
  status: "PASS",
  authorizationResult: "OK",
  approvedFieldFilled: true,
  approvedDestinationRequest: true,
  requestCount: 2,
  destinationRequestCount: 1,
  nonDestinationRequests: 0,
  secretBufferCleared: true,
  clipboardUnchanged: true,
  devToolsOpened: false,
  browserStorageSeeded: true,
  permissionPolicyEnforced: true,
  browserCrashFenced: true,
  browserCrashWaiting: true,
  trustedRendererRecovered: true,
  crashDiagnosticsBounded: true,
  crashDumpSinkScoped: true,
  bindingMatrixRejected: true,
  absentTokenRejected: true,
  expiredTokenRejected: true,
  replayRejected: true,
  mainProcessRequestPathUsed: true,
  cancelPreservedProfile: true,
  partialFailureObserved: true,
  erasureStaged: true,
  automationFenced: true,
  credentialReferenceRevoked: true,
  credentialAbsent: true,
  targetPresentUntilRestart: true,
};
const passingRestartReport = {
  targetAbsentAfterRestart: true,
  targetLockAbsentAfterRestart: true,
  siblingCookiePreserved: true,
  siblingLocalStoragePreserved: true,
  siblingIndexedDbPreserved: true,
  siblingCachePreserved: true,
  siblingPermissionPolicyPreserved: true,
  siblingJournalPreserved: true,
  siblingVaultReferencePreserved: true,
  credentialReferenceAbsentAfterRestart: true,
  pendingErasureConsumed: true,
};

test("accepts exact destination-only packaged evidence", () => {
  assert.deepEqual(
    assertFixtureSecretBrokerEvidence(
      passingReport,
      { matches: [] },
      passingRestartReport,
    ),
    passingReport,
  );
});

test("detects the decimal byte-array encoding sent through CDP", async () => {
  const secret = "fixture-decimal-secret";
  const decimalBytes = Buffer.from(secret).join(",");
  assert.deepEqual(
    await scanFixtureSecretSinks(secret, [
      { name: "debugger-payload", value: `{"value":[${decimalBytes}]}` },
    ]),
    { matches: [{ sink: "debugger-payload", variant: "decimal-bytes" }] },
  );
});

test("detects every declared packaged sink encoding", async () => {
  const secret = "fixture secret/?";
  const bytes = Buffer.from(secret);
  const cases = [
    ["plaintext", secret],
    ["base64", bytes.toString("base64")],
    ["base64url", bytes.toString("base64url")],
    ["url-encoded", encodeURIComponent(secret)],
    ["hex", bytes.toString("hex")],
    ["decimal-bytes", [...bytes].join(",")],
    ["decimal-bytes-spaced", [...bytes].join(", ")],
  ];
  for (const [variant, value] of cases) {
    const result = await scanFixtureSecretSinks(secret, [
      { name: variant, value },
    ]);
    assert.ok(
      result.matches.some(
        (match) => match.sink === variant && match.variant === variant,
      ),
      `${variant} was not detected`,
    );
  }
});

test("hard-kills a packaged process that ignores the bounded timeout", async () => {
  await assert.rejects(
    runBoundedProcess(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)',
      ],
      { timeoutMs: 25 },
    ),
    /PACKAGED_FIXTURE_SECRET_TIMEOUT/,
  );
});

test("rejects leaked or broadened packaged evidence", () => {
  assert.throws(
    () =>
      assertFixtureSecretBrokerEvidence(
        passingReport,
        {
          matches: [{ sink: "stderr", variant: "plaintext" }],
        },
        passingRestartReport,
      ),
    /PACKAGED_FIXTURE_SECRET_LEAKED/,
  );
  assert.throws(
    () =>
      assertFixtureSecretBrokerEvidence(
        { ...passingReport, nonDestinationRequests: 1 },
        { matches: [] },
        passingRestartReport,
      ),
    /PACKAGED_FIXTURE_SECRET_DESTINATION_NOT_EXCLUSIVE/,
  );
  assert.throws(
    () =>
      assertFixtureSecretBrokerEvidence(
        { ...passingReport, crashDumpSinkScoped: false },
        { matches: [] },
        passingRestartReport,
      ),
    /PACKAGED_FIXTURE_SECRET_EVIDENCE_INCOMPLETE/,
  );
  assert.throws(
    () =>
      assertFixtureSecretBrokerEvidence(
        passingReport,
        { matches: [] },
        { ...passingRestartReport, siblingCookiePreserved: false },
      ),
    /PACKAGED_FIXTURE_SESSION_ERASURE_INCOMPLETE/,
  );
});
