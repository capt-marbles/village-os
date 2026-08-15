import { describe, expect, it, vi } from "vitest";
import { ContinuitySetupClient } from "../continuity-setup-client.js";

const source = {
  deviceId: "dev_01J00000000000000000000001",
  browserSessionId: "brs_01J00000000000000000000001",
  deviceName: "Studio Mac",
  connection: "ONLINE" as const,
  recipientKeyState: "MISSING" as const,
};
const destination = {
  deviceId: "dev_01J00000000000000000000002",
  browserSessionId: "brs_01J00000000000000000000002",
  deviceName: "Travel Mac",
  connection: "OFFLINE" as const,
  recipientKeyState: "READY" as const,
};
const csrf = "csrf-token-that-is-at-least-thirty-two-bytes-long";

describe("continuity setup client", () => {
  it("loads only the sanitized owner setup projection", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, sessions: [source, destination], grants: [] }),
    );
    const client = new ContinuitySetupClient("https://village.test", request);

    await expect(client.load()).resolves.toEqual({
      ok: true,
      sessions: [source, destination],
      grants: [],
    });
    expect(String(request.mock.calls[0]![0])).toBe(
      "https://village.test/api/site-session-continuity/setup",
    );

    const hostile = new ContinuitySetupClient(
      "https://village.test",
      vi.fn(async () =>
        Response.json({
          ok: true,
          sessions: [
            { ...destination, encryptionPublicKey: "must-not-render" },
          ],
          grants: [],
        }),
      ),
    );
    await expect(hostile.load()).rejects.toThrow(
      "CONTINUITY_SETUP_RESPONSE_INVALID",
    );
  });

  it("creates a seven-day one-way fixture grant without accepting a key", async () => {
    const grantId = "cgr_01J00000000000000000000009";
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          ok: true,
          created: true,
          grant: {
            grantId,
            sourceDeviceId: source.deviceId,
            destinationDeviceId: destination.deviceId,
            sourceBrowserSessionId: source.browserSessionId,
            destinationBrowserSessionId: destination.browserSessionId,
            site: "OWNED_FIXTURE",
            state: "ACTIVE",
            createdAt: "2026-08-15T21:00:00.000Z",
            expiresAt: "2026-08-22T21:00:00.000Z",
          },
        },
        { status: 201 },
      ),
    );
    const client = new ContinuitySetupClient(
      "https://village.test",
      request,
      () => csrf,
      () => Date.parse("2026-08-15T21:00:00.000Z"),
      () => grantId,
    );

    await client.createGrant(source, destination);

    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      grantId,
      sourceDeviceId: source.deviceId,
      destinationDeviceId: destination.deviceId,
      sourceBrowserSessionId: source.browserSessionId,
      destinationBrowserSessionId: destination.browserSessionId,
      site: "OWNED_FIXTURE",
      expiresAt: "2026-08-22T21:00:00.000Z",
    });
    expect(body).not.toHaveProperty("destinationEncryptionPublicKey");
    expect(
      new Headers(request.mock.calls[0]![1]?.headers).get("x-village-csrf"),
    ).toBe(csrf);
  });

  it("revokes one exact grant with owner CSRF", async () => {
    const grantId = "cgr_01J00000000000000000000009";
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, revoked: true }),
    );
    const client = new ContinuitySetupClient(
      "https://village.test",
      request,
      () => csrf,
    );

    await expect(client.revokeGrant(grantId)).resolves.toBeUndefined();
    expect(String(request.mock.calls[0]![0])).toBe(
      `https://village.test/api/site-session-continuity/grants/${grantId}/revoke`,
    );
    expect(request.mock.calls[0]![1]?.method).toBe("POST");
  });
});
