import { describe, expect, it } from "vitest";
import {
  authorizeSiteCommand,
  browserCommandSchema,
  signedCommandEnvelopeSchema,
} from "../commands.js";

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
    const input = {
      capability: "FIXTURE_INPUT",
      field: "IDENTIFIER",
      value: "fixture-user",
    } as const;
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
});
