import { describe, expect, it } from "vitest";
import {
  authorizeAgentBrowserTool,
  nextOwnedFixtureAction,
  reconcileOwnedFixtureSubmit,
} from "../../agent/browser-tools.js";
import { authorizeBrowserSiteAction } from "../site-policies.js";

describe("owned fixture sign-in orchestration", () => {
  it("keeps the agent inside closed lifecycle tools", () => {
    expect(
      authorizeAgentBrowserTool("OWNED_FIXTURE", {
        capability: "NAVIGATE",
        destination: "FIXTURE_SIGN_IN",
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeAgentBrowserTool("OWNED_FIXTURE", {
        capability: "REPLACE_DISPLAY_NAME",
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeAgentBrowserTool("OWNED_FIXTURE", {
        capability: "REPLACE_DISPLAY_NAME",
        value: "must-remain-local",
      }),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
    expect(
      authorizeAgentBrowserTool("OWNED_FIXTURE", {
        capability: "REQUEST_SECRET_FILL",
        credentialSlot: "SITE_PRIMARY_CREDENTIAL",
        field: "PASSWORD",
      }),
    ).toEqual({ ok: false, code: "OWNER_APPROVAL_REQUIRED" });
    expect(
      authorizeAgentBrowserTool("OWNED_FIXTURE", {
        capability: "REQUEST_HUMAN_GATE",
        reason: "TWO_FACTOR",
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeAgentBrowserTool("OWNED_FIXTURE", {
        capability: "RAW_CDP",
        method: "Runtime.evaluate",
      }),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
  });

  it("keeps LinkedIn human-only and separates forget-session", () => {
    expect(
      authorizeAgentBrowserTool("LINKEDIN", {
        capability: "OBSERVE",
        facts: ["AUTH_STATE"],
      }),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
    expect(authorizeBrowserSiteAction("LINKEDIN", "OPEN_SIGN_IN")).toEqual({
      ok: true,
    });
    expect(authorizeBrowserSiteAction("LINKEDIN", "AUTOMATED_INPUT")).toEqual({
      ok: false,
      code: "LINKEDIN_HUMAN_ONLY",
    });
    expect(authorizeBrowserSiteAction("LINKEDIN", "FORGET_SESSION")).toEqual({
      ok: false,
      code: "STEP_UP_LIFECYCLE_REQUIRED",
    });
  });

  it("fails closed when a gate fact or site action is unknown", () => {
    const observation = {
      schemaVersion: 1 as const,
      source: "BROWSER_UNTRUSTED" as const,
      canonicalOrigin: "https://fixture.village.test",
      predicateIds: [],
      facts: [
        { id: "AUTH_STATE" as const, value: "SIGNED_OUT" as const },
        { id: "APPROVED_ACTION_AVAILABLE" as const, value: true },
      ],
    };
    expect(nextOwnedFixtureAction(observation)).toEqual({
      capability: "REQUEST_HUMAN_GATE",
      reason: "UNKNOWN_CHALLENGE",
    });
    expect(
      authorizeBrowserSiteAction(
        "OWNED_FIXTURE",
        "UNKNOWN_ACTION" as unknown as Parameters<
          typeof authorizeBrowserSiteAction
        >[1],
      ),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
  });

  it("raises typed gates and reconciles a lost submit acknowledgement without duplicate input", () => {
    const observation = {
      schemaVersion: 1 as const,
      source: "BROWSER_UNTRUSTED" as const,
      canonicalOrigin: "https://fixture.village.test",
      predicateIds: ["fixture-two-factor-v1"],
      facts: [
        { id: "AUTH_STATE" as const, value: "UNKNOWN" as const },
        { id: "HUMAN_GATE" as const, value: "TWO_FACTOR" as const },
        { id: "APPROVED_ACTION_AVAILABLE" as const, value: false },
      ],
    };
    expect(nextOwnedFixtureAction(observation)).toEqual({
      capability: "REQUEST_HUMAN_GATE",
      reason: "TWO_FACTOR",
    });
    expect(reconcileOwnedFixtureSubmit("SATISFIED")).toBe("RECEIPTED");
    expect(reconcileOwnedFixtureSubmit("UNKNOWN")).toBe("WAITING_FOR_USER");
    expect(reconcileOwnedFixtureSubmit("NOT_SATISFIED")).toBe(
      "WAITING_FOR_USER",
    );
  });
});
