import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BrowserControlState } from "@village/contracts";
import type { BrowserSessionCoordinator } from "../session-coordinator.js";

const principalId = "prn_01J00000000000000000000000" as const;
const deviceId = "dev_01J00000000000000000000000" as const;
const browserSessionId = "brs_01J00000000000000000000000" as const;
const jobId = "job_01J00000000000000000000000" as const;

const initial: BrowserControlState = {
  principalId,
  deviceId,
  jobId,
  browserSessionId,
  controller: "NONE",
  connection: "ONLINE",
  leaseEpoch: 0,
  leaseExpiresAt: null,
  lastAcceptedSequence: 0,
  automationBlocked: true,
  takeover: "NONE",
  profile: "PRESENT",
};

describe("BrowserSessionCoordinator lease contention", () => {
  it("persists one winner, one epoch, and one ordered event stream", async () => {
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    expect(
      await stub.initialize({
        principalId,
        browserSessionId,
        site: "OWNED_FIXTURE",
        initializedAt: "2026-08-12T17:59:59.000Z",
        control: initial,
      }),
    ).toEqual({ ok: true });

    const [first, second] = await Promise.all([
      stub.claimAgentLease({
        principalId,
        deviceId,
        connectionId: "connector-a",
        now: "2026-08-12T18:00:00.000Z",
        expiresAt: "2026-08-12T18:00:30.000Z",
      }),
      stub.claimAgentLease({
        principalId,
        deviceId,
        connectionId: "connector-b",
        now: "2026-08-12T18:00:00.000Z",
        expiresAt: "2026-08-12T18:00:30.000Z",
      }),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, code: "LEASE_CONFLICT" },
    ]);

    const snapshot = await stub.snapshot(principalId);
    expect(snapshot).toMatchObject({
      ok: true,
      control: { controller: "AGENT", leaseEpoch: 1 },
      eventSequence: 2,
      projectionLag: 2,
    });

    await runInDurableObject(
      stub,
      async (
        _instance: BrowserSessionCoordinator,
        state: DurableObjectState,
      ) => {
        const rows = state.storage.sql
          .exec<{ sequence: number; type: string }>(
            "SELECT sequence, type FROM coordinator_events ORDER BY sequence",
          )
          .toArray();
        expect(rows).toEqual([
          { sequence: 1, type: "SESSION_INITIALIZED" },
          { sequence: 2, type: "AGENT_LEASE_CLAIMED" },
        ]);
      },
    );
  });

  it("recovers durable epoch and rejects another principal", async () => {
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName("restart-case");
    await stub.initialize({
      principalId,
      browserSessionId,
      site: "LINKEDIN",
      initializedAt: "2026-08-12T17:59:59.000Z",
      control: initial,
    });
    await stub.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "connector-a",
      now: "2026-08-12T18:00:00.000Z",
      expiresAt: "2026-08-12T18:00:30.000Z",
    });

    expect(await stub.snapshot("prn_01J00000000000000000000001")).toEqual({
      ok: false,
      code: "IDENTITY_MISMATCH",
    });
    await evictDurableObject(stub);
    expect(await stub.snapshot(principalId)).toMatchObject({
      ok: true,
      control: { leaseEpoch: 1, controller: "AGENT" },
    });
  });
});
