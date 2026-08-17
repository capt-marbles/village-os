import { DurableObject } from "cloudflare:workers";
import {
  browserControlStateSchema,
  actionPhaseSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  effectIdSchema,
  instantSchema,
  jobIdSchema,
  principalIdSchema,
  setupActionReceiptSchema,
  setupCheckpointSchema,
  setupLogicalStepSchema,
  setupObjectiveSchema,
  signedCommandEnvelopeSchema,
  signedResultEnvelopeSchema,
  type BrowserAction,
  type BrowserControlState,
  type SignedCommandEnvelope,
  type SignedResultEnvelope,
  type Site,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../../env.js";
import {
  acceptBrowserCommand,
  transitionBrowserControl,
} from "./transitions.js";
import type { CoordinatorEvent } from "./coordinator-event.js";
import { reconcileBrowserRecovery } from "../jobs/reconciler.js";

const initializeSchema = z.strictObject({
  principalId: principalIdSchema,
  browserSessionId: browserSessionIdSchema,
  site: z.enum(["OWNED_FIXTURE", "LINKEDIN"]),
  initializedAt: instantSchema,
  control: browserControlStateSchema,
});

const claimSchema = z
  .strictObject({
    principalId: principalIdSchema,
    deviceId: deviceIdSchema,
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    now: instantSchema,
    expiresAt: instantSchema,
    commandSequence: z.number().int().positive().optional(),
  })
  .superRefine((claim, context) => {
    const lifetime = Date.parse(claim.expiresAt) - Date.parse(claim.now);
    if (lifetime <= 0 || lifetime > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Lease must expire within 60 seconds",
      });
    }
  });

const commandDispatchSchema = z.strictObject({
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  now: instantSchema,
  envelope: signedCommandEnvelopeSchema,
});

const resultDispatchSchema = z.strictObject({
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  now: instantSchema,
  envelope: signedResultEnvelopeSchema,
});

const leaseOperationSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  leaseEpoch: z.number().int().positive(),
  now: instantSchema,
});

const renewSchema = leaseOperationSchema.extend({ expiresAt: instantSchema });

const workflowReceiptSchema = z.strictObject({
  receipt: setupActionReceiptSchema,
  checkpoint: setupCheckpointSchema,
  connectionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});

const freshWorkflowLeaseSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  afterLeaseEpoch: z.number().int().positive(),
  cursor: z.number().int().nonnegative(),
  now: instantSchema,
  expiresAt: instantSchema,
});

const workflowTakeoverSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expectedLeaseEpoch: z.number().int().positive(),
  cursor: z.number().int().nonnegative(),
  now: instantSchema,
});

const workflowCancellationSchema = z.strictObject({
  principalId: principalIdSchema,
  jobId: jobIdSchema,
  expectedJobRevision: z.number().int().positive(),
  cancellationId: z.string().regex(/^cnl_[0-9A-HJKMNP-TV-Z]{26}$/),
  now: instantSchema,
});

const ownerProgressSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  objective: setupObjectiveSchema,
  jobRevision: z.number().int().positive(),
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
  actionPhase: actionPhaseSchema,
  leaseEpoch: z.number().int().positive(),
  cursor: z.number().int().nonnegative(),
  actor: z.literal("OWNER"),
  occurredAt: instantSchema,
});

const initializeWorkflowSchema = z.strictObject({
  principalId: principalIdSchema,
  deviceId: deviceIdSchema,
  jobId: jobIdSchema,
  browserSessionId: browserSessionIdSchema,
  objective: setupObjectiveSchema,
  jobRevision: z.number().int().positive(),
  logicalStep: setupLogicalStepSchema,
  effectId: effectIdSchema,
  initializedAt: instantSchema,
});

type MetadataRow = {
  principal_id: string;
  browser_session_id: string;
  site: Site;
  event_sequence: number;
  projected_sequence: number;
  last_result_sequence: number;
  workflow_job_revision: number | null;
};

type ControlRow = {
  state_json: string;
  holder_connection_id: string | null;
};

type ActionRow = {
  action_json: string;
};

type EventRow = {
  sequence: number;
  type: string;
  payload_json: string;
  occurred_at: string;
};

type WorkflowEffectRow = {
  logical_step: string;
  effect_id: string;
  job_revision: number;
  capability: string | null;
  canonical_action_id: string | null;
  phase: string;
  receipt_id: string | null;
  checkpoint_id: string | null;
  updated_at: string;
};

