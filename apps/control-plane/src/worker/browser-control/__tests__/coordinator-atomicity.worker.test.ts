import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BrowserControlState } from "@village/contracts";
import type { BrowserSessionCoordinator } from "../session-coordinator.js";

const principalId = "prn_01J00000000000000000000040" as const;
const deviceId = "dev_01J00000000000000000000040" as const;
const jobId = "job_01J00000000000000000000040" as const;
const now = "2026-08-17T18:00:00.000Z";

function initialControl(browserSessionId: string): BrowserControlState {
  return {
    principalId,
    deviceId,
    jobId,
    browserSessionId:
      browserSessionId as BrowserControlState["browserSessionId"],
    controller: "NONE",
    connection: "ONLINE",
    leaseEpoch: 0,
    leaseExpiresAt: null,
    lastAcceptedSequence: 0,
    automationBlocked: true,
    takeover: "NONE",
    profile: "PRESENT",
  };
}

async function installOutboxFailure(
  stub: DurableObjectStub<BrowserSessionCoordinator>,
  eventType: string,
) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER fail_selected_outbox_insert
       BEFORE INSERT ON projection_outbox
       WHEN json_extract(NEW.payload_json, '$.type') = '${eventType}'
       BEGIN
         SELECT RAISE(ABORT, 'injected outbox failure');
       END`,
    );
  });
}

async function durableCounts(
  stub: DurableObjectStub<BrowserSessionCoordinator>,
) {
  return runInDurableObject(stub, async (_instance, state) => {
    const count = (table: string) =>
      state.storage.sql
        .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
        .one().count;
    return {
      events: count("coordinator_events"),
      outbox: count("projection_outbox"),
      actions: count("accepted_actions"),
      quota: count("command_quota_windows"),
      effects: count("workflow_effects"),
      receipts: count("workflow_receipts"),
      checkpoints: count("workflow_checkpoint"),
    };
  });
}

describe("BrowserSessionCoordinator atomic durable transitions", () => {
  it("rolls back initialization when its outbox append fails", async () => {
    const browserSessionId = "brs_01J00000000000000000000042" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await installOutboxFailure(stub, "SESSION_INITIALIZED");

    await runInDurableObject(stub, async (instance) => {
      expect(() =>
        instance.initialize({
          principalId,
          browserSessionId,
          site: "OWNED_FIXTURE",
          initializedAt: now,
          control: initialControl(browserSessionId),
        }),
      ).toThrow("injected outbox failure");
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toEqual({
      ok: false,
      code: "NOT_INITIALIZED",
    });
    await expect(durableCounts(stub)).resolves.toEqual({
      events: 0,
      outbox: 0,
      actions: 0,
      quota: 0,
      effects: 0,
      receipts: 0,
      checkpoints: 0,
    });
  });

  it("rolls back a control transition when its outbox append fails", async () => {
    const browserSessionId = "brs_01J00000000000000000000040" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await stub.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: initialControl(browserSessionId),
    });
    await installOutboxFailure(stub, "AGENT_LEASE_CLAIMED");

    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.claimAgentLease({
          principalId,
          deviceId,
          connectionId: "atomic-control",
          now,
          expiresAt: "2026-08-17T18:00:30.000Z",
        }),
      ).rejects.toThrow("injected outbox failure");
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toMatchObject({
      ok: true,
      control: { controller: "NONE", leaseEpoch: 0 },
      eventSequence: 1,
      projectionLag: 1,
    });
    await expect(durableCounts(stub)).resolves.toMatchObject({
      events: 1,
      outbox: 1,
    });
  });

  it("rolls back workflow effect, action, quota, state, event, and outbox together", async () => {
    const browserSessionId = "brs_01J00000000000000000000041" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await stub.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: initialControl(browserSessionId),
    });
    await stub.claimAgentLease({
      principalId,
      deviceId,
      connectionId: "atomic-workflow",
      now,
      expiresAt: "2026-08-17T18:00:30.000Z",
    });
    await installOutboxFailure(stub, "WORKFLOW_ACTION_ACCEPTED");

    const dispatch = {
      connectionId: "atomic-workflow",
      now: "2026-08-17T18:00:01.000Z",
      envelope: {
        protocolVersion: 1,
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        actionId: "act_01J00000000000000000000040",
        leaseEpoch: 1,
        sequence: 1,
        issuedAt: now,
        expiresAt: "2026-08-17T18:00:30.000Z",
        signature: "signature",
        workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        workflowVersion: 1,
        jobRevision: 1,
        logicalStep: "SET_DISPLAY_NAME",
        effectId: "efx_01J00000000000000000000040",
        command: { capability: "REPLACE_DISPLAY_NAME" },
      },
    };
    await runInDurableObject(stub, async (instance) => {
      expect(() => instance.acceptAuthenticatedCommand(dispatch)).toThrow(
        "injected outbox failure",
      );
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toMatchObject({
      ok: true,
      control: { lastAcceptedSequence: 0 },
      eventSequence: 2,
      projectionLag: 2,
    });
    await expect(stub.workflowSnapshot(principalId)).resolves.toMatchObject({
      ok: true,
      checkpoint: null,
      effects: [],
      eventSequence: 2,
      jobRevision: null,
    });
    await expect(
      stub.action(principalId, dispatch.envelope.actionId),
    ).resolves.toEqual({ ok: false, code: "ACTION_NOT_FOUND" });
    await expect(durableCounts(stub)).resolves.toEqual({
      events: 2,
      outbox: 2,
      actions: 0,
      quota: 0,
      effects: 0,
      receipts: 0,
      checkpoints: 0,
    });
  });
});
