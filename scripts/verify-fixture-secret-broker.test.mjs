import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixtureSecretBrokerEvidence,
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
};

test("accepts exact destination-only packaged evidence", () => {
  assert.deepEqual(
    assertFixtureSecretBrokerEvidence(passingReport, { matches: [] }),
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

test("rejects leaked or broadened packaged evidence", () => {
  assert.throws(
    () =>
      assertFixtureSecretBrokerEvidence(passingReport, {
        matches: [{ sink: "stderr", variant: "plaintext" }],
      }),
    /PACKAGED_FIXTURE_SECRET_LEAKED/,
  );
  assert.throws(
    () =>
      assertFixtureSecretBrokerEvidence(
        { ...passingReport, nonDestinationRequests: 1 },
        { matches: [] },
      ),
    /PACKAGED_FIXTURE_SECRET_DESTINATION_NOT_EXCLUSIVE/,
  );
});
