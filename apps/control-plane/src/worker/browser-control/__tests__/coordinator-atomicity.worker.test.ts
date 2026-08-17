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

async function dropTrigger(
  stub: DurableObjectStub<BrowserSessionCoordinator>,
  triggerName: string,
) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(`DROP TRIGGER ${triggerName}`);
  });
}

async function installReceiptCheckpointFailure(
  stub: DurableObjectStub<BrowserSessionCoordinator>,
) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER fail_workflow_checkpoint_insert
       BEFORE INSERT ON workflow_checkpoint
       BEGIN
         SELECT RAISE(ABORT, 'injected checkpoint failure');
       END`,
    );
  });
}

async function installProjectionCursorFailure(
  stub: DurableObjectStub<BrowserSessionCoordinator>,
) {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER fail_projection_cursor_update
       BEFORE UPDATE OF projected_sequence ON session_metadata
       WHEN NEW.projected_sequence > OLD.projected_sequence
       BEGIN
         SELECT RAISE(ABORT, 'injected projection cursor failure');
       END`,
    );
  });
}

function nextMessage(webSocket: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    webSocket.addEventListener(
      "message",
      (event) =>
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
      { once: true },
    );
    webSocket.addEventListener(
      "error",
      () => reject(new Error("stream error")),
      { once: true },
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

async function durableProjectionState(
  stub: DurableObjectStub<BrowserSessionCoordinator>,
) {
  return runInDurableObject(stub, async (_instance, state) => ({
    projectedSequence: state.storage.sql
      .exec<{ projected_sequence: number }>(
        "SELECT projected_sequence FROM session_metadata WHERE singleton = 1",
      )
      .one().projected_sequence,
    projectedRows: state.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM projection_outbox WHERE projected_at IS NOT NULL",
      )
      .one().count,
  }));
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

    await dropTrigger(stub, "fail_selected_outbox_insert");
    await expect(
      stub.acceptAuthenticatedCommand(dispatch),
    ).resolves.toMatchObject({
      ok: true,
      eventSequence: 3,
      action: { actionId: dispatch.envelope.actionId, phase: "ACCEPTED" },
    });
    await expect(stub.acceptAuthenticatedCommand(dispatch)).resolves.toEqual({
      ok: false,
      code: "REPLAYED_SEQUENCE",
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toMatchObject({
      ok: true,
      control: { lastAcceptedSequence: 1 },
      eventSequence: 3,
      projectionLag: 3,
    });
    await expect(stub.workflowSnapshot(principalId)).resolves.toMatchObject({
      ok: true,
      checkpoint: null,
      effects: [
        expect.objectContaining({
          logicalStep: dispatch.envelope.logicalStep,
          effectId: dispatch.envelope.effectId,
          phase: "ACCEPTED",
          canonicalActionId: dispatch.envelope.actionId,
        }),
      ],
      eventSequence: 3,
      jobRevision: 1,
    });
    await expect(
      stub.action(principalId, dispatch.envelope.actionId),
    ).resolves.toMatchObject({
      ok: true,
      action: { actionId: dispatch.envelope.actionId, phase: "ACCEPTED" },
    });
    await expect(durableCounts(stub)).resolves.toEqual({
      events: 3,
      outbox: 3,
      actions: 1,
      quota: 1,
      effects: 1,
      receipts: 0,
      checkpoints: 0,
    });
  });

  it("rolls back every receipt and checkpoint row when a late checkpoint write fails", async () => {
    const browserSessionId = "brs_01J00000000000000000000043" as const;
    const actionId = "act_01J00000000000000000000043" as const;
    const effectId = "efx_01J00000000000000000000043" as const;
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
      connectionId: "atomic-receipt",
      now,
      expiresAt: "2026-08-17T18:00:30.000Z",
    });
    await stub.acceptAuthenticatedCommand({
      connectionId: "atomic-receipt",
      now: "2026-08-17T18:00:01.000Z",
      envelope: {
        protocolVersion: 1,
        principalId,
        deviceId,
        jobId,
        browserSessionId,
        actionId,
        leaseEpoch: 1,
        sequence: 1,
        issuedAt: now,
        expiresAt: "2026-08-17T18:00:30.000Z",
        signature: "signature",
        workflowKind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1",
        workflowVersion: 1,
        jobRevision: 1,
        logicalStep: "SET_DISPLAY_NAME",
        effectId,
        command: { capability: "REPLACE_DISPLAY_NAME" },
      },
    });
    const receipt = {
      receiptId: "rcp_01J00000000000000000000043",
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      actionId,
      stepId: "bsp_01J00000000000000000000043",
      objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
      jobRevision: 1,
      logicalStep: "SET_DISPLAY_NAME",
      effectId,
      leaseEpoch: 1,
      outcome: "POSTCONDITION_SATISFIED",
      predicateIds: ["setup-display-name-matches-v1"],
      recordedAt: "2026-08-17T18:00:05.000Z",
    } as const;
    const checkpoint = {
      checkpointId: "chk_01J00000000000000000000043",
      principalId,
      deviceId,
      jobId,
      browserSessionId,
      jobRevision: 1,
      eventSequence: 4,
      state: "RUNNING_AGENT",
      objective: { kind: "OWNED_FIXTURE_ACCOUNT_SETUP_V1", version: 1 },
      site: "OWNED_FIXTURE",
      currentStep: "SELECT_ROLE",
      currentEffectId: "efx_01J00000000000000000000044",
      completedEffects: [{ logicalStep: "SET_DISPLAY_NAME", effectId }],
      outstandingAction: null,
      lastPredicateVersion: "setup-display-name-matches-v1",
      actionPhase: "RECEIPTED",
      reconciliation: "NONE",
      createdAt: "2026-08-17T18:00:05.000Z",
    } as const;
    await installReceiptCheckpointFailure(stub);

    await runInDurableObject(stub, async (instance) => {
      expect(() =>
        instance.recordWorkflowReceipt({
          receipt,
          checkpoint,
          connectionId: "atomic-receipt",
        }),
      ).toThrow("injected checkpoint failure");
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toMatchObject({
      ok: true,
      eventSequence: 3,
      projectionLag: 3,
    });
    await expect(stub.workflowSnapshot(principalId)).resolves.toMatchObject({
      ok: true,
      checkpoint: null,
      effects: [
        expect.objectContaining({
          logicalStep: "SET_DISPLAY_NAME",
          effectId,
          phase: "ACCEPTED",
          receiptId: null,
          checkpointId: null,
        }),
      ],
      eventSequence: 3,
      jobRevision: 1,
    });
    await expect(stub.action(principalId, actionId)).resolves.toMatchObject({
      ok: true,
      action: { phase: "ACCEPTED", postcondition: "UNOBSERVED" },
    });
    await expect(durableCounts(stub)).resolves.toEqual({
      events: 3,
      outbox: 3,
      actions: 1,
      quota: 1,
      effects: 1,
      receipts: 0,
      checkpoints: 0,
    });
  });

  it("rolls back projection row acknowledgements with their durable cursor", async () => {
    const browserSessionId = "brs_01J00000000000000000000044" as const;
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
      connectionId: "atomic-projection",
      now,
      expiresAt: "2026-08-17T18:00:30.000Z",
    });
    await installProjectionCursorFailure(stub);

    await runInDurableObject(stub, async (instance) => {
      expect(() =>
        instance.markProjected(principalId, 2, "2026-08-17T18:00:05.000Z"),
      ).toThrow("injected projection cursor failure");
    });

    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toMatchObject({
      ok: true,
      eventSequence: 2,
      projectionLag: 2,
    });
    await expect(durableProjectionState(stub)).resolves.toEqual({
      projectedSequence: 0,
      projectedRows: 0,
    });
    await expect(
      stub.pendingProjection(principalId, 100),
    ).resolves.toMatchObject({
      ok: true,
      events: [
        expect.objectContaining({ sequence: 1 }),
        expect.objectContaining({ sequence: 2 }),
      ],
    });

    await dropTrigger(stub, "fail_projection_cursor_update");
    await expect(
      stub.markProjected(principalId, 2, "2026-08-17T18:00:06.000Z"),
    ).resolves.toEqual({ ok: true });
    await evictDurableObject(stub);
    await expect(stub.snapshot(principalId)).resolves.toMatchObject({
      ok: true,
      eventSequence: 2,
      projectionLag: 0,
    });
    await expect(durableProjectionState(stub)).resolves.toEqual({
      projectedSequence: 2,
      projectedRows: 2,
    });
  });

  it("publishes no WebSocket event for a rolled-back transition", async () => {
    const browserSessionId = "brs_01J00000000000000000000045" as const;
    const stub = env.BROWSER_SESSION_COORDINATOR.getByName(browserSessionId);
    await stub.initialize({
      principalId,
      browserSessionId,
      site: "OWNED_FIXTURE",
      initializedAt: now,
      control: initialControl(browserSessionId),
    });
    const response = await stub.fetch(
      new Request("https://village.test/stream?cursor=1", {
        headers: {
          upgrade: "websocket",
          "x-village-principal": principalId,
        },
      }),
    );
    expect(response.status).toBe(101);
    const webSocket = response.webSocket!;
    const ready = nextMessage(webSocket);
    webSocket.accept();
    await expect(ready).resolves.toMatchObject({
      type: "READY",
      cursor: 1,
      latestSequence: 1,
    });
    const observed: Record<string, unknown>[] = [];
    webSocket.addEventListener("message", (event) => {
      observed.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    await installOutboxFailure(stub, "AGENT_LEASE_CLAIMED");

    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.claimAgentLease({
          principalId,
          deviceId,
          connectionId: "atomic-stream",
          now,
          expiresAt: "2026-08-17T18:00:30.000Z",
        }),
      ).rejects.toThrow("injected outbox failure");
    });
    await Promise.resolve();
    expect(observed).toEqual([]);

    await dropTrigger(stub, "fail_selected_outbox_insert");
    const live = nextMessage(webSocket);
    await expect(
      stub.claimAgentLease({
        principalId,
        deviceId,
        connectionId: "atomic-stream",
        now: "2026-08-17T18:00:01.000Z",
        expiresAt: "2026-08-17T18:00:30.000Z",
      }),
    ).resolves.toMatchObject({ ok: true, eventSequence: 2 });
    await expect(live).resolves.toMatchObject({
      type: "EVENT",
      event: { sequence: 2, type: "AGENT_LEASE_CLAIMED" },
    });
    await Promise.resolve();
    expect(observed).toHaveLength(1);
    webSocket.close(1000, "test complete");
  });
});
