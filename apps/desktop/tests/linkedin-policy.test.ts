import { describe, expect, it } from "vitest";
import { verifyAuthentication } from "../src/browser/auth-verifier.js";
import {
  authorizeLinkedInNavigation,
  classifyLinkedInRoute,
  linkedInPolicy,
} from "../src/browser/sites/linkedin.js";

describe("LinkedIn human-only policy", () => {
  it("permits visible sign-in but keeps identity redirects human-only and mediated", () => {
    expect(linkedInPolicy).toMatchObject({
      automation: "HUMAN_ONLY",
      debuggerAttachmentAllowed: false,
      repeatedLoginAllowed: false,
      autonomousCredentialSubmissionAllowed: false,
      autonomousPostLoginActionsAllowed: false,
      distribution: "REQUIRES_WRITTEN_TERMS_REVIEW",
    });
    for (const action of [
      "SCRAPE",
      "MESSAGE",
      "POST",
      "REACT",
      "CONNECT",
      "OWNED_FIXTURE_SETUP",
      "REQUEST_SECRET_FILL",
      "RAW_CDP",
    ]) {
      expect(linkedInPolicy.authorizeAction(action)).toEqual({
        ok: false,
        code: "LINKEDIN_HUMAN_ONLY",
      });
    }
    expect(classifyLinkedInRoute("https://www.linkedin.com/login")).toBe(
      "SIGN_IN",
    );
    expect(
      classifyLinkedInRoute("https://accounts.google.com/o/oauth2/v2/auth"),
    ).toBe("FEDERATED_IDENTITY");
    expect(
      classifyLinkedInRoute("https://www.linkedin.com/checkpoint/challenge"),
    ).toBe("HUMAN_CHALLENGE");
    expect(
      authorizeLinkedInNavigation(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=local",
      ),
    ).toEqual({ allow: false, code: "LINKEDIN_DESTINATION_DENIED" });
    expect(
      authorizeLinkedInNavigation("https://attacker.invalid/login"),
    ).toEqual({ allow: false, code: "LINKEDIN_DESTINATION_DENIED" });
    expect(linkedInPolicy.authorizeAction("OPEN_SIGN_IN")).toEqual({
      ok: true,
    });
  });

  it("verifies conservatively without a debugger and preserves owner confirmation", () => {
    expect(
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/feed/",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: false,
      }),
    ).toEqual({ status: "unknown", predicateVersion: "linkedin-route-v1" });
    expect(
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/in/public-profile",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: false,
      }),
    ).toEqual({ status: "unknown", predicateVersion: "linkedin-route-v1" });
    expect(
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/checkpoint/challenge",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: false,
      }),
    ).toEqual({ status: "unknown", predicateVersion: "linkedin-route-v1" });
    expect(
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/feed/",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: false,
        ownerDecision: "CONFIRM",
        expectedAccountAmbiguous: true,
      }),
    ).toEqual({
      status: "confirmed_by_user",
      predicateVersion: "linkedin-route-v1",
    });
    expect(() =>
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/feed/",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: true,
      }),
    ).toThrow("LINKEDIN_DEBUGGER_ATTACHMENT_DENIED");
    expect(() =>
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/login",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: false,
        ownerDecision: "CONFIRM",
      }),
    ).toThrow("OWNER_CONFIRMATION_NOT_APPLICABLE");
    expect(
      verifyAuthentication({
        site: "LINKEDIN",
        url: "https://www.linkedin.com/login",
        predicateVersion: "linkedin-route-v1",
        debuggerAttached: false,
        ownerDecision: "CONFIRM",
        expectedAccountAmbiguous: true,
      }),
    ).toEqual({
      status: "not_authenticated",
      predicateVersion: "linkedin-route-v1",
    });
  });

  it("verifies owned fixture outcomes explicitly", () => {
    for (const [fixturePredicate, status] of [
      ["AUTHENTICATED", "authenticated"],
      ["NOT_AUTHENTICATED", "not_authenticated"],
      ["UNKNOWN", "unknown"],
    ] as const) {
      expect(
        verifyAuthentication({
          site: "OWNED_FIXTURE",
          url: "https://fixture.village.test/account",
          predicateVersion: "fixture-auth-v1",
          debuggerAttached: false,
          fixturePredicate,
        }),
      ).toEqual({ status, predicateVersion: "fixture-auth-v1" });
    }

    for (const url of ["https://attacker.invalid/account", "not a url"]) {
      expect(
        verifyAuthentication({
          site: "OWNED_FIXTURE",
          url,
          predicateVersion: "fixture-auth-v1",
          debuggerAttached: false,
          fixturePredicate: "AUTHENTICATED",
        }),
      ).toEqual({ status: "unknown", predicateVersion: "fixture-auth-v1" });
    }
  });
});
