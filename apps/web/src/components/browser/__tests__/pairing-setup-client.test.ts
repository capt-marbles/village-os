import { describe, expect, it, vi } from "vitest";
import {
  PairingSetupClient,
  pairingCompletionUrl,
  pairingSessionUrl,
  parsePublicPairingRequest,
} from "../pairing-setup-client.js";

const publicRequest = {
  deviceId: "dev_01J00000000000000000000000",
  deviceDisplayName: "Andrew's Mac",
  publicKey: {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: "cHVibGljX2tleQ",
  },
  protection: "OS_PROTECTED_FALLBACK" as const,
  secretHash: "a".repeat(43),
};
const challenge = {
  principalId: "prn_01J00000000000000000000000",
  pairingId: "par_01J00000000000000000000000",
  deviceId: publicRequest.deviceId,
  fingerprint: "A1B2C3D4E5F60708",
  expiresAt: "2026-08-13T13:05:00.000Z",
};

describe("pairing setup client", () => {
  it("accepts only an exact public request and never requires the secret", () => {
    expect(parsePublicPairingRequest(JSON.stringify(publicRequest))).toEqual(
      publicRequest,
    );
    expect(() =>
      parsePublicPairingRequest(
        JSON.stringify({ ...publicRequest, secret: "do-not-send" }),
      ),
    ).toThrow("PAIRING_REQUEST_INVALID");
  });

  it("begins, confirms, polls, and creates a LinkedIn session with CSRF", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ok: true, ...challenge }, { status: 201 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, pairing: { state: "CONSUMED" } }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { ok: true, jobId: "job_01J00000000000000000000000" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 201 }));
    const client = new PairingSetupClient(
      "https://village.test",
      request,
      () => "csrf-token-that-is-at-least-thirty-two-bytes-long",
    );

    await expect(client.begin(publicRequest)).resolves.toEqual(challenge);
    await client.confirm(challenge.pairingId);
    await expect(client.status(challenge.pairingId)).resolves.toBe("CONSUMED");
    const session = await client.createSession(publicRequest.deviceId);

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://village.test/api/pairing/challenges",
      `https://village.test/api/pairing/${challenge.pairingId}/confirm`,
      `https://village.test/api/pairing/${challenge.pairingId}`,
      "https://village.test/api/jobs",
      "https://village.test/api/jobs/job_01J00000000000000000000000/browser-sessions",
    ]);
    const sessionBody = JSON.parse(String(request.mock.calls[4]![1]?.body));
    expect(sessionBody).toMatchObject({
      deviceId: publicRequest.deviceId,
      site: "LINKEDIN",
    });
    expect(session.browserSessionId).toMatch(/^brs_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(session.hostId).toMatch(/^hst_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      new Headers(request.mock.calls[0]![1]?.headers).get("x-village-csrf"),
    ).toBe("csrf-token-that-is-at-least-thirty-two-bytes-long");
  });

  it("builds credential-free custom protocol links", () => {
    const completion = pairingCompletionUrl(challenge);
    const session = pairingSessionUrl(challenge, {
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
      hostId: "hst_01J00000000000000000000000",
    });
    expect(completion).toContain(`pairingId=${challenge.pairingId}`);
    expect(session).toContain(
      "browserSessionId=brs_01J00000000000000000000000",
    );
    expect(`${completion}${session}`).not.toContain("secret");
  });
});
