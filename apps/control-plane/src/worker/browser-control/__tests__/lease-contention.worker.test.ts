import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BrowserAction, BrowserControlState } from "@village/contracts";
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

  it("fences an expired connector and resumes once with a fresh epoch", async () => {
    const continuitySessionId = "brs_01J00000000000000000000001" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(continuitySessionId);
    const issuedAt = new Date(Date.now() + 60_000).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 30_000).toISOString();
    await stub.initialize({
      principalId,
      browserSessionId: continuitySessionId,
      site: "OWNED_FIXTURE",
      initializedAt: issuedAt,
      control: { ...initial, browserSessionId: continuitySessionId },
    });
    await stub.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "connector-a",
      now: issuedAt,
      expiresAt,
    });
    const orphan: BrowserAction = {
      actionId: "act_01J00000000000000000000009",
      browserSessionId: continuitySessionId,
      phase: "DISPATCHED",
      mutationClass: "NON_IDEMPOTENT",
      acceptedAt: issuedAt,
      updatedAt: issuedAt,
      postcondition: "UNKNOWN",
    };
    await runInDurableObject(
      stub,
      async (_instance: BrowserSessionCoordinator, state) => {
        state.storage.sql.exec(
          `INSERT INTO accepted_actions
           (action_id, command_sequence, action_json) VALUES (?, 1, ?)`,
          orphan.actionId,
          JSON.stringify(orphan),
        );
      },
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.snapshot(principalId)).toMatchObject({
      control: {
        controller: "NONE",
        connection: "OFFLINE",
        leaseEpoch: 1,
        automationBlocked: true,
      },
      eventSequence: 3,
    });
    expect(
      await stub.renewAgentLease({
        principalId,
        deviceId,
        connectionId: "connector-a",
        leaseEpoch: 1,
        now: expiresAt,
        expiresAt: new Date(Date.parse(expiresAt) + 30_000).toISOString(),
      }),
    ).toEqual({ ok: false, code: "IDENTITY_MISMATCH" });

    const reconnectedAt = new Date(Date.parse(expiresAt) + 1_000).toISOString();
    expect(
      await stub.hostReconnected(principalId, deviceId, reconnectedAt),
    ).toEqual({ ok: true });
    expect(await stub.action(principalId, orphan.actionId)).toMatchObject({
      ok: true,
      action: { phase: "RECONCILIATION_REQUIRED" },
    });
    const resumed = await stub.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "connector-b",
      now: reconnectedAt,
      expiresAt: new Date(Date.parse(reconnectedAt) + 30_000).toISOString(),
    });
    expect(resumed).toEqual({
      ok: false,
      code: "RECOVERY_REQUIRES_USER",
    });

    const firstPage = await stub.eventsAfter(principalId, 0, 2);
    const secondPage = await stub.eventsAfter(principalId, 2, 100);
    expect(firstPage).toMatchObject({
      ok: true,
      events: [{ sequence: 1 }, { sequence: 2 }],
      latestSequence: 4,
    });
    expect(secondPage).toMatchObject({
      ok: true,
      events: [{ sequence: 3 }, { sequence: 4 }],
      latestSequence: 4,
    });
    expect(await stub.cancel(principalId, reconnectedAt)).toEqual({ ok: true });
    expect(await stub.snapshot(principalId)).toMatchObject({
      control: {
        controller: "NONE",
        leaseEpoch: 2,
        automationBlocked: true,
      },
      eventSequence: 5,
    });
  });

  it("allows one fresh lease for a pre-dispatch action while keeping its safe retry evidence", async () => {
    const recoverySessionId = "brs_01J00000000000000000000002" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(recoverySessionId);
    const issuedAt = new Date(Date.now() + 120_000).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 30_000).toISOString();
    await stub.initialize({
      principalId,
      browserSessionId: recoverySessionId,
      site: "OWNED_FIXTURE",
      initializedAt: issuedAt,
      control: { ...initial, browserSessionId: recoverySessionId },
    });
    await stub.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "connector-before-crash",
      now: issuedAt,
      expiresAt,
    });
    const accepted: BrowserAction = {
      actionId: "act_01J00000000000000000000008",
      browserSessionId: recoverySessionId,
      phase: "ACCEPTED",
      mutationClass: "NON_IDEMPOTENT",
      acceptedAt: issuedAt,
      updatedAt: issuedAt,
      postcondition: "UNOBSERVED",
    };
    await runInDurableObject(
      stub,
      async (_instance: BrowserSessionCoordinator, state) => {
        state.storage.sql.exec(
          `INSERT INTO accepted_actions
           (action_id, command_sequence, action_json) VALUES (?, 1, ?)`,
          accepted.actionId,
          JSON.stringify(accepted),
        );
      },
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const reconnectedAt = new Date(Date.parse(expiresAt) + 1_000).toISOString();
    expect(
      await stub.hostReconnected(principalId, deviceId, reconnectedAt),
    ).toEqual({ ok: true });
    expect(await stub.action(principalId, accepted.actionId)).toMatchObject({
      ok: true,
      action: { phase: "ACCEPTED", postcondition: "UNOBSERVED" },
    });
    const beforeClaim = await stub.snapshot(principalId);
    await runInDurableObject(
      stub,
      async (_instance: BrowserSessionCoordinator, state) => {
        state.storage.sql.exec(
          "UPDATE accepted_actions SET action_json = '{}' WHERE action_id = ?",
          accepted.actionId,
        );
      },
    );
    await expect(
      stub.claimAgentLease({
        principalId,
        deviceId,
        connectionId: "connector-corrupt-recovery",
        now: reconnectedAt,
        expiresAt: new Date(Date.parse(reconnectedAt) + 30_000).toISOString(),
      }),
    ).resolves.toEqual({ ok: false, code: "RECOVERY_STATE_CORRUPT" });
    expect(await stub.snapshot(principalId)).toEqual(beforeClaim);
    await runInDurableObject(
      stub,
      async (_instance: BrowserSessionCoordinator, state) => {
        state.storage.sql.exec(
          "UPDATE accepted_actions SET action_json = ? WHERE action_id = ?",
          JSON.stringify(accepted),
          accepted.actionId,
        );
      },
    );
    await expect(
      stub.claimAgentLease({
        principalId,
        deviceId,
        connectionId: "connector-after-crash",
        now: reconnectedAt,
        expiresAt: new Date(Date.parse(reconnectedAt) + 30_000).toISOString(),
      }),
    ).resolves.toMatchObject({ ok: true, leaseEpoch: 2 });
  });

  it("fails closed without advancing reconnect state when retained action evidence is corrupt", async () => {
    const corruptSessionId = "brs_01J00000000000000000000003" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(corruptSessionId);
    const issuedAt = new Date(Date.now() + 180_000).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 30_000).toISOString();
    await stub.initialize({
      principalId,
      browserSessionId: corruptSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: issuedAt,
      control: { ...initial, browserSessionId: corruptSessionId },
    });
    await stub.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "connector-corrupt",
      now: issuedAt,
      expiresAt,
    });
    const inconsistentAction: BrowserAction = {
      actionId: "act_01J00000000000000000000007",
      browserSessionId: corruptSessionId,
      phase: "ACCEPTED",
      mutationClass: "NON_IDEMPOTENT",
      acceptedAt: issuedAt,
      updatedAt: issuedAt,
      postcondition: "SATISFIED",
    };
    await runInDurableObject(
      stub,
      async (_instance: BrowserSessionCoordinator, state) => {
        state.storage.sql.exec(
          `INSERT INTO accepted_actions
           (action_id, command_sequence, action_json) VALUES (?, 1, ?)`,
          inconsistentAction.actionId,
          JSON.stringify(inconsistentAction),
        );
      },
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const before = await stub.snapshot(principalId);
    expect(
      await stub.hostReconnected(
        principalId,
        deviceId,
        new Date(Date.parse(expiresAt) + 1_000).toISOString(),
      ),
    ).toEqual({ ok: false, code: "RECOVERY_STATE_CORRUPT" });
    expect(await stub.snapshot(principalId)).toEqual(before);
  });
});
