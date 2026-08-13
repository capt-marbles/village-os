import { describe, expect, it, vi } from "vitest";
import { ObserverApiClient } from "../observer-client.js";

const selection = {
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
};

describe("observer API client", () => {
  it("maps the canonical job and browser control projection", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          job: {
            principalId: "prn_01J00000000000000000000000",
            jobId: selection.jobId,
            browserSessionId: selection.browserSessionId,
            state: "RUNNING_USER",
            version: 2,
            lastEventSequence: 2,
            activeHumanGateId: "hgt_01J00000000000000000000000",
            createdAt: "2026-08-13T12:00:00.000Z",
            updatedAt: "2026-08-13T12:01:00.000Z",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          control: {
            principalId: "prn_01J00000000000000000000000",
            deviceId: "dev_01J00000000000000000000000",
            jobId: selection.jobId,
            browserSessionId: selection.browserSessionId,
            controller: "USER",
            connection: "OFFLINE",
            leaseEpoch: 2,
            leaseExpiresAt: null,
            lastAcceptedSequence: 1,
            automationBlocked: true,
            takeover: "OFFLINE_MARKED",
            profile: "PRESENT",
          },
          site: "LINKEDIN",
          eventSequence: 4,
          projectionLag: 0,
        }),
      );
    const client = new ObserverApiClient("https://village.test", request);
    await expect(client.loadSnapshot(selection)).resolves.toMatchObject({
      surface: "OBSERVER",
      jobState: "RUNNING_USER",
      controller: "USER",
      connection: "OFFLINE",
      takeover: "OFFLINE_MARKED",
      pairing: "PAIRED",
      humanGate: "UNKNOWN_CHALLENGE",
      lastUpdatedAt: "2026-08-13T12:01:00.000Z",
    });
  });

  it("sends closed cancel and notify intents with CSRF protection", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true }));
    const client = new ObserverApiClient(
      "https://village.test",
      request,
      () => "csrf-token-that-is-at-least-thirty-two-bytes-long",
    );

    await client.sendIntent(selection, "CANCEL_AUTOMATION");
    await client.sendIntent(selection, "NOTIFY_DESKTOP");

    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      `https://village.test/api/browser-sessions/${selection.browserSessionId}/cancel`,
      `https://village.test/api/browser-sessions/${selection.browserSessionId}/notify`,
    ]);
    expect(request.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: {
        "x-village-csrf": "csrf-token-that-is-at-least-thirty-two-bytes-long",
      },
    });
  });

  it("fails closed on malformed or unavailable canonical state", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, job: {} }))
      .mockResolvedValueOnce(Response.json({ ok: true, control: {} }));
    const client = new ObserverApiClient("https://village.test", request);
    await expect(client.loadSnapshot(selection)).rejects.toThrow(
      "OBSERVER_STATE_INVALID",
    );
  });
});
