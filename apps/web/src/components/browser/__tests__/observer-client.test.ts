import { describe, expect, it, vi } from "vitest";
import { ObserverApiClient } from "../observer-client.js";

const selection = {
  jobId: "job_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
};
const projection = (
  cursor: number,
  overrides: Record<string, unknown> = {},
) => ({
  cursor,
  projectionLag: 0,
  jobRevision: 2,
  jobState: "RUNNING_AGENT",
  workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
  workflowVersion: 1,
  logicalStep: "SELECT_ROLE",
  actionPhase: "DISPATCHED",
  lastEffectActor: "AGENT",
  controller: "AGENT",
  connection: "ONLINE",
  automationFenced: false,
  humanGate: null,
  terminalEvidence: null,
  cancellationAcknowledgedAt: null,
  lastDurableUpdateAt: "2026-08-13T12:01:00.000Z",
  ...overrides,
});

describe("observer API client", () => {
  it("loads and reconnects from the last monotonic projection cursor", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ok: true, projection: projection(4) }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          projection: projection(7, { projectionLag: 2 }),
        }),
      );
    const client = new ObserverApiClient("https://village.test", request);
    await expect(client.loadSnapshot(selection)).resolves.toMatchObject({
      cursor: 4,
      logicalStep: "SELECT_ROLE",
    });
    await expect(client.loadSnapshot(selection)).resolves.toMatchObject({
      cursor: 7,
      projectionLag: 2,
    });
    expect(String(request.mock.calls[0]![0])).toContain("cursor=0");
    expect(String(request.mock.calls[1]![0])).toContain("cursor=4");
  });

  it("ignores duplicate and out-of-order snapshots", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ok: true, projection: projection(8) }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          projection: projection(7, { logicalStep: "SET_DISPLAY_NAME" }),
        }),
      );
    const client = new ObserverApiClient("https://village.test", request);
    const first = await client.loadSnapshot(selection);
    await expect(client.loadSnapshot(selection)).resolves.toBe(first);
  });

  it("fails closed on malformed workflow identity and hostile extra fields", async () => {
    for (const hostile of [
      projection(1, { workflowVersion: 2 }),
      projection(1, { logicalStep: "<script>alert(1)</script>" }),
      projection(1, { actionPhase: "[click here](javascript:alert(1))" }),
      {
        ...projection(1),
        pageText: "secret",
        rawUrl: "https://evil.test/?token=x",
        selector: "#password",
        cookies: "sid=x",
        profile: { displayName: "Andrew" },
        screenshot: "data:image/png",
      },
    ]) {
      const client = new ObserverApiClient(
        "https://village.test",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ ok: true, projection: hostile })),
      );
      await expect(client.loadSnapshot(selection)).rejects.toThrow(
        "OBSERVER_STATE_INVALID",
      );
    }
  });

  it.each([
    ["SUCCEEDED", "RECEIPTED_SUCCESS", null],
    ["WAITING_FOR_USER", null, "UNKNOWN_CHALLENGE"],
    ["FAILED", "NON_CONVERGENT", null],
  ] as const)(
    "accepts sanitized terminal and Human Gate evidence for %s",
    async (jobState, terminalEvidence, humanGate) => {
      const client = new ObserverApiClient(
        "https://village.test",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            ok: true,
            projection: projection(10, {
              jobState,
              terminalEvidence,
              humanGate,
              logicalStep: "FINALIZE_SETUP",
              actionPhase: "RECEIPTED",
            }),
          }),
        ),
      );
      await expect(client.loadSnapshot(selection)).resolves.toMatchObject({
        jobState,
        terminalEvidence,
        humanGate,
      });
    },
  );

  it("sends the closed cancel intent with revision, CSRF, and durable acknowledgement", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        acknowledgedAt: "2026-08-13T12:02:00.000Z",
      }),
    );
    const client = new ObserverApiClient(
      "https://village.test",
      request,
      () => "csrf-token-that-is-at-least-thirty-two-bytes-long",
    );
    await expect(
      client.sendIntent(selection, "CANCEL_AUTOMATION", 2),
    ).resolves.toEqual({
      state: "DURABLY_ACCEPTED",
      acknowledgedAt: "2026-08-13T12:02:00.000Z",
    });
    expect(request.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: expect.objectContaining({
        "x-village-csrf": "csrf-token-that-is-at-least-thirty-two-bytes-long",
      }),
    });
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({
      jobId: selection.jobId,
      expectedJobRevision: 2,
    });
  });

  it("reports a cancel race as failed without inventing durable acceptance", async () => {
    const client = new ObserverApiClient(
      "https://village.test",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { ok: false, code: "STALE_JOB_REVISION" },
            { status: 409 },
          ),
        ),
      () => "csrf-token-that-is-at-least-thirty-two-bytes-long",
    );
    await expect(
      client.sendIntent(selection, "CANCEL_AUTOMATION", 2),
    ).rejects.toThrow("STALE_JOB_REVISION");
  });
});
