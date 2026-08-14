import { describe, expect, it, vi } from "vitest";
import { signedCommandEnvelopeSchema } from "@village/contracts";
import { ControlPlaneClient } from "../src/main/control-plane-client.js";
import { generateDeviceSigningKey } from "../src/main/device-identity.js";

describe("paired desktop connector", () => {
  it("reserves monotonic sequence before sending and binds one connection", async () => {
    const keys = await generateDeviceSigningKey();
    let sequence = 0;
    const reserveNext = vi.fn(async () => {
      sequence += 1;
      return sequence;
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, code: "NETWORK_RECONCILIATION" },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, leaseEpoch: 1 }));
    const client = new ControlPlaneClient(
      "https://village.test",
      "connector-desktop",
      keys.privateKey,
      { reserveNext },
      request,
    );
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
    };

    await expect(
      client.connect(
        identity,
        "act_01J00000000000000000000000",
        "OWNED_FIXTURE",
        1,
      ),
    ).rejects.toThrow("NETWORK_RECONCILIATION");
    await client.connect(
      identity,
      "act_01J00000000000000000000001",
      "OWNED_FIXTURE",
      1,
    );

    const first = signedCommandEnvelopeSchema.parse(
      JSON.parse((request.mock.calls[0]![1] as RequestInit).body as string),
    );
    const second = signedCommandEnvelopeSchema.parse(
      JSON.parse((request.mock.calls[1]![1] as RequestInit).body as string),
    );
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(request.mock.calls[1]![1]).toMatchObject({
      headers: expect.objectContaining({
        "x-village-connection-id": "connector-desktop",
      }),
    });
  });

  it("signs workflow commands with stable effect identity independent of action id", async () => {
    const keys = await generateDeviceSigningKey();
    let sequence = 0;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ ok: true, eventSequence: 3 }, { status: 202 }),
      );
    const client = new ControlPlaneClient(
      "https://village.test",
      "connector-desktop",
      keys.privateKey,
      { reserveNext: async () => ++sequence },
      request,
    );
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      jobId: "job_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
    };
    const workflow = {
      workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1" as const,
      workflowVersion: 1 as const,
      jobRevision: 2,
      logicalStep: "SELECT_ROLE" as const,
      effectId: "efx_01J00000000000000000000000",
    };
    await client.workflowCommand(
      identity,
      workflow,
      "act_01J00000000000000000000000",
      4,
      { capability: "SELECT_ROLE" },
    );
    await client.workflowCommand(
      identity,
      workflow,
      "act_01J00000000000000000000001",
      4,
      { capability: "SELECT_ROLE" },
    );

    const envelopes = request.mock.calls.map((call) =>
      signedCommandEnvelopeSchema.parse(
        JSON.parse((call[1] as RequestInit).body as string),
      ),
    );
    expect(envelopes.map((envelope) => envelope.actionId)).toEqual([
      "act_01J00000000000000000000000",
      "act_01J00000000000000000000001",
    ]);
    expect(
      envelopes.map((envelope) => "effectId" in envelope && envelope.effectId),
    ).toEqual([workflow.effectId, workflow.effectId]);
  });
});
