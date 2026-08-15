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
        revokedActivationAbsent: true,
        revokedFetchRejected: true,
        badSignatureRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
        responseLossesObserved: 1,
        acknowledgedRevision: 21,
        restartNoNewRevision: true,
        sourceActivationRequests: 1,
        destinationActivationRequests: 1,
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
        revokedActivationAbsent: true,
        revokedFetchRejected: true,
        badSignatureRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
        responseLossesObserved: 1,
        acknowledgedRevision: 21,
        restartNoNewRevision: true,
        sourceActivationRequests: 1,
        destinationActivationRequests: 1,
      }),
    ).toThrow("PACKAGED_CONTINUITY_TRANSFER_COUNT_INVALID");
    expect(() =>
      assertPackagedSiteSessionContinuity({
        status: "PASS",
        transfersApplied: 20,
        duplicateEffects: 0,
        restartRevision: 21,
        authenticatedAfterRestart: false,
        logoutPropagated: true,
        revokedActivationAbsent: true,
        revokedFetchRejected: true,
        badSignatureRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
        responseLossesObserved: 0,
        acknowledgedRevision: 21,
        restartNoNewRevision: true,
        sourceActivationRequests: 1,
        destinationActivationRequests: 1,
      }),
    ).toThrow("PACKAGED_CONTINUITY_RESPONSE_LOSS_NOT_PROVEN");

    expect(() =>
      assertPackagedSiteSessionContinuity({
        status: "PASS",
        transfersApplied: 20,
        duplicateEffects: 0,
        restartRevision: 21,
        authenticatedAfterRestart: false,
        logoutPropagated: true,
        revokedActivationAbsent: true,
        revokedFetchRejected: true,
        badSignatureRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
        responseLossesObserved: 1,
        acknowledgedRevision: 21,
        restartNoNewRevision: true,
        sourceActivationRequests: 0,
        destinationActivationRequests: 0,
      }),
    ).toThrow("PACKAGED_CONTINUITY_ACTIVATION_PATH_MISSING");

    expect(() =>
      assertPackagedSiteSessionContinuity({
        status: "PASS",
        transfersApplied: 20,
        duplicateEffects: 0,
        restartRevision: 21,
        authenticatedAfterRestart: false,
        logoutPropagated: true,
        revokedActivationAbsent: true,
        revokedFetchRejected: false,
        badSignatureRejected: true,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
        responseLossesObserved: 1,
        acknowledgedRevision: 21,
        restartNoNewRevision: true,
        sourceActivationRequests: 1,
        destinationActivationRequests: 1,
      }),
    ).toThrow("PACKAGED_CONTINUITY_REVOCATION_FAILED");

    expect(() =>
      assertPackagedSiteSessionContinuity({
        status: "PASS",
        transfersApplied: 20,
        duplicateEffects: 0,
        restartRevision: 21,
        authenticatedAfterRestart: false,
        logoutPropagated: true,
        revokedActivationAbsent: true,
        revokedFetchRejected: true,
        badSignatureRejected: false,
        sourceProfileDistinct: true,
        destinationProfileDistinct: true,
        plaintextMailboxOccurrences: 0,
        keychainMode: "MOCK_TEST_ONLY",
        responseLossesObserved: 1,
        acknowledgedRevision: 21,
        restartNoNewRevision: true,
        sourceActivationRequests: 1,
        destinationActivationRequests: 1,
      }),
    ).toThrow("PACKAGED_CONTINUITY_ACTIVATION_AUTH_NOT_PROVEN");
  });
});
