import { describe, expect, it } from "vitest";
import { redactBrowserObservation } from "../src/browser/redaction-policy.js";
import { classifyOwnedFixtureChallenge } from "../../../packages/test-auth-site/src/challenges.js";

describe("U5 leakage corpus", () => {
  it("keeps plaintext and encoded variants out of every serializable sink", () => {
    const plaintext = "u5-secret-9d27f0-password";
    const variants = [
      plaintext,
      Buffer.from(plaintext).toString("base64"),
      Buffer.from(plaintext).toString("base64url"),
      encodeURIComponent(plaintext),
      Buffer.from(plaintext).toString("hex"),
    ];
    const observation = redactBrowserObservation({
      canonicalOrigin: "https://fixture.village.test",
      authState: "SIGNED_OUT",
      challenge: "UNKNOWN_CHALLENGE",
      visibleApprovedFieldCount: 1,
      title: variants[0],
      query: variants[1],
      hash: variants[2],
      ariaText: variants[3],
      hiddenValue: variants[4],
    });
    const prohibitedSinks = {
      modelPayload: JSON.stringify(observation),
      ipcResponse: JSON.stringify({ observation }),
      jobEvent: JSON.stringify({ payload: observation }),
      log: JSON.stringify(observation),
      telemetry: JSON.stringify({ attributes: observation }),
      screenshotMetadata: JSON.stringify({ observation }),
      crashFixture: JSON.stringify({ context: observation }),
    };
    for (const serialized of Object.values(prohibitedSinks)) {
      for (const variant of variants) expect(serialized).not.toContain(variant);
    }
  });

  it("classifies every typed challenge and unknown challenges as owner-only", () => {
    for (const kind of [
      "CREDENTIAL",
      "CAPTCHA",
      "PASSKEY",
      "TWO_FACTOR",
      "PASSWORD_RESET",
      "FEDERATED_IDENTITY",
      "TERMS_OR_CONSENT",
      "SECURITY_WARNING",
    ] as const) {
      expect(classifyOwnedFixtureChallenge({ kind })).toEqual({
        reason: kind,
        resolver: "OWNER_ONLY",
        automationAllowed: false,
      });
    }
    expect(
      classifyOwnedFixtureChallenge({ kind: "new-page-authored-challenge" }),
    ).toEqual({
      reason: "UNKNOWN_CHALLENGE",
      resolver: "OWNER_ONLY",
      automationAllowed: false,
    });
  });

  it("does not execute hostile accessors while deriving closed facts", () => {
    const hostile = {
      canonicalOrigin: "https://fixture.village.test",
      authState: "SIGNED_OUT",
      challenge: "UNKNOWN_CHALLENGE",
      visibleApprovedFieldCount: 0,
    };
    Object.defineProperty(hostile, "title", {
      enumerable: true,
      get() {
        throw new Error("page getter executed");
      },
    });
    expect(() => redactBrowserObservation(hostile)).not.toThrow();
  });
});
