import { DurableObject } from "cloudflare:workers";
import {
  browserControlStateSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  principalIdSchema,
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

type MetadataRow = {
  principal_id: string;
  browser_session_id: string;
  site: Site;
  event_sequence: number;
  projected_sequence: number;
  last_result_sequence: number;
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
          ,last_result_sequence INTEGER NOT NULL DEFAULT 0
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
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
         VALUES (2, datetime('now'))`,
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
    this.appendEventAt(
      1,
      "SESSION_INITIALIZED",
      input.control,
      input.initializedAt,
    );
    return { ok: true };
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
    this.ctx.storage.sql.exec(
      "UPDATE control_state SET state_json = ?, holder_connection_id = ? WHERE singleton = 1",
      JSON.stringify(next),
      claim.connectionId,
    );
    this.ctx.storage.sql.exec(
      "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
      sequence,
    );
    this.appendEventAt(
      sequence,
      "AGENT_LEASE_CLAIMED",
      {
        leaseEpoch: next.leaseEpoch,
        deviceId: claim.deviceId,
      },
      claim.now,
    );
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

    const mutationClass = mutationClassFor(input.envelope);
    const action: BrowserAction = {
      actionId: input.envelope.actionId,
      browserSessionId: input.envelope.browserSessionId,
      phase: "ACCEPTED",
      mutationClass,
      acceptedAt: input.now,
      updatedAt: input.now,
      postcondition: "UNOBSERVED",
    };
    const sequence = metadata.event_sequence + 1;
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO accepted_actions (action_id, command_sequence, action_json) VALUES (?, ?, ?)",
        action.actionId,
        input.envelope.sequence,
        JSON.stringify(action),
      );
    } catch {
      return { ok: false, code: "ACTION_ALREADY_ACCEPTED" };
    }
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
    this.appendEventAt(
      sequence,
      "COMMAND_ACCEPTED",
      {
        actionId: action.actionId,
        capability: input.envelope.command.capability,
        leaseEpoch: input.envelope.leaseEpoch,
        commandSequence: input.envelope.sequence,
      },
      input.now,
    );
    return { ok: true, eventSequence: sequence, action };
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
    const updated = updateActionFromResult(action, input.envelope, input.now);
    const eventSequence = metadata.event_sequence + 1;
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
    this.appendEventAt(
      eventSequence,
      "RESULT_ACCEPTED",
      {
        actionId: action.actionId,
        resultSequence: input.envelope.sequence,
        status: input.envelope.result.status,
        phase: updated.phase,
      },
      input.now,
    );
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
    this.ctx.storage.sql.exec(
      "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
      JSON.stringify(transitioned.state),
    );
    this.ctx.storage.sql.exec(
      "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
      sequence,
    );
    this.appendEventAt(
      sequence,
      "AGENT_LEASE_EXPIRED",
      { leaseEpoch: state.leaseEpoch },
      expiredAt,
    );
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
    this.ctx.storage.sql.exec(
      "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
      JSON.stringify(transitioned.state),
    );
    this.ctx.storage.sql.exec(
      "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
      sequence,
    );
    this.appendEventAt(
      sequence,
      "HOST_DISCONNECTED",
      { leaseEpoch: state.leaseEpoch },
      input.now,
    );
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
    const next = browserControlStateSchema.parse({
      ...state,
      connection: "ONLINE",
      takeover: "RECONCILING",
      automationBlocked: true,
      leaseExpiresAt: null,
    });
    const sequence = metadata.event_sequence + 1;
    this.ctx.storage.sql.exec(
      "UPDATE control_state SET state_json = ? WHERE singleton = 1",
      JSON.stringify(next),
    );
    this.ctx.storage.sql.exec(
      "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
      sequence,
    );
    this.appendEventAt(
      sequence,
      "HOST_RECONNECTED",
      { priorLeaseEpoch: state.leaseEpoch },
      parsed.data.now,
    );
    return { ok: true };
  }

  cancel(
    principalId: unknown,
    now: unknown,
  ): { ok: true } | { ok: false; code: string } {
    const identity = principalIdSchema.safeParse(principalId);
    const timestamp = instantSchema.safeParse(now);
    const metadata = this.metadata();
    const row = this.control();
    if (!identity.success || !timestamp.success)
      return { ok: false, code: "INVALID_CANCEL" };
    if (!metadata || !row) return { ok: false, code: "NOT_INITIALIZED" };
    if (metadata.principal_id !== identity.data)
      return { ok: false, code: "IDENTITY_MISMATCH" };
    const state = browserControlStateSchema.parse(JSON.parse(row.state_json));
    const transitioned = transitionBrowserControl(state, {
      type: "JOB_CANCELED",
    });
    if (!transitioned.ok) return transitioned;
    const sequence = metadata.event_sequence + 1;
    this.ctx.storage.sql.exec(
      "UPDATE control_state SET state_json = ?, holder_connection_id = NULL WHERE singleton = 1",
      JSON.stringify(transitioned.state),
    );
    this.ctx.storage.sql.exec(
      "UPDATE session_metadata SET event_sequence = ? WHERE singleton = 1",
      sequence,
    );
    this.appendEventAt(
      sequence,
      "AUTOMATION_CANCELED",
      { leaseEpoch: transitioned.state.leaseEpoch },
      timestamp.data,
    );
    return { ok: true };
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
    const events = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT sequence, type, payload_json, occurred_at FROM coordinator_events
         WHERE sequence > ? ORDER BY sequence LIMIT ?`,
        parsedCursor.data,
        parsedLimit.data,
      )
      .toArray()
      .map((event) => ({
        sequence: event.sequence,
        type: event.type,
        payload: JSON.parse(event.payload_json) as unknown,
        occurredAt: event.occurred_at,
      }));
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
      .map(
        (row) =>
          JSON.parse(row.payload_json) as {
            sequence: number;
            type: string;
            payload: unknown;
            occurredAt: string;
          },
      );
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
    this.ctx.storage.sql.exec(
      "UPDATE projection_outbox SET projected_at = ? WHERE sequence <= ?",
      timestamp.data,
      through.data,
    );
    this.ctx.storage.sql.exec(
      "UPDATE session_metadata SET projected_sequence = MAX(projected_sequence, ?) WHERE singleton = 1",
      through.data,
    );
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
    };
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
  ): void {
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
  }
}

function mutationClassFor(
  envelope: SignedCommandEnvelope,
): BrowserAction["mutationClass"] {
  switch (envelope.command.capability) {
    case "OBSERVE":
    case "VERIFY_AUTHENTICATION":
      return "READ_ONLY";
    case "SESSION_OPEN":
    case "NAVIGATE":
    case "CHECKPOINT":
      return "IDEMPOTENT";
    case "FIXTURE_INPUT":
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
          envelope.result.verification === "authenticated"
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