export class BrowserSessionCoordinator extends DurableObject<Environment> {
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          principal_id TEXT NOT NULL,
          browser_session_id TEXT NOT NULL,
          site TEXT NOT NULL CHECK (site IN ('OWNED_FIXTURE', 'LINKEDIN')),
          event_sequence INTEGER NOT NULL DEFAULT 0,
          projected_sequence INTEGER NOT NULL DEFAULT 0
          ,last_result_sequence INTEGER NOT NULL DEFAULT 0,
          workflow_job_revision INTEGER
        );
        CREATE TABLE IF NOT EXISTS control_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state_json TEXT NOT NULL CHECK (json_valid(state_json)),
          holder_connection_id TEXT
        );
        CREATE TABLE IF NOT EXISTS coordinator_events (
          sequence INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          occurred_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projection_outbox (
          sequence INTEGER PRIMARY KEY,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
          projected_at TEXT
        );
        CREATE TABLE IF NOT EXISTS accepted_actions (
          action_id TEXT PRIMARY KEY,
          command_sequence INTEGER NOT NULL UNIQUE,
          action_json TEXT NOT NULL CHECK (json_valid(action_json))
        );
        CREATE TABLE IF NOT EXISTS command_quota_windows (
          window_started_at TEXT PRIMARY KEY,
          accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0)
        );
        CREATE TABLE IF NOT EXISTS event_stream_quota_windows (
          window_started_at TEXT PRIMARY KEY,
          request_count INTEGER NOT NULL CHECK (request_count >= 0)
        );
        CREATE TABLE IF NOT EXISTS workflow_effects (
          logical_step TEXT PRIMARY KEY,
          effect_id TEXT NOT NULL UNIQUE,
          job_revision INTEGER NOT NULL,
          capability TEXT,
          canonical_action_id TEXT,
          phase TEXT NOT NULL,
          receipt_id TEXT,
          checkpoint_id TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_receipts (
          receipt_id TEXT PRIMARY KEY,
          effect_id TEXT NOT NULL UNIQUE,
          receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
          recorded_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_checkpoint (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
          event_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workflow_cancellations (
          cancellation_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          expected_job_revision INTEGER NOT NULL,
          resulting_job_revision INTEGER NOT NULL,
          event_sequence INTEGER NOT NULL,
          accepted_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, datetime('now'));
      `);
      const metadataColumns = this.ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(session_metadata)")
        .toArray();
      if (
        !metadataColumns.some(
          (column) => column.name === "last_result_sequence",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session_metadata ADD COLUMN last_result_sequence INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (
        !metadataColumns.some(
          (column) => column.name === "workflow_job_revision",
        )
      ) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE session_metadata ADD COLUMN workflow_job_revision INTEGER",
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
         VALUES (3, datetime('now'))`,
      );
    });
  }

  initialize(candidate: unknown): { ok: true } | { ok: false; code: string } {
    const parsed = initializeSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "INVALID_INITIALIZATION" };
    const input = parsed.data;
    if (
      input.control.principalId !== input.principalId ||
      input.control.browserSessionId !== input.browserSessionId
    ) {
      return { ok: false, code: "IDENTITY_MISMATCH" };
    }
    const existing = this.metadata();
    if (existing) {
      return existing.principal_id === input.principalId &&
        existing.browser_session_id === input.browserSessionId &&
        existing.site === input.site
        ? { ok: true }
        : { ok: false, code: "ALREADY_INITIALIZED" };
    }

    const event = this.commitTransition(
      1,
      "SESSION_INITIALIZED",
      input.control,
      input.initializedAt,
      () => {
        this.ctx.storage.sql.exec(
          `INSERT INTO session_metadata
           (singleton, principal_id, browser_session_id, site, event_sequence,
            projected_sequence, last_result_sequence)
           VALUES (1, ?, ?, ?, 1, 0, 0)`,
          input.principalId,
          input.browserSessionId,
          input.site,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO control_state (singleton, state_json, holder_connection_id) VALUES (1, ?, NULL)",
          JSON.stringify(input.control),
        );
      },
    );
    this.broadcastEvent(event);
    return { ok: true };
  }

  initializeWorkflow(candidate: unknown) {
    const parsed = initializeWorkflowSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false as const, code: "INVALID_WORKFLOW_INITIALIZATION" };
    const input = parsed.data;
    const metadata = this.metadata();
    const controlRow = this.control();
    if (!metadata || !controlRow)
      return { ok: false as const, code: "NOT_INITIALIZED" };
    const control = browserControlStateSchema.parse(
      JSON.parse(controlRow.state_json),
    );
    if (
      metadata.site !== "OWNED_FIXTURE" ||
      metadata.principal_id !== input.principalId ||
      metadata.browser_session_id !== input.browserSessionId ||
      control.deviceId !== input.deviceId ||
      control.jobId !== input.jobId
    ) {
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    }
    const existing = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE logical_step = ? OR effect_id = ?",
        input.logicalStep,
        input.effectId,
      )
      .toArray()[0];
    if (existing) {
      return existing.logical_step === input.logicalStep &&
        existing.effect_id === input.effectId &&
        existing.job_revision === input.jobRevision &&
        metadata.workflow_job_revision === input.jobRevision
        ? {
            ok: true as const,
            eventSequence: metadata.event_sequence,
            replayed: true as const,
          }
        : { ok: false as const, code: "LOGICAL_EFFECT_CONFLICT" };
    }
    if (
      metadata.workflow_job_revision !== null &&
      metadata.workflow_job_revision !== input.jobRevision
    ) {
      return { ok: false as const, code: "STALE_JOB_REVISION" };
    }
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "WORKFLOW_INITIALIZED",
      {
        jobId: input.jobId,
        objective: input.objective,
        jobRevision: input.jobRevision,
        logicalStep: input.logicalStep,
        effectId: input.effectId,
        actionPhase: "ACCEPTED",
      },
      input.initializedAt,
      () => {
        this.ctx.storage.sql.exec(
          `INSERT INTO workflow_effects
           (logical_step, effect_id, job_revision, capability, canonical_action_id,
            phase, receipt_id, checkpoint_id, updated_at)
           VALUES (?, ?, ?, NULL, NULL, 'ACCEPTED', NULL, NULL, ?)`,
          input.logicalStep,
          input.effectId,
          input.jobRevision,
          input.initializedAt,
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET workflow_job_revision = ?, event_sequence = ? WHERE singleton = 1",
          input.jobRevision,
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    return {
      ok: true as const,
      eventSequence: sequence,
      replayed: false as const,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.pathname !== "/stream" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return Response.json(
        { ok: false, code: "INVALID_STREAM_REQUEST" },
        { status: 400 },
      );
    }
    const principal = principalIdSchema.safeParse(
      request.headers.get("x-village-principal"),
    );
    const cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .safeParse(url.searchParams.get("cursor") ?? "0");
    const metadata = this.metadata();
    if (
      !principal.success ||
      !cursor.success ||
      !metadata ||
      metadata.principal_id !== principal.data
    ) {
      return Response.json(
        { ok: false, code: "STREAM_IDENTITY_MISMATCH" },
        { status: 403 },
      );
    }
    if (this.ctx.getWebSockets().length >= 10) {
      return Response.json(
        { ok: false, code: "STREAM_CONNECTION_QUOTA_EXCEEDED" },
        { status: 429 },
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [principal.data]);
    const page = this.eventPage(cursor.data, 100);
    for (const event of page) {
      server.send(JSON.stringify({ type: "EVENT", event }));
    }
    server.send(
      JSON.stringify({
        type: "READY",
        cursor: page.at(-1)?.sequence ?? cursor.data,
        latestSequence: metadata.event_sequence,
        hasMore:
          (page.at(-1)?.sequence ?? cursor.data) < metadata.event_sequence,
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(webSocket: WebSocket): void {
    webSocket.close(1008, "Village event streams are read-only");
  }

  override webSocketClose(
    webSocket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    void webSocket;
    void code;
    void reason;
    void wasClean;
  }

  override webSocketError(webSocket: WebSocket): void {
    webSocket.close(1011, "stream error");
  }

  async claimAgentLease(
    candidate: unknown,
  ): Promise<
    | { ok: true; leaseEpoch: number; eventSequence: number }
    | { ok: false; code: string }
  > {
    const parsed = claimSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "INVALID_LEASE_CLAIM" };
    const claim = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      metadata.principal_id !== claim.principalId ||
      state.deviceId !== claim.deviceId
    ) {
      return { ok: false, code: "IDENTITY_MISMATCH" };
    }
    if (
      state.connection !== "ONLINE" ||
      state.controller !== "NONE" ||
      row.holder_connection_id !== null
    ) {
      return { ok: false, code: "LEASE_CONFLICT" };
    }
    if (
      claim.commandSequence !== undefined &&
      claim.commandSequence <= state.lastAcceptedSequence
    ) {
      return { ok: false, code: "REPLAYED_SEQUENCE" };
    }

    const next = browserControlStateSchema.parse({
      ...state,
      controller: "AGENT",
      leaseEpoch: state.leaseEpoch + 1,
      leaseExpiresAt: claim.expiresAt,
      automationBlocked: false,
      takeover: "NONE",
      lastAcceptedSequence: claim.commandSequence ?? state.lastAcceptedSequence,
    });
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "AGENT_LEASE_CLAIMED",
      {
        leaseEpoch: next.leaseEpoch,
        deviceId: claim.deviceId,
      },
      claim.now,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ?, holder_connection_id = ? WHERE singleton = 1",
          JSON.stringify(next),
          claim.connectionId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    if (Date.parse(claim.expiresAt) > Date.now()) {
      await this.ctx.storage.setAlarm(Date.parse(claim.expiresAt));
    }
    return { ok: true, leaseEpoch: next.leaseEpoch, eventSequence: sequence };
  }

  acceptAuthenticatedCommand(
    candidate: unknown,
  ):
    | { ok: true; eventSequence: number; action: BrowserAction }
    | { ok: false; code: string } {
    const parsed = commandDispatchSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "INVALID_DISPATCH" };
    const input = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    if (row.holder_connection_id !== input.connectionId) {
      return { ok: false, code: "STALE_CONNECTOR" };
    }
    const current = browserControlStateSchema.parse(JSON.parse(row.state_json));
    const acceptance = acceptBrowserCommand(
      current,
      input.envelope,
      metadata.site,
      input.now,
    );
    if (!acceptance.ok) return acceptance;

    const retainedActions = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM accepted_actions")
      .toArray()[0]?.count;
    if ((retainedActions ?? 0) >= 5_000) {
      return { ok: false, code: "SESSION_STORAGE_QUOTA_EXCEEDED" };
    }

    const window = input.now.slice(0, 16);
    const usage =
      this.ctx.storage.sql
        .exec<{ accepted_count: number }>(
          "SELECT accepted_count FROM command_quota_windows WHERE window_started_at = ?",
          window,
        )
        .toArray()[0]?.accepted_count ?? 0;
    if (usage >= 120) return { ok: false, code: "COMMAND_QUOTA_EXCEEDED" };
    const duplicateAction = this.ctx.storage.sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM accepted_actions
         WHERE action_id = ? OR command_sequence = ?`,
        input.envelope.actionId,
        input.envelope.sequence,
      )
      .toArray()[0];
    if (duplicateAction) return { ok: false, code: "ACTION_ALREADY_ACCEPTED" };

    const mutationClass = mutationClassFor(input.envelope);
    const baseAction = {
      actionId: input.envelope.actionId,
      browserSessionId: input.envelope.browserSessionId,
      phase: "ACCEPTED",
      mutationClass,
      acceptedAt: input.now,
      updatedAt: input.now,
      postcondition: "UNOBSERVED",
    } as const;
    const action: BrowserAction =
      "workflowKind" in input.envelope
        ? {
            ...baseAction,
            jobId: input.envelope.jobId,
            jobRevision: input.envelope.jobRevision,
            objective: {
              kind: input.envelope.workflowKind,
              version: input.envelope.workflowVersion,
            },
            logicalStep: input.envelope.logicalStep,
            effectId: input.envelope.effectId,
            leaseEpoch: input.envelope.leaseEpoch,
          }
        : baseAction;
    const sequence = metadata.event_sequence + 1;
    const eventType =
      "workflowKind" in input.envelope
        ? "WORKFLOW_ACTION_ACCEPTED"
        : "COMMAND_ACCEPTED";
    const committed = this.ctx.storage.transactionSync(() => {
      let effectReplay = false;
      let canonicalActionId: string | undefined;
      if ("workflowKind" in input.envelope) {
        const binding = this.bindWorkflowEffect(
          input.envelope,
          metadata,
          input.now,
        );
        if (!binding.ok) return binding;
        effectReplay = binding.effectReplay;
        canonicalActionId = binding.canonicalActionId;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO accepted_actions (action_id, command_sequence, action_json) VALUES (?, ?, ?)",
        action.actionId,
        input.envelope.sequence,
        JSON.stringify(action),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO command_quota_windows (window_started_at, accepted_count)
         VALUES (?, 1)
         ON CONFLICT(window_started_at) DO UPDATE SET accepted_count = accepted_count + 1`,
        window,
      );
      this.ctx.storage.sql.exec(
        "UPDATE control_state SET state_json = ? WHERE singleton = 1",
        JSON.stringify(acceptance.state),
      );
      this.ctx.storage.sql.exec(
        "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
        sequence,
      );
      const payload =
        "workflowKind" in input.envelope
          ? {
              action,
              commandSequence: input.envelope.sequence,
              effectReplay,
              canonicalActionId,
            }
          : {
              actionId: action.actionId,
              capability: input.envelope.command.capability,
              leaseEpoch: input.envelope.leaseEpoch,
              commandSequence: input.envelope.sequence,
            };
      const event = this.appendEventAt(sequence, eventType, payload, input.now);
      return {
        ok: true as const,
        event,
        effectReplay,
        canonicalActionId,
      };
    });
    if (!committed.ok) return committed;
    this.broadcastEvent(committed.event);
    return {
      ok: true,
      eventSequence: sequence,
      action,
      ...(committed.canonicalActionId === undefined
        ? {}
        : {
            effectReplay: committed.effectReplay,
            canonicalActionId: committed.canonicalActionId,
          }),
    };
  }

  recordWorkflowReceipt(candidate: unknown) {
    const parsed = workflowReceiptSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false as const, code: "INVALID_WORKFLOW_RECEIPT" };
    const { receipt, checkpoint } = parsed.data;
    const metadata = this.metadata();
    const controlRow = this.control();
    if (!metadata || !controlRow)
      return { ok: false as const, code: "NOT_INITIALIZED" };
    const control = browserControlStateSchema.parse(
      JSON.parse(controlRow.state_json),
    );
    if (
      metadata.site !== "OWNED_FIXTURE" ||
      metadata.principal_id !== receipt.principalId ||
      metadata.browser_session_id !== receipt.browserSessionId ||
      control.deviceId !== receipt.deviceId ||
      control.jobId !== receipt.jobId
    ) {
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    }
    if (
      parsed.data.connectionId !== undefined &&
      controlRow.holder_connection_id !== parsed.data.connectionId
    ) {
      return { ok: false as const, code: "STALE_CONNECTOR" };
    }
    if (
      checkpoint.principalId !== receipt.principalId ||
      checkpoint.deviceId !== receipt.deviceId ||
      checkpoint.jobId !== receipt.jobId ||
      checkpoint.browserSessionId !== receipt.browserSessionId ||
      checkpoint.jobRevision !== receipt.jobRevision ||
      checkpoint.objective.kind !== receipt.objective.kind ||
      checkpoint.objective.version !== receipt.objective.version ||
      receipt.leaseEpoch !== control.leaseEpoch
    ) {
      return { ok: false as const, code: "WORKFLOW_BINDING_MISMATCH" };
    }
    if (checkpoint.eventSequence !== metadata.event_sequence + 1) {
      return { ok: false as const, code: "STALE_CHECKPOINT_SEQUENCE" };
    }
    const actionRow = this.ctx.storage.sql
      .exec<ActionRow>(
        "SELECT action_json FROM accepted_actions WHERE action_id = ?",
        receipt.actionId,
      )
      .toArray()[0];
    if (!actionRow) return { ok: false as const, code: "ACTION_NOT_FOUND" };
    const action = JSON.parse(actionRow.action_json) as BrowserAction;
    if (
      !("objective" in action) ||
      action.jobId !== receipt.jobId ||
      action.jobRevision !== receipt.jobRevision ||
      action.logicalStep !== receipt.logicalStep ||
      action.effectId !== receipt.effectId ||
      action.leaseEpoch !== receipt.leaseEpoch
    ) {
      return { ok: false as const, code: "WORKFLOW_BINDING_MISMATCH" };
    }
    const completed = checkpoint.completedEffects.some(
      (entry) =>
        entry.logicalStep === receipt.logicalStep &&
        entry.effectId === receipt.effectId,
    );
    if (
      receipt.outcome !== "POSTCONDITION_SATISFIED" ||
      !completed ||
      checkpoint.actionPhase !== "RECEIPTED"
    ) {
      return { ok: false as const, code: "RECEIPT_NOT_SATISFIED" };
    }
    const existing = this.ctx.storage.sql
      .exec<{ receipt_id: string }>(
        "SELECT receipt_id FROM workflow_receipts WHERE effect_id = ?",
        receipt.effectId,
      )
      .toArray()[0];
    if (existing) {
      return existing.receipt_id === receipt.receiptId
        ? {
            ok: true as const,
            eventSequence: metadata.event_sequence,
            replayed: true as const,
          }
        : { ok: false as const, code: "CONFLICTING_RECEIPT" };
    }
    const stepOrder = setupLogicalStepSchema.options;
    const stepIndex = stepOrder.indexOf(receipt.logicalStep);
    const shouldAdvance =
      checkpoint.currentStep === receipt.logicalStep &&
      receipt.logicalStep !== "FINALIZE_SETUP";
    const derivedEffectId = `efx_${checkpoint.checkpointId.slice(4)}`;
    const nextEffectId =
      derivedEffectId === receipt.effectId
        ? `${derivedEffectId.slice(0, -1)}${derivedEffectId.endsWith("0") ? "1" : "0"}`
        : derivedEffectId;
    const canonicalCheckpoint = shouldAdvance
      ? setupCheckpointSchema.parse({
          ...checkpoint,
          currentStep: stepOrder[stepIndex + 1],
          currentEffectId: nextEffectId,
          actionPhase: "ACCEPTED",
        })
      : checkpoint;
    if (this.checkpointEffectConflicts(canonicalCheckpoint)) {
      return { ok: false as const, code: "LOGICAL_EFFECT_CONFLICT" };
    }

    const event = this.commitTransition(
      canonicalCheckpoint.eventSequence,
      "WORKFLOW_CHECKPOINT_RECEIPTED",
      { receipt, checkpoint: canonicalCheckpoint },
      receipt.recordedAt,
      () => {
        this.ctx.storage.sql.exec(
          `INSERT INTO workflow_receipts
           (receipt_id, effect_id, receipt_json, recorded_at) VALUES (?, ?, ?, ?)`,
          receipt.receiptId,
          receipt.effectId,
          JSON.stringify(receipt),
          receipt.recordedAt,
        );
        this.ctx.storage.sql.exec(
          `UPDATE workflow_effects
           SET phase = 'RECEIPTED', receipt_id = ?, checkpoint_id = ?, updated_at = ?
           WHERE logical_step = ? AND effect_id = ?`,
          receipt.receiptId,
          checkpoint.checkpointId,
          receipt.recordedAt,
          receipt.logicalStep,
          receipt.effectId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE accepted_actions SET action_json = ? WHERE action_id = ?",
          JSON.stringify({
            ...action,
            phase: "RECEIPTED",
            postcondition: "SATISFIED",
            updatedAt: receipt.recordedAt,
          }),
          receipt.actionId,
        );
        this.bindCheckpointEffect(canonicalCheckpoint);
        this.ctx.storage.sql.exec(
          `INSERT INTO workflow_checkpoint
           (singleton, checkpoint_json, event_sequence) VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             checkpoint_json = excluded.checkpoint_json,
             event_sequence = excluded.event_sequence`,
          JSON.stringify(canonicalCheckpoint),
          canonicalCheckpoint.eventSequence,
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          canonicalCheckpoint.eventSequence,
        );
      },
    );
    this.broadcastEvent(event);
    return {
      ok: true as const,
      eventSequence: canonicalCheckpoint.eventSequence,
    };
  }

  async claimFreshWorkflowLease(candidate: unknown) {
    const parsed = freshWorkflowLeaseSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false as const, code: "INVALID_LEASE_CLAIM" };
    const input = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row)
      return { ok: false as const, code: "NOT_INITIALIZED" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      metadata.principal_id !== input.principalId ||
      metadata.browser_session_id !== input.browserSessionId ||
      state.deviceId !== input.deviceId ||
      state.jobId !== input.jobId
    ) {
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    }
    if (
      metadata.event_sequence !== input.cursor ||
      state.leaseEpoch !== input.afterLeaseEpoch
    ) {
      return { ok: false as const, code: "STALE_WORKFLOW_BINDING" };
    }
    if (
      state.connection !== "ONLINE" ||
      state.controller !== "USER" ||
      state.takeover !== "NONE" ||
      !state.automationBlocked ||
      row.holder_connection_id !== null ||
      Date.parse(input.expiresAt) <= Date.parse(input.now) ||
      Date.parse(input.expiresAt) - Date.parse(input.now) > 60_000
    ) {
      return { ok: false as const, code: "LEASE_CONFLICT" };
    }
    const returning = transitionBrowserControl(state, {
      type: "RETURN_CONTROL_REQUESTED",
    });
    if (!returning.ok) return returning;
    const reconciled = transitionBrowserControl(returning.state, {
      type: "AGENT_RECONCILED",
      leaseExpiresAt: input.expiresAt,
    });
    if (!reconciled.ok) return reconciled;
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "AGENT_LEASE_RECLAIMED",
      { leaseEpoch: reconciled.state.leaseEpoch },
      input.now,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ?, holder_connection_id = ? WHERE singleton = 1",
          JSON.stringify(reconciled.state),
          input.connectionId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    if (Date.parse(input.expiresAt) > Date.now()) {
      await this.ctx.storage.setAlarm(Date.parse(input.expiresAt));
    }
    return {
      ok: true as const,
      leaseEpoch: reconciled.state.leaseEpoch,
      eventSequence: sequence,
    };
  }

  takeoverWorkflowControl(candidate: unknown) {
    const parsed = workflowTakeoverSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false as const, code: "INVALID_TAKEOVER" };
    const input = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row)
      return { ok: false as const, code: "NOT_INITIALIZED" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      metadata.principal_id !== input.principalId ||
      metadata.browser_session_id !== input.browserSessionId ||
      state.deviceId !== input.deviceId ||
      state.jobId !== input.jobId ||
      row.holder_connection_id !== input.connectionId
    ) {
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    }
    if (
      metadata.event_sequence !== input.cursor ||
      state.leaseEpoch !== input.expectedLeaseEpoch
    ) {
      return { ok: false as const, code: "STALE_WORKFLOW_BINDING" };
    }
    if (
      state.controller !== "AGENT" ||
      state.connection !== "ONLINE" ||
      state.automationBlocked ||
      state.takeover !== "NONE"
    ) {
      return { ok: false as const, code: "TAKEOVER_CONFLICT" };
    }
    const requested = transitionBrowserControl(state, {
      type: "ONLINE_TAKEOVER_REQUESTED",
    });
    if (!requested.ok) return requested;
    const quiesced = transitionBrowserControl(requested.state, {
      type: "TAKEOVER_QUIESCED",
    });
    if (!quiesced.ok) return quiesced;
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "OWNER_CONTROL_TAKEN",
      { leaseEpoch: quiesced.state.leaseEpoch },
      input.now,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
          JSON.stringify(quiesced.state),
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    return {
      ok: true as const,
      leaseEpoch: quiesced.state.leaseEpoch,
      eventSequence: sequence,
    };
  }

  recordOwnerProgress(candidate: unknown) {
    const parsed = ownerProgressSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false as const, code: "INVALID_OWNER_PROGRESS" };
    const input = parsed.data;
    const metadata = this.metadata();
    const controlRow = this.control();
    if (!metadata || !controlRow)
      return { ok: false as const, code: "NOT_INITIALIZED" };
    const control = browserControlStateSchema.parse(
      JSON.parse(controlRow.state_json),
    );
    if (
      metadata.principal_id !== input.principalId ||
      metadata.browser_session_id !== input.browserSessionId ||
      metadata.site !== "OWNED_FIXTURE" ||
      metadata.workflow_job_revision !== input.jobRevision ||
      control.deviceId !== input.deviceId ||
      control.jobId !== input.jobId ||
      control.controller !== "USER" ||
      !control.automationBlocked ||
      control.leaseEpoch !== input.leaseEpoch ||
      input.cursor !== metadata.event_sequence
    ) {
      return { ok: false as const, code: "OWNER_PROGRESS_IDENTITY_MISMATCH" };
    }
    const existingStep = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE logical_step = ?",
        input.logicalStep,
      )
      .toArray()[0];
    const existingEffect = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE effect_id = ?",
        input.effectId,
      )
      .toArray()[0];
    if (
      (existingStep && existingStep.effect_id !== input.effectId) ||
      (existingEffect && existingEffect.logical_step !== input.logicalStep)
    ) {
      return { ok: false as const, code: "LOGICAL_EFFECT_CONFLICT" };
    }
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "WORKFLOW_OWNER_PROGRESS_RECORDED",
      {
        jobId: input.jobId,
        objective: input.objective,
        jobRevision: input.jobRevision,
        logicalStep: input.logicalStep,
        effectId: input.effectId,
        actionPhase: input.actionPhase,
        actor: "OWNER",
      },
      input.occurredAt,
      () => {
        if (!existingStep && !existingEffect) {
          this.ctx.storage.sql.exec(
            `INSERT INTO workflow_effects
             (logical_step, effect_id, job_revision, capability, canonical_action_id,
              phase, receipt_id, checkpoint_id, updated_at)
             VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)`,
            input.logicalStep,
            input.effectId,
            input.jobRevision,
            input.actionPhase,
            input.occurredAt,
          );
        } else {
          this.ctx.storage.sql.exec(
            `UPDATE workflow_effects SET phase = ?, updated_at = ?
             WHERE logical_step = ? AND effect_id = ?`,
            input.actionPhase,
            input.occurredAt,
            input.logicalStep,
            input.effectId,
          );
        }
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    return { ok: true as const, eventSequence: sequence, cursor: sequence };
  }

  workflowSnapshot(principalId: unknown) {
    const identity = principalIdSchema.safeParse(principalId);
    const metadata = this.metadata();
    if (
      !identity.success ||
      !metadata ||
      metadata.principal_id !== identity.data
    )
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    const checkpointRow = this.ctx.storage.sql
      .exec<{ checkpoint_json: string }>(
        "SELECT checkpoint_json FROM workflow_checkpoint WHERE singleton = 1",
      )
      .toArray()[0];
    const effects = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        `SELECT logical_step, effect_id, job_revision, capability,
                canonical_action_id, phase, receipt_id, checkpoint_id, updated_at
         FROM workflow_effects ORDER BY rowid`,
      )
      .toArray()
      .map((row) => ({
        logicalStep: row.logical_step,
        effectId: row.effect_id,
        jobRevision: row.job_revision,
        capability: row.capability,
        canonicalActionId: row.canonical_action_id,
        phase: row.phase,
        receiptId: row.receipt_id,
        checkpointId: row.checkpoint_id,
        updatedAt: row.updated_at,
      }));
    return {
      ok: true as const,
      checkpoint: checkpointRow
        ? setupCheckpointSchema.parse(JSON.parse(checkpointRow.checkpoint_json))
        : null,
      effects,
      eventSequence: metadata.event_sequence,
      jobRevision: metadata.workflow_job_revision,
    };
  }

  acceptAuthenticatedResult(candidate: unknown) {
    const parsed = resultDispatchSchema.safeParse(candidate);
    if (!parsed.success)
      return { ok: false as const, code: "INVALID_RESULT_DISPATCH" };
    const input = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row)
      return { ok: false as const, code: "NOT_INITIALIZED" };
    if (row.holder_connection_id !== input.connectionId)
      return { ok: false as const, code: "STALE_CONNECTOR" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      input.envelope.principalId !== metadata.principal_id ||
      input.envelope.deviceId !== state.deviceId ||
      input.envelope.jobId !== state.jobId ||
      input.envelope.browserSessionId !== metadata.browser_session_id
    ) {
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    }
    if (
      input.envelope.leaseEpoch !== state.leaseEpoch ||
      state.controller !== "AGENT" ||
      state.automationBlocked
    ) {
      return { ok: false as const, code: "STALE_LEASE_EPOCH" };
    }
    if (
      Date.parse(input.envelope.issuedAt) > Date.parse(input.now) ||
      Date.parse(input.envelope.expiresAt) <= Date.parse(input.now)
    ) {
      return { ok: false as const, code: "EXPIRED_OR_NOT_YET_VALID" };
    }
    if (input.envelope.sequence <= metadata.last_result_sequence) {
      return { ok: false as const, code: "REPLAYED_RESULT_SEQUENCE" };
    }
    const actionRow = this.ctx.storage.sql
      .exec<ActionRow>(
        "SELECT action_json FROM accepted_actions WHERE action_id = ?",
        input.envelope.actionId,
      )
      .toArray()[0];
    if (!actionRow) return { ok: false as const, code: "ACTION_NOT_FOUND" };
    const action = JSON.parse(actionRow.action_json) as BrowserAction;
    if (!resultMatchesActionBinding(action, input.envelope)) {
      return { ok: false as const, code: "ACTION_BINDING_MISMATCH" };
    }
    const updated = updateActionFromResult(action, input.envelope, input.now);
    const eventSequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      eventSequence,
      "RESULT_ACCEPTED",
      {
        actionId: action.actionId,
        resultSequence: input.envelope.sequence,
        status: input.envelope.result.status,
        phase: updated.phase,
      },
      input.now,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE accepted_actions SET action_json = ? WHERE action_id = ?",
          JSON.stringify(updated),
          action.actionId,
        );
        this.ctx.storage.sql.exec(
          `UPDATE session_metadata
           SET event_sequence = ?, last_result_sequence = ? WHERE singleton = 1`,
          eventSequence,
          input.envelope.sequence,
        );
      },
    );
    this.broadcastEvent(event);
    return { ok: true as const, eventSequence, action: updated };
  }

  async renewAgentLease(
    candidate: unknown,
  ): Promise<{ ok: true; expiresAt: string } | { ok: false; code: string }> {
    const parsed = renewSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "INVALID_LEASE_RENEWAL" };
    const input = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      metadata.principal_id !== input.principalId ||
      state.deviceId !== input.deviceId ||
      row.holder_connection_id !== input.connectionId
    )
      return { ok: false, code: "IDENTITY_MISMATCH" };
    if (
      state.controller !== "AGENT" ||
      state.leaseEpoch !== input.leaseEpoch ||
      state.leaseExpiresAt === null ||
      state.leaseExpiresAt <= input.now ||
      input.expiresAt <= input.now ||
      Date.parse(input.expiresAt) - Date.parse(input.now) > 60_000
    )
      return { ok: false, code: "STALE_LEASE" };
    this.ctx.storage.sql.exec(
      "UPDATE control_state SET state_json = ? WHERE singleton = 1",
      JSON.stringify({ ...state, leaseExpiresAt: input.expiresAt }),
    );
    if (Date.parse(input.expiresAt) > Date.now()) {
      await this.ctx.storage.setAlarm(Date.parse(input.expiresAt));
    }
    return { ok: true, expiresAt: input.expiresAt };
  }

  override async alarm(): Promise<void> {
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return;
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (state.controller !== "AGENT" || state.leaseExpiresAt === null) return;

    const expiredAt = new Date().toISOString();
    const transitioned = transitionBrowserControl(state, {
      type: "HOST_WENT_OFFLINE",
    });
    if (!transitioned.ok) return;
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "AGENT_LEASE_EXPIRED",
      { leaseEpoch: state.leaseEpoch },
      expiredAt,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
          JSON.stringify(transitioned.state),
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
  }

  hostDisconnected(
    candidate: unknown,
  ): { ok: true } | { ok: false; code: string } {
    const parsed = leaseOperationSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, code: "INVALID_DISCONNECT" };
    const input = parsed.data;
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      metadata.principal_id !== input.principalId ||
      state.deviceId !== input.deviceId ||
      row.holder_connection_id !== input.connectionId ||
      state.leaseEpoch !== input.leaseEpoch
    )
      return { ok: false, code: "STALE_CONNECTOR" };
    const transitioned = transitionBrowserControl(state, {
      type: "HOST_WENT_OFFLINE",
    });
    if (!transitioned.ok) return transitioned;
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "HOST_DISCONNECTED",
      { leaseEpoch: state.leaseEpoch },
      input.now,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
          JSON.stringify(transitioned.state),
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    return { ok: true };
  }

  hostReconnected(
    principalId: unknown,
    deviceId: unknown,
    now: unknown,
  ): { ok: true } | { ok: false; code: string } {
    const parsed = z
      .strictObject({
        principalId: principalIdSchema,
        deviceId: deviceIdSchema,
        now: instantSchema,
      })
      .safeParse({ principalId, deviceId, now });
    const metadata = this.metadata();
    const row = this.control();
    if (!parsed.success || !metadata || !row)
      return { ok: false, code: "INVALID_RECONNECT" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (
      metadata.principal_id !== parsed.data.principalId ||
      state.deviceId !== parsed.data.deviceId
    )
      return { ok: false, code: "IDENTITY_MISMATCH" };
    if (state.connection !== "OFFLINE" || state.controller !== "NONE") {
      return { ok: false, code: "ILLEGAL_TRANSITION" };
    }
    const online = browserControlStateSchema.parse({
      ...state,
      connection: "ONLINE",
      takeover: "RECONCILING",
      automationBlocked: true,
      leaseExpiresAt: null,
    });
    const retainedActions = this.ctx.storage.sql
      .exec<ActionRow>("SELECT action_json FROM accepted_actions")
      .toArray()
      .map((action) => JSON.parse(action.action_json) as BrowserAction);
    const recovery = reconcileBrowserRecovery({
      state: online,
      actions: retainedActions,
      now: parsed.data.now,
    });
    const retainedActionById = new Map(
      retainedActions.map((action) => [action.actionId, action]),
    );
    const sequence = metadata.event_sequence + 1;
    const event = this.commitTransition(
      sequence,
      "HOST_RECONNECTED",
      {
        priorLeaseEpoch: state.leaseEpoch,
        continuation: recovery.continuation,
      },
      parsed.data.now,
      () => {
        for (const reconciled of recovery.actions) {
          const existing = retainedActionById.get(reconciled.actionId);
          if (!existing || existing.phase === reconciled.phase) continue;
          this.ctx.storage.sql.exec(
            "UPDATE accepted_actions SET action_json = ? WHERE action_id = ?",
            JSON.stringify({
              ...existing,
              phase: reconciled.phase,
              updatedAt: parsed.data.now,
            }),
            existing.actionId,
          );
        }
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ? WHERE singleton = 1",
          JSON.stringify(recovery.control),
        );
        this.ctx.storage.sql.exec(
          "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
          sequence,
        );
      },
    );
    this.broadcastEvent(event);
    return { ok: true };
  }

  cancel(
    candidate: unknown,
    legacyNow?: unknown,
  ):
    | {
        ok: true;
        eventSequence?: number;
        jobRevision?: number;
        replayed?: boolean;
        acknowledgedAt?: string;
      }
    | { ok: false; code: string } {
    const modern = workflowCancellationSchema.safeParse(candidate);
    const legacyIdentity = principalIdSchema.safeParse(candidate);
    const legacyTimestamp = instantSchema.safeParse(legacyNow);
    if (
      !modern.success &&
      (!legacyIdentity.success || !legacyTimestamp.success)
    )
      return { ok: false, code: "INVALID_CANCEL" };
    const principalId = modern.success
      ? modern.data.principalId
      : legacyIdentity.data;
    const timestamp = modern.success
      ? modern.data.now
      : legacyTimestamp.success
        ? legacyTimestamp.data
        : "";
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    if (metadata.principal_id !== principalId)
      return { ok: false, code: "IDENTITY_MISMATCH" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    if (modern.success) {
      if (state.jobId !== modern.data.jobId)
        return { ok: false, code: "JOB_IDENTITY_MISMATCH" };
      const replay = this.ctx.storage.sql
        .exec<{
          job_id: string;
          expected_job_revision: number;
          resulting_job_revision: number;
          event_sequence: number;
          accepted_at: string;
        }>(
          "SELECT * FROM workflow_cancellations WHERE cancellation_id = ?",
          modern.data.cancellationId,
        )
        .toArray()[0];
      if (replay) {
        return replay.job_id === modern.data.jobId &&
          replay.expected_job_revision === modern.data.expectedJobRevision
          ? {
              ok: true,
              replayed: true,
              eventSequence: replay.event_sequence,
              jobRevision: replay.resulting_job_revision,
              acknowledgedAt: replay.accepted_at,
            }
          : { ok: false, code: "CANCELLATION_REPLAY_CONFLICT" };
      }
      if (
        metadata.workflow_job_revision !== null &&
        metadata.workflow_job_revision !== modern.data.expectedJobRevision
      ) {
        return { ok: false, code: "STALE_JOB_REVISION" };
      }
    }
    const transitioned = transitionBrowserControl(state, {
      type: "JOB_CANCELED",
    });
    if (!transitioned.ok) return transitioned;
    const sequence = metadata.event_sequence + 1;
    const resultingRevision = modern.success
      ? modern.data.expectedJobRevision + 1
      : metadata.workflow_job_revision;
    const event = this.commitTransition(
      sequence,
      "AUTOMATION_CANCELED",
      modern.success
        ? {
            cancellationId: modern.data.cancellationId,
            jobId: modern.data.jobId,
            expectedJobRevision: modern.data.expectedJobRevision,
            jobRevision: modern.data.expectedJobRevision + 1,
            leaseEpoch: transitioned.state.leaseEpoch,
          }
        : { leaseEpoch: transitioned.state.leaseEpoch },
      timestamp,
      () => {
        this.ctx.storage.sql.exec(
          "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
          JSON.stringify(transitioned.state),
        );
        this.ctx.storage.sql.exec(
          `UPDATE session_metadata
           SET event_sequence = ?, workflow_job_revision = COALESCE(?, workflow_job_revision)
           WHERE singleton = 1`,
          sequence,
          resultingRevision,
        );
        if (modern.success) {
          this.ctx.storage.sql.exec(
            `INSERT INTO workflow_cancellations
             (cancellation_id, job_id, expected_job_revision,
              resulting_job_revision, event_sequence, accepted_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            modern.data.cancellationId,
            modern.data.jobId,
            modern.data.expectedJobRevision,
            resultingRevision,
            sequence,
            modern.data.now,
          );
        }
      },
    );
    this.broadcastEvent(event);
    return modern.success
      ? {
          ok: true,
          replayed: false,
          eventSequence: sequence,
          jobRevision: modern.data.expectedJobRevision + 1,
          acknowledgedAt: modern.data.now,
        }
      : { ok: true };
  }

  eventsAfter(principalId: unknown, cursor: unknown, limit: unknown = 100) {
    const identity = principalIdSchema.safeParse(principalId);
    const parsedCursor = z.number().int().nonnegative().safeParse(cursor);
    const parsedLimit = z.number().int().positive().max(100).safeParse(limit);
    const metadata = this.metadata();
    if (!identity.success || !parsedCursor.success || !parsedLimit.success)
      return { ok: false as const, code: "INVALID_CURSOR" };
    if (!metadata || metadata.principal_id !== identity.data)
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    const window = new Date().toISOString().slice(0, 16);
    const usage =
      this.ctx.storage.sql
        .exec<{ request_count: number }>(
          "SELECT request_count FROM event_stream_quota_windows WHERE window_started_at = ?",
          window,
        )
        .toArray()[0]?.request_count ?? 0;
    if (usage >= 300)
      return { ok: false as const, code: "EVENT_STREAM_QUOTA_EXCEEDED" };
    this.ctx.storage.sql.exec(
      `INSERT INTO event_stream_quota_windows (window_started_at, request_count)
       VALUES (?, 1)
       ON CONFLICT(window_started_at) DO UPDATE SET request_count = request_count + 1`,
      window,
    );
    const events = this.eventPage(parsedCursor.data, parsedLimit.data);
    return {
      ok: true as const,
      events,
      latestSequence: metadata.event_sequence,
    };
  }

  pendingProjection(principalId: unknown, limit: unknown = 100) {
    const identity = principalIdSchema.safeParse(principalId);
    const parsedLimit = z.number().int().positive().max(100).safeParse(limit);
    const metadata = this.metadata();
    if (
      !identity.success ||
      !parsedLimit.success ||
      !metadata ||
      metadata.principal_id !== identity.data
    )
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    const events = this.ctx.storage.sql
      .exec<{ sequence: number; payload_json: string }>(
        `SELECT sequence, payload_json FROM projection_outbox
         WHERE projected_at IS NULL ORDER BY sequence LIMIT ?`,
        parsedLimit.data,
      )
      .toArray()
      .map((row) => JSON.parse(row.payload_json) as CoordinatorEvent);
    return { ok: true as const, events };
  }

  markProjected(principalId: unknown, throughSequence: unknown, now: unknown) {
    const identity = principalIdSchema.safeParse(principalId);
    const through = z.number().int().positive().safeParse(throughSequence);
    const timestamp = instantSchema.safeParse(now);
    const metadata = this.metadata();
    if (
      !identity.success ||
      !through.success ||
      !timestamp.success ||
      !metadata ||
      metadata.principal_id !== identity.data
    )
      return { ok: false as const, code: "INVALID_PROJECTION_ACK" };
    if (through.data > metadata.event_sequence)
      return { ok: false as const, code: "INVALID_PROJECTION_ACK" };
    if (through.data <= metadata.projected_sequence)
      return { ok: true as const };
    const acknowledgable =
      this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM projection_outbox
           WHERE sequence > ? AND sequence <= ?`,
          metadata.projected_sequence,
          through.data,
        )
        .toArray()[0]?.count ?? 0;
    if (acknowledgable !== through.data - metadata.projected_sequence) {
      return { ok: false as const, code: "PROJECTION_SEQUENCE_GAP" };
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE projection_outbox SET projected_at = ? WHERE sequence <= ?",
        timestamp.data,
        through.data,
      );
      this.ctx.storage.sql.exec(
        "UPDATE session_metadata SET projected_sequence = MAX(projected_sequence, ?) WHERE singleton = 1",
        through.data,
      );
    });
    return { ok: true as const };
  }

  action(principalId: unknown, actionId: unknown) {
    const identity = principalIdSchema.safeParse(principalId);
    const metadata = this.metadata();
    if (
      !identity.success ||
      !metadata ||
      metadata.principal_id !== identity.data
    )
      return { ok: false as const, code: "IDENTITY_MISMATCH" };
    const row = this.ctx.storage.sql
      .exec<ActionRow>(
        "SELECT action_json FROM accepted_actions WHERE action_id = ?",
        String(actionId),
      )
      .toArray()[0];
    return row
      ? {
          ok: true as const,
          action: JSON.parse(row.action_json) as BrowserAction,
        }
      : { ok: false as const, code: "ACTION_NOT_FOUND" };
  }

  snapshot(principalId: unknown):
    | {
        ok: true;
        control: BrowserControlState;
        site: Site;
        eventSequence: number;
        projectionLag: number;
        canceled: boolean;
      }
    | { ok: false; code: string } {
    const parsed = principalIdSchema.safeParse(principalId);
    if (!parsed.success) return { ok: false, code: "INVALID_PRINCIPAL" };
    const metadata = this.metadata();
    const row = this.control();
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    if (metadata.principal_id !== parsed.data) {
      return { ok: false, code: "IDENTITY_MISMATCH" };
    }
    return {
      ok: true,
      control: browserControlStateSchema.parse(JSON.parse(row.state_json)),
      site: metadata.site,
      eventSequence: metadata.event_sequence,
      projectionLag: metadata.event_sequence - metadata.projected_sequence,
      canceled:
        (this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM coordinator_events WHERE type = 'AUTOMATION_CANCELED'",
          )
          .toArray()[0]?.count ?? 0) > 0,
    };
  }

  private bindWorkflowEffect(
    envelope: Extract<SignedCommandEnvelope, { workflowKind: string }>,
    metadata: MetadataRow,
    now: string,
  ):
    | {
        ok: true;
        effectReplay: boolean;
        canonicalActionId: string;
      }
    | { ok: false; code: string } {
    if (metadata.site !== "OWNED_FIXTURE") {
      return { ok: false, code: "DESTINATION_SITE_MISMATCH" };
    }
    if (
      metadata.workflow_job_revision !== null &&
      metadata.workflow_job_revision !== envelope.jobRevision
    ) {
      return { ok: false, code: "STALE_JOB_REVISION" };
    }
    const byStep = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE logical_step = ?",
        envelope.logicalStep,
      )
      .toArray()[0];
    const byEffect = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE effect_id = ?",
        envelope.effectId,
      )
      .toArray()[0];
    if (
      (byStep && byStep.effect_id !== envelope.effectId) ||
      (byEffect && byEffect.logical_step !== envelope.logicalStep) ||
      (byStep && byStep.job_revision !== envelope.jobRevision)
    ) {
      return { ok: false, code: "LOGICAL_EFFECT_CONFLICT" };
    }
    const effect = byStep ?? byEffect;
    const mutating = !["OBSERVE_SETUP", "VERIFY_SETUP"].includes(
      envelope.command.capability,
    );
    if (
      effect &&
      effect.capability !== null &&
      mutating &&
      effect.capability !== envelope.command.capability
    ) {
      return { ok: false, code: "LOGICAL_EFFECT_CONFLICT" };
    }
    if (effect?.phase === "RECEIPTED") {
      return {
        ok: true,
        effectReplay: true,
        canonicalActionId: effect.canonical_action_id ?? envelope.actionId,
      };
    }
    if (!effect) {
      this.ctx.storage.sql.exec(
        `INSERT INTO workflow_effects
         (logical_step, effect_id, job_revision, capability, canonical_action_id,
          phase, receipt_id, checkpoint_id, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ACCEPTED', NULL, NULL, ?)`,
        envelope.logicalStep,
        envelope.effectId,
        envelope.jobRevision,
        mutating ? envelope.command.capability : null,
        mutating ? envelope.actionId : null,
        now,
      );
      this.ctx.storage.sql.exec(
        `UPDATE session_metadata SET workflow_job_revision = ?
         WHERE singleton = 1 AND workflow_job_revision IS NULL`,
        envelope.jobRevision,
      );
      return {
        ok: true,
        effectReplay: false,
        canonicalActionId: envelope.actionId,
      };
    }
    if (mutating && effect.canonical_action_id === null) {
      this.ctx.storage.sql.exec(
        `UPDATE workflow_effects SET capability = ?, canonical_action_id = ?,
           updated_at = ? WHERE logical_step = ?`,
        envelope.command.capability,
        envelope.actionId,
        now,
        envelope.logicalStep,
      );
      return {
        ok: true,
        effectReplay: false,
        canonicalActionId: envelope.actionId,
      };
    }
    return {
      ok: true,
      effectReplay: true,
      canonicalActionId: effect.canonical_action_id ?? envelope.actionId,
    };
  }

  private bindCheckpointEffect(
    checkpoint: z.infer<typeof setupCheckpointSchema>,
  ): void {
    const existingStep = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE logical_step = ?",
        checkpoint.currentStep,
      )
      .toArray()[0];
    const existingEffect = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE effect_id = ?",
        checkpoint.currentEffectId,
      )
      .toArray()[0];
    if (
      (existingStep && existingStep.effect_id !== checkpoint.currentEffectId) ||
      (existingEffect && existingEffect.logical_step !== checkpoint.currentStep)
    ) {
      throw new Error("LOGICAL_EFFECT_CONFLICT");
    }
    if (!existingStep && !existingEffect) {
      this.ctx.storage.sql.exec(
        `INSERT INTO workflow_effects
         (logical_step, effect_id, job_revision, capability, canonical_action_id,
          phase, receipt_id, checkpoint_id, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 'ACCEPTED', NULL, ?, ?)`,
        checkpoint.currentStep,
        checkpoint.currentEffectId,
        checkpoint.jobRevision,
        checkpoint.checkpointId,
        checkpoint.createdAt,
      );
    }
  }

  private checkpointEffectConflicts(
    checkpoint: z.infer<typeof setupCheckpointSchema>,
  ): boolean {
    const existingStep = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE logical_step = ?",
        checkpoint.currentStep,
      )
      .toArray()[0];
    const existingEffect = this.ctx.storage.sql
      .exec<WorkflowEffectRow>(
        "SELECT * FROM workflow_effects WHERE effect_id = ?",
        checkpoint.currentEffectId,
      )
      .toArray()[0];
    return Boolean(
      (existingStep && existingStep.effect_id !== checkpoint.currentEffectId) ||
      (existingEffect &&
        existingEffect.logical_step !== checkpoint.currentStep),
    );
  }

  private metadata(): MetadataRow | undefined {
    return this.ctx.storage.sql
      .exec<MetadataRow>("SELECT * FROM session_metadata WHERE singleton = 1")
      .toArray()[0];
  }

  private control(): ControlRow | undefined {
    return this.ctx.storage.sql
      .exec<ControlRow>("SELECT * FROM control_state WHERE singleton = 1")
      .toArray()[0];
  }

  private appendEventAt(
    sequence: number,
    type: string,
    payload: unknown,
    occurredAt: string,
  ): CoordinatorEvent {
    const event = { sequence, type, payload, occurredAt };
    this.ctx.storage.sql.exec(
      "INSERT INTO coordinator_events (sequence, type, payload_json, occurred_at) VALUES (?, ?, ?, ?)",
      sequence,
      type,
      JSON.stringify(payload),
      occurredAt,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO projection_outbox (sequence, payload_json, projected_at) VALUES (?, ?, NULL)",
      sequence,
      JSON.stringify(event),
    );
    return event;
  }

  private commitTransition(
    sequence: number,
    type: string,
    payload: unknown,
    occurredAt: string,
    mutation: () => void,
  ): CoordinatorEvent {
    return this.ctx.storage.transactionSync(() => {
      mutation();
      return this.appendEventAt(sequence, type, payload, occurredAt);
    });
  }

  private broadcastEvent(event: CoordinatorEvent): void {
    const message = JSON.stringify({ type: "EVENT", event });
    for (const webSocket of this.ctx.getWebSockets()) {
      try {
        webSocket.send(message);
      } catch {
        webSocket.close(1011, "delivery failed");
      }
    }
  }

  private eventPage(cursor: number, limit: number) {
    return this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT sequence, type, payload_json, occurred_at FROM coordinator_events
         WHERE sequence > ? ORDER BY sequence LIMIT ?`,
        cursor,
        limit,
      )
      .toArray()
      .map((event) => ({
        sequence: event.sequence,
        type: event.type,
        payload: JSON.parse(event.payload_json) as unknown,
        occurredAt: event.occurred_at,
      }));
  }
}

function mutationClassFor(
  envelope: SignedCommandEnvelope,
): BrowserAction["mutationClass"] {
  switch (envelope.command.capability) {
    case "OBSERVE":
    case "VERIFY_AUTHENTICATION":
    case "OBSERVE_SETUP":
    case "VERIFY_SETUP":
      return "READ_ONLY";
    case "SESSION_OPEN":
    case "NAVIGATE":
    case "CHECKPOINT":
    case "REPLACE_DISPLAY_NAME":
    case "SELECT_ROLE":
    case "REPLACE_PREFERRED_FOCUS":
      return "IDEMPOTENT";
    case "FINALIZE_SETUP":
    case "REQUEST_SECRET_FILL":
    case "REQUEST_HUMAN_GATE":
      return "NON_IDEMPOTENT";
  }
}

function updateActionFromResult(
  action: BrowserAction,
  envelope: SignedResultEnvelope,
  now: string,
): BrowserAction {
  switch (envelope.result.status) {
    case "ACCEPTED":
      return { ...action, phase: "DISPATCHED", updatedAt: now };
    case "OBSERVATION":
    case "VERIFICATION":
      return {
        ...action,
        phase: "EFFECT_OBSERVED",
        updatedAt: now,
        postcondition:
          envelope.result.status === "VERIFICATION" &&
          ("verification" in envelope.result
            ? envelope.result.verification === "authenticated"
            : envelope.result.complete)
            ? "SATISFIED"
            : "UNKNOWN",
      };
    case "REJECTED":
      return {
        ...action,
        phase: "RECEIPTED",
        updatedAt: now,
        postcondition: "NOT_SATISFIED",
      };
    case "WAITING_FOR_USER":
    case "RECONCILIATION_REQUIRED":
      return {
        ...action,
        phase: "RECONCILIATION_REQUIRED",
        updatedAt: now,
        postcondition: "UNKNOWN",
      };
  }
}

function resultMatchesActionBinding(
  action: BrowserAction,
  envelope: SignedResultEnvelope,
): boolean {
  if ("objective" in action) {
    return (
      "workflowKind" in envelope &&
      envelope.workflowKind === action.objective.kind &&
      envelope.workflowVersion === action.objective.version &&
      envelope.jobId === action.jobId &&
      envelope.jobRevision === action.jobRevision &&
      envelope.logicalStep === action.logicalStep &&
      envelope.effectId === action.effectId &&
      envelope.leaseEpoch === action.leaseEpoch
    );
  }
  return !("workflowKind" in envelope);
}
