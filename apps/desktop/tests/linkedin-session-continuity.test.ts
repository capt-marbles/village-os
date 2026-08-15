import { describe, expect, it, vi } from "vitest";
import { SensitiveActionAuthorizer } from "../src/main/sensitive-action-authorizer.js";
import {
  InMemoryContinuityReplayStore,
  LinkedInSessionContinuityImporter,
} from "../src/main/linkedin-session-continuity.js";

const binding = {
  principalId: "prn_01J00000000000000000000000",
  sourceDeviceId: "dev_01J00000000000000000000001",
  destinationDeviceId: "dev_01J00000000000000000000002",
  browserSessionId: "brs_01J00000000000000000000000",
};

const envelope = {
  schemaVersion: 1 as const,
  transferId: "ctf_01J00000000000000000000000",
  ...binding,
  site: "LINKEDIN" as const,
  issuedAt: "2026-08-15T18:00:00.000Z",
  expiresAt: "2026-08-15T18:01:00.000Z",
  cookies: [
    {
      name: "li_at",
      value: "opaque-session-value",
      domain: ".linkedin.com" as const,
      path: "/",
      secure: true as const,
      httpOnly: true,
      sameSite: "no_restriction" as const,
      expirationDate: 1_800_000_000,
      hostOnly: false,
    },
    {
      name: "JSESSIONID",
      value: "opaque-csrf-value",
      domain: "www.linkedin.com" as const,
      path: "/",
      secure: true as const,
      httpOnly: false,
      sameSite: "lax" as const,
      expirationDate: 1_800_000_000,
      hostOnly: true,
    },
  ],
  signature: "c2lnbmF0dXJl",
};

function createHarness() {
  const now = vi.fn(() => Date.parse("2026-08-15T18:00:30.000Z"));
  const authorizer = new SensitiveActionAuthorizer(now);
  const cookies = {
    set: vi.fn(async () => undefined),
    flushStore: vi.fn(async () => undefined),
  };
  const verifyEnvelope = vi.fn(async () => true);
  const replayStore = new InMemoryContinuityReplayStore();
  const importer = new LinkedInSessionContinuityImporter({
    destination: { cookies },
    destinationBinding: {
      principalId: binding.principalId,
      deviceId: binding.destinationDeviceId,
      browserSessionId: binding.browserSessionId,
    },
    authorizer,
    verifyEnvelope,
    replayStore,
    now,
  });
  const authorization = authorizer.mint(
    {
      principalId: binding.principalId,
      deviceId: binding.destinationDeviceId,
      browserSessionId: binding.browserSessionId,
      operation: "IMPORT_SITE_SESSION",
    },
    60_000,
  );
  return { authorization, cookies, importer, replayStore, verifyEnvelope };
}

describe("LinkedIn Site Session continuity import", () => {
  it("imports an authenticated, owner-approved batch into the exact Electron cookie store", async () => {
    const { authorization, cookies, importer, verifyEnvelope } =
      createHarness();

    await expect(
      importer.import(envelope, authorization.token),
    ).resolves.toEqual({
      importedCookieCount: 2,
      transferId: envelope.transferId,
    });

    expect(verifyEnvelope).toHaveBeenCalledWith(envelope);
    expect(cookies.set).toHaveBeenNthCalledWith(1, {
      url: "https://linkedin.com/",
      name: "li_at",
      value: envelope.cookies[0]?.value,
      domain: ".linkedin.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expirationDate: 1_800_000_000,
    });
    expect(cookies.set).toHaveBeenNthCalledWith(2, {
      url: "https://www.linkedin.com/",
      name: "JSESSIONID",
      value: envelope.cookies[1]?.value,
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: 1_800_000_000,
    });
    expect(cookies.flushStore).toHaveBeenCalledOnce();
  });

  it("rejects hostile cookie scope before authorization or destination mutation", async () => {
    const { authorization, cookies, importer, verifyEnvelope } =
      createHarness();
    const hostile = {
      ...envelope,
      cookies: [{ ...envelope.cookies[0], domain: ".example.com" }],
    };

    await expect(importer.import(hostile, authorization.token)).rejects.toThrow(
      "CONTINUITY_ENVELOPE_INVALID",
    );
    expect(verifyEnvelope).not.toHaveBeenCalled();
    expect(cookies.set).not.toHaveBeenCalled();
    expect(cookies.flushStore).not.toHaveBeenCalled();
  });

  it("rejects a host-only cookie disguised with a parent-domain scope", async () => {
    const { authorization, cookies, importer, verifyEnvelope } =
      createHarness();
    const invalidScope = {
      ...envelope,
      cookies: [{ ...envelope.cookies[0], hostOnly: true }],
    };

    await expect(
      importer.import(invalidScope, authorization.token),
    ).rejects.toThrow("CONTINUITY_ENVELOPE_INVALID");
    expect(verifyEnvelope).not.toHaveBeenCalled();
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("fails closed for wrong-device, unauthenticated, expired, and replayed transfers", async () => {
    const wrongDevice = createHarness();
    await expect(
      wrongDevice.importer.import(
        { ...envelope, destinationDeviceId: "dev_01J00000000000000000000003" },
        wrongDevice.authorization.token,
      ),
    ).rejects.toThrow("CONTINUITY_DESTINATION_MISMATCH");
    expect(wrongDevice.cookies.set).not.toHaveBeenCalled();

    const unauthenticated = createHarness();
    unauthenticated.verifyEnvelope.mockResolvedValue(false);
    await expect(
      unauthenticated.importer.import(
        envelope,
        unauthenticated.authorization.token,
      ),
    ).rejects.toThrow("CONTINUITY_ENVELOPE_UNAUTHENTICATED");
    expect(unauthenticated.cookies.set).not.toHaveBeenCalled();

    const expired = createHarness();
    await expect(
      expired.importer.import(
        {
          ...envelope,
          expiresAt: "2026-08-15T18:00:29.000Z",
        },
        expired.authorization.token,
      ),
    ).rejects.toThrow("CONTINUITY_ENVELOPE_EXPIRED");
    expect(expired.cookies.set).not.toHaveBeenCalled();

    const replayed = createHarness();
    await replayed.replayStore.claim(envelope.transferId);
    await expect(
      replayed.importer.import(envelope, replayed.authorization.token),
    ).rejects.toThrow("CONTINUITY_ENVELOPE_REPLAYED");
    expect(replayed.cookies.set).not.toHaveBeenCalled();
  });

  it("never exposes raw cookie material in its result or failure messages", async () => {
    const success = createHarness();
    const result = await success.importer.import(
      envelope,
      success.authorization.token,
    );
    expect(JSON.stringify(result)).not.toContain("opaque-session-value");

    const failed = createHarness();
    failed.cookies.set.mockRejectedValueOnce(new Error("destination failed"));
    await expect(
      failed.importer.import(envelope, failed.authorization.token),
    ).rejects.toThrow("CONTINUITY_IMPORT_OUTCOME_UNKNOWN");
    expect(failed.cookies.flushStore).not.toHaveBeenCalled();
  });
});
