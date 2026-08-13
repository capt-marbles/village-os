import { DurableObject } from "cloudflare:workers";
import {
  browserControlStateSchema,
  browserSessionIdSchema,
  deviceIdSchema,
  instantSchema,
  principalIdSchema,
  type BrowserControlState,
  type Site,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../../env.js";

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

type MetadataRow = {
  principal_id: string;
  browser_session_id: string;
  site: Site;
  event_sequence: number;
  projected_sequence: number;
};

type ControlRow = {
  state_json: string;
  holder_connection_id: string | null;
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
        INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at)
        VALUES (1, datetime('now'));
      `);
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
       (singleton, principal_id, browser_session_id, site, event_sequence, projected_sequence)
       VALUES (1, ?, ?, ?, 1, 0)`,
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

  claimAgentLease(
    candidate: unknown,
  ):
    | { ok: true; leaseEpoch: number; eventSequence: number }
    | { ok: false; code: string } {
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

    const next = browserControlStateSchema.parse({
      ...state,
      controller: "AGENT",
      leaseEpoch: state.leaseEpoch + 1,
      leaseExpiresAt: claim.expiresAt,
      automationBlocked: false,
      takeover: "NONE",
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
    return { ok: true, leaseEpoch: next.leaseEpoch, eventSequence: sequence };
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
