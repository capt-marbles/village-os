import { describe, expect, it } from "vitest";
import { assertPackagedSiteSessionContinuity } from "../../../scripts/verify-site-session-continuity.mjs";

describe("packaged two-profile Site Session continuity evidence", () => {
  it("requires twenty transfers, restart persistence, logout, and revocation", () => {
    expect(() =>
      assertPackagedSiteSessionContinuity({
        status: "PASS",
        transfersApplied: 20,
        duplicateEffects: 0,
        restartRevision: 21,
        authenticatedAfterRestart: false,
        logoutPropagated: true,
        revokedFetchRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
      }),
    ).not.toThrow();
    expect(() =>
      assertPackagedSiteSessionContinuity({
        status: "PASS",
        transfersApplied: 19,
        duplicateEffects: 0,
        restartRevision: 21,
        authenticatedAfterRestart: false,
        logoutPropagated: true,
        revokedFetchRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
      }),
    ).toThrow("PACKAGED_CONTINUITY_TRANSFER_COUNT_INVALID");
  });
});
