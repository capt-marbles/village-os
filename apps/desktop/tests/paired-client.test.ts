import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  automationSyncRequestSchema,
  signedCommandEnvelopeSchema,
} from "@village/contracts";
import {
  ControlPlaneClient,
  FileAutomationSyncCursorStore,
  MemoryAutomationSyncCursorStore,
} from "../src/main/control-plane-client.js";
import { generateDeviceSigningKey } from "../src/main/device-identity.js";

describe("paired desktop connector", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });
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

  it("authenticates automation sync and resumes from a durable cursor", async () => {
    const keys = await generateDeviceSigningKey();
    let sequence = 0;
    const cursorStore = new MemoryAutomationSyncCursorStore(7);
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        cursor: 9,
        jobId: "job_01J00000000000000000000000",
        controller: "NONE",
        connection: "ONLINE",
        leaseEpoch: 5,
        automationBlocked: true,
      }),
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
      browserSessionId: "brs_01J00000000000000000000000",
    };

    const synchronized = await client.synchronizeAutomation(
      identity,
      cursorStore,
    );
    expect(synchronized).toMatchObject({
      cursor: 9,
      automationBlocked: true,
    });
    expect(await cursorStore.load(identity.browserSessionId)).toBe(9);

    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(
      `${identity.browserSessionId.replace(
        /^/,
        "https://village.test/api/browser-sessions/",
      )}/automation-sync`,
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "x-village-connection-id": "connector-desktop",
      }),
    });
    expect(
      automationSyncRequestSchema.parse(JSON.parse(init!.body as string)),
    ).toMatchObject({ ...identity, cursor: 7, sequence: 1 });
  });

  it("does not advance the cursor for a malformed or regressing response", async () => {
    const keys = await generateDeviceSigningKey();
    const cursorStore = new MemoryAutomationSyncCursorStore(7);
    const identity = {
      principalId: "prn_01J00000000000000000000000",
      deviceId: "dev_01J00000000000000000000000",
      browserSessionId: "brs_01J00000000000000000000000",
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ok: true, cursor: 8, rawPageText: "hostile" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          cursor: 6,
          jobId: "job_01J00000000000000000000000",
          controller: "NONE",
          connection: "ONLINE",
          leaseEpoch: 5,
          automationBlocked: true,
        }),
      );
    const client = new ControlPlaneClient(
      "https://village.test",
      "connector-desktop",
      keys.privateKey,
      { reserveNext: async () => 1 },
      request,
    );

    await expect(
      client.synchronizeAutomation(identity, cursorStore),
    ).rejects.toThrow("INVALID_AUTOMATION_SYNC_RESPONSE");
    await expect(
      client.synchronizeAutomation(identity, cursorStore),
    ).rejects.toThrow("STALE_AUTOMATION_SYNC_RESPONSE");
    expect(await cursorStore.load(identity.browserSessionId)).toBe(7);
  });

  it("resumes the automation cursor after a desktop restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "village-sync-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cursor.json");
    const sessionId = "brs_01J00000000000000000000000";

    const firstProcess = new FileAutomationSyncCursorStore(path);
    await firstProcess.save(sessionId, 12);
    const restartedProcess = new FileAutomationSyncCursorStore(path);

    expect(await restartedProcess.load(sessionId)).toBe(12);
    await expect(restartedProcess.save(sessionId, 11)).rejects.toThrow(
      "STALE_AUTOMATION_SYNC_CURSOR",
    );
    expect(await restartedProcess.load(sessionId)).toBe(12);
  });
});
