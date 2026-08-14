import { describe, expect, it } from "vitest";
import {
  authorizeSiteCommand,
  browserCommandSchema,
  ownedFixtureSetupCommandSchema,
  signedCommandEnvelopeSchema,
} from "../commands.js";
import { canonicalCommandEnvelopeBytes } from "../signatures.js";

const workflowBinding = {
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
  workflowVersion: 1,
  jobRevision: 3,
  logicalStep: "SET_DISPLAY_NAME",
  effectId: "efx_01J00000000000000000000000",
} as const;

describe("browser command grammar", () => {
  it("rejects raw destinations, selectors, scripts, CDP, and unknown fields", () => {
    for (const command of [
      { capability: "NAVIGATE", destination: "https://evil.example" },
      {
        capability: "FIXTURE_INPUT",
        field: "IDENTIFIER",
        value: "safe",
        selector: "#password",
      },
      { capability: "EVALUATE", script: "document.cookie" },
      { capability: "CDP", method: "Runtime.evaluate" },
    ]) {
      expect(browserCommandSchema.safeParse(command).success).toBe(false);
    }

    const envelope = {
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 4,
      sequence: 9,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:10.000Z",
      command: { capability: "OBSERVE", facts: ["AUTH_STATE"] },
      signature: "c2lnbmF0dXJl",
      extra: true,
    };
    const { extra: _extra, ...cleanEnvelope } = envelope;
    expect(signedCommandEnvelopeSchema.safeParse(cleanEnvelope).success).toBe(
      true,
    );
    expect(signedCommandEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it("keeps LinkedIn human-only while allowing fixture composition", () => {
    const input = { capability: "REPLACE_DISPLAY_NAME" } as const;
    expect(authorizeSiteCommand("OWNED_FIXTURE", input)).toEqual({ ok: true });
    expect(authorizeSiteCommand("LINKEDIN", input)).toEqual({
      ok: false,
      code: "SITE_CAPABILITY_DENIED",
    });
    expect(
      authorizeSiteCommand("LINKEDIN", {
        capability: "NAVIGATE",
        destination: "FIXTURE_SIGN_IN",
      }),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
    expect(
      authorizeSiteCommand("LINKEDIN", {
        capability: "REQUEST_HUMAN_GATE",
        reason: "TWO_FACTOR",
      }),
    ).toEqual({ ok: false, code: "SITE_CAPABILITY_DENIED" });
    expect(
      authorizeSiteCommand("OWNED_FIXTURE", {
        capability: "REQUEST_SECRET_FILL",
        credentialSlot: "SITE_PRIMARY_CREDENTIAL",
        field: "PASSWORD",
      }),
    ).toEqual({ ok: false, code: "OWNER_APPROVAL_REQUIRED" });
    expect(
      authorizeSiteCommand(
        "OWNED_FIXTURE",
        {
          capability: "REQUEST_SECRET_FILL",
          credentialSlot: "SITE_PRIMARY_CREDENTIAL",
          field: "PASSWORD",
        },
        { ownerPresent: true },
      ),
    ).toEqual({ ok: true });
  });

  it("accepts only objective-specific setup actions", () => {
    for (const command of [
      { capability: "OBSERVE_SETUP" },
      { capability: "REPLACE_DISPLAY_NAME" },
      { capability: "SELECT_ROLE" },
      { capability: "REPLACE_PREFERRED_FOCUS" },
      { capability: "FINALIZE_SETUP" },
      { capability: "VERIFY_SETUP" },
    ]) {
      expect(ownedFixtureSetupCommandSchema.safeParse(command).success).toBe(
        true,
      );
    }
    for (const command of [
      { capability: "FIXTURE_INPUT", field: "NON_SECRET_TEXT", value: "x" },
      { capability: "REPLACE_DISPLAY_NAME", value: "private profile value" },
      { capability: "SELECT_ROLE", selector: "#admin" },
      { capability: "FINALIZE_SETUP", destination: "https://linkedin.com" },
    ]) {
      expect(ownedFixtureSetupCommandSchema.safeParse(command).success).toBe(
        false,
      );
    }
  });

  it("requires setup commands to carry stable workflow identity", () => {
    const envelope = {
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 4,
      sequence: 9,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:10.000Z",
      ...workflowBinding,
      command: { capability: "REPLACE_DISPLAY_NAME" },
      signature: "c2lnbmF0dXJl",
    };
    expect(signedCommandEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      signedCommandEnvelopeSchema.safeParse({
        ...envelope,
        actionId: "act_01J00000000000000000000001",
      }).success,
    ).toBe(true);
    const { effectId: _effectId, ...missingEffect } = envelope;
    expect(signedCommandEnvelopeSchema.safeParse(missingEffect).success).toBe(
      false,
    );
    expect(
      signedCommandEnvelopeSchema.safeParse({
        ...envelope,
        workflowVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      signedCommandEnvelopeSchema.safeParse({
        ...envelope,
        command: { capability: "FINALIZE_SETUP" },
      }).success,
    ).toBe(false);
  });

  it("cryptographically binds setup revision, step, and effect identity", () => {
    const unsigned = {
      protocolVersion: 1,
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      actionId: "act_01J00000000000000000000000",
      leaseEpoch: 4,
      sequence: 9,
      issuedAt: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:10.000Z",
      ...workflowBinding,
      command: { capability: "REPLACE_DISPLAY_NAME" },
    } as const;
    const canonical = new Uint8Array(canonicalCommandEnvelopeBytes(unsigned));
    expect(
      new Uint8Array(
        canonicalCommandEnvelopeBytes({
          ...unsigned,
          effectId: "efx_01J00000000000000000000001",
        }),
      ),
    ).not.toEqual(canonical);
    expect(
      new Uint8Array(
        canonicalCommandEnvelopeBytes({
          ...unsigned,
          jobRevision: unsigned.jobRevision + 1,
        }),
      ),
    ).not.toEqual(canonical);
  });

  it("never authorizes setup semantics for LinkedIn", () => {
    for (const capability of [
      "OBSERVE_SETUP",
      "REPLACE_DISPLAY_NAME",
      "SELECT_ROLE",
      "REPLACE_PREFERRED_FOCUS",
      "FINALIZE_SETUP",
      "VERIFY_SETUP",
    ] as const) {
      expect(authorizeSiteCommand("LINKEDIN", { capability })).toEqual({
        ok: false,
        code: "SITE_CAPABILITY_DENIED",
      });
    }
  });
});
