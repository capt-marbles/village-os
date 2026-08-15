import { describe, expect, it, vi } from "vitest";
import { provisionInternalOwnedFixture } from "../src/main/internal-fixture-provisioner.js";

const identity = {
  principalId: "prn_01J00000000000000000000000",
  deviceId: "dev_01J00000000000000000000000",
  browserSessionId: "brs_01J00000000000000000000000",
};

describe("internal owned-fixture provisioning", () => {
  it("creates a fixed job and a distinct fixture session through the local control plane", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          jobId: "job_01J00000000000000000000009",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          browserSessionId: "brs_01J00000000000000000000009",
        }),
      );

    const provisioned = await provisionInternalOwnedFixture({
      controlPlaneUrl: new URL("http://localhost:5174"),
      identity,
      request,
      createId: (prefix) =>
        prefix === "brs"
          ? "brs_01J00000000000000000000009"
          : "hst_01J00000000000000000000009",
      csrfToken: () => "csrf_csrf_csrf_csrf_csrf_csrf_1234",
    });

    expect(provisioned).toEqual({
      jobId: "job_01J00000000000000000000009",
      browserSessionId: "brs_01J00000000000000000000009",
      hostId: "hst_01J00000000000000000000009",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]![0])).toBe(
      "http://localhost:5174/api/jobs",
    );
    expect(request.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        origin: "http://localhost:5174",
        "x-village-development-principal": identity.principalId,
        "x-village-csrf": "csrf_csrf_csrf_csrf_csrf_csrf_1234",
        cookie: "village_csrf=csrf_csrf_csrf_csrf_csrf_csrf_1234",
      }),
      body: JSON.stringify({
        objective: {
          kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
          version: 1,
        },
      }),
    });
    expect(String(request.mock.calls[1]![0])).toBe(
      "http://localhost:5174/api/jobs/job_01J00000000000000000000009/browser-sessions",
    );
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
      deviceId: identity.deviceId,
      browserSessionId: provisioned.browserSessionId,
      hostId: provisioned.hostId,
      site: "OWNED_FIXTURE",
    });
  });

  it("rejects non-loopback development-header provisioning", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      provisionInternalOwnedFixture({
        controlPlaneUrl: new URL("https://village.example"),
        identity,
        request,
      }),
    ).rejects.toThrow("INTERNAL_FIXTURE_PROVISIONING_REQUIRES_LOOPBACK");
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid or rejected control-plane response", async () => {
    const malformed = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        ok: true,
        jobId: "job_01J00000000000000000000009",
        rawPageText: "hostile",
      }),
    );
    await expect(
      provisionInternalOwnedFixture({
        controlPlaneUrl: new URL("http://127.0.0.1:5174"),
        identity,
        request: malformed,
      }),
    ).rejects.toThrow("INTERNAL_FIXTURE_JOB_RESPONSE_INVALID");

    const rejected = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        ok: false,
        code: "JOB_OR_DEVICE_NOT_ELIGIBLE",
      }),
    );
    await expect(
      provisionInternalOwnedFixture({
        controlPlaneUrl: new URL("http://127.0.0.1:5174"),
        identity,
        request: rejected,
      }),
    ).rejects.toThrow("JOB_OR_DEVICE_NOT_ELIGIBLE");
  });
});
