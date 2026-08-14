import {
  browserSessionIdSchema,
  instantSchema,
  principalIdSchema,
} from "@village/contracts";
import type { Environment } from "../../env.js";

type CoordinatorEvent = {
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
};

export async function projectSessionEvents(
  environment: Environment,
  principalCandidate: unknown,
  sessionCandidate: unknown,
  nowCandidate: unknown,
) {
  const principal = principalIdSchema.safeParse(principalCandidate);
  const session = browserSessionIdSchema.safeParse(sessionCandidate);
  const now = instantSchema.safeParse(nowCandidate);
  if (!principal.success || !session.success || !now.success) {
    return { ok: false as const, code: "INVALID_PROJECTION_REQUEST" };
  }
  const coordinator = environment.BROWSER_SESSION_COORDINATOR.getByName(
    session.data,
  );
  const pending = await coordinator.pendingProjection(principal.data, 100);
  if (!pending.ok) return pending;
  const events = (pending.events ?? []) as unknown as CoordinatorEvent[];
  if (events.length === 0) return { ok: true as const, projected: 0 };

  try {
    await environment.VILLAGE_DB.batch(
      events.flatMap((event) => [
        environment.VILLAGE_DB.prepare(
          `INSERT INTO browser_session_event_projections
           (principal_id, browser_session_id, sequence, event_type, payload_json,
            occurred_at, projected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(principal_id, browser_session_id, sequence) DO UPDATE SET
             event_type = excluded.event_type,
             payload_json = excluded.payload_json,
             occurred_at = excluded.occurred_at`,
        ).bind(
          principal.data,
          session.data,
          event.sequence,
          event.type,
          JSON.stringify(event.payload),
          event.occurredAt,
          now.data,
        ),
        ...workflowProjectionStatements(
          environment.VILLAGE_DB,
          principal.data,
          session.data,
          event,
        ),
      ]),
    );
  } catch {
    return { ok: false as const, code: "PROJECTION_WRITE_FAILED" };
  }
  const last = events.at(-1)!;
  const acknowledged = await coordinator.markProjected(
    principal.data,
    last.sequence,
    now.data,
  );
  if (!acknowledged.ok) return acknowledged;
  return { ok: true as const, projected: events.length };
}

export async function rebuildSessionProjection(
  environment: Environment,
  principalCandidate: unknown,
  sessionCandidate: unknown,
  nowCandidate: unknown,
) {
  const principal = principalIdSchema.safeParse(principalCandidate);
  const session = browserSessionIdSchema.safeParse(sessionCandidate);
  const now = instantSchema.safeParse(nowCandidate);
  if (!principal.success || !session.success || !now.success) {
    return { ok: false as const, code: "INVALID_PROJECTION_REQUEST" };
  }
  const coordinator = environment.BROWSER_SESSION_COORDINATOR.getByName(
    session.data,
  );
  const snapshot = await coordinator.snapshot(principal.data);
  if (!snapshot.ok) return snapshot;
  const allEvents: CoordinatorEvent[] = [];
  let cursor = 0;
  while (cursor < snapshot.eventSequence) {
    const page = await coordinator.eventsAfter(principal.data, cursor, 100);
    if (!page.ok) return page;
    const events = (page.events ?? []) as unknown as CoordinatorEvent[];
    if (events.length === 0) break;
    allEvents.push(...events);
    cursor = events.at(-1)!.sequence;
  }
  try {
    await environment.VILLAGE_DB.batch([
      environment.VILLAGE_DB.prepare(
        `DELETE FROM workflow_cancellations
         WHERE principal_id = ? AND browser_session_id = ?`,
      ).bind(principal.data, session.data),
      environment.VILLAGE_DB.prepare(
        `DELETE FROM workflow_effect_projections
         WHERE principal_id = ? AND browser_session_id = ?`,
      ).bind(principal.data, session.data),
      environment.VILLAGE_DB.prepare(
        `DELETE FROM action_receipts
         WHERE principal_id = ? AND browser_session_id = ?
           AND objective_kind IS NOT NULL`,
      ).bind(principal.data, session.data),
      environment.VILLAGE_DB.prepare(
        `DELETE FROM browser_actions
         WHERE principal_id = ? AND browser_session_id = ?
           AND objective_kind IS NOT NULL`,
      ).bind(principal.data, session.data),
      environment.VILLAGE_DB.prepare(
        `DELETE FROM checkpoints WHERE principal_id = ? AND job_id = (
           SELECT job_id FROM browser_sessions
           WHERE principal_id = ? AND browser_session_id = ?
         ) AND checkpoint_json IS NOT NULL`,
      ).bind(principal.data, principal.data, session.data),
      environment.VILLAGE_DB.prepare(
        `DELETE FROM browser_session_event_projections
         WHERE principal_id = ? AND browser_session_id = ?`,
      ).bind(principal.data, session.data),
    ]);
    for (let offset = 0; offset < allEvents.length; offset += 100) {
      const page = allEvents.slice(offset, offset + 100);
      await environment.VILLAGE_DB.batch(
        page.flatMap((event) => [
          environment.VILLAGE_DB.prepare(
            `INSERT INTO browser_session_event_projections
             (principal_id, browser_session_id, sequence, event_type, payload_json,
              occurred_at, projected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            principal.data,
            session.data,
            event.sequence,
            event.type,
            JSON.stringify(event.payload),
            event.occurredAt,
            now.data,
          ),
          ...workflowProjectionStatements(
            environment.VILLAGE_DB,
            principal.data,
            session.data,
            event,
          ),
        ]),
      );
    }
  } catch {
    return { ok: false as const, code: "PROJECTION_REBUILD_FAILED" };
  }
  if (allEvents.length > 0) {
    await coordinator.markProjected(
      principal.data,
      allEvents.at(-1)!.sequence,
      now.data,
    );
  }
  return { ok: true as const, projected: allEvents.length };
}

function workflowProjectionStatements(
  db: D1Database,
  principalId: string,
  browserSessionId: string,
  event: CoordinatorEvent,
): D1PreparedStatement[] {
  if (event.type === "WORKFLOW_ACTION_ACCEPTED") {
    const payload = event.payload as {
      action: {
        actionId: string;
        jobId: string;
        jobRevision: number;
        objective: { kind: string; version: number };
        logicalStep: string;
        effectId: string;
        leaseEpoch: number;
        phase: string;
        mutationClass: string;
        postcondition: string;
        acceptedAt: string;
        updatedAt: string;
      };
      commandSequence: number;
      canonicalActionId: string;
    };
    const action = payload.action;
    return [
      db
        .prepare(
          `INSERT INTO browser_actions
           (principal_id, browser_session_id, action_id, lease_epoch,
            command_sequence, phase, mutation_class, postcondition, accepted_at,
            updated_at, job_id, job_revision, objective_kind, objective_version,
            logical_step, effect_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(principal_id, browser_session_id, action_id) DO UPDATE SET
             phase = excluded.phase, postcondition = excluded.postcondition,
             updated_at = excluded.updated_at`,
        )
        .bind(
          principalId,
          browserSessionId,
          action.actionId,
          action.leaseEpoch,
          payload.commandSequence,
          action.phase,
          action.mutationClass,
          action.postcondition,
          action.acceptedAt,
          action.updatedAt,
          action.jobId,
          action.jobRevision,
          action.objective.kind,
          action.objective.version,
          action.logicalStep,
          action.effectId,
        ),
      db
        .prepare(
          `INSERT INTO workflow_effect_projections
           (principal_id, browser_session_id, job_id, job_revision,
            workflow_kind, workflow_version, logical_step, effect_id,
            canonical_action_id, action_phase, receipt_id, checkpoint_id,
            updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(principal_id, browser_session_id, logical_step) DO UPDATE SET
             canonical_action_id = COALESCE(
               workflow_effect_projections.canonical_action_id,
               excluded.canonical_action_id
             ),
             action_phase = excluded.action_phase,
             updated_at = excluded.updated_at`,
        )
        .bind(
          principalId,
          browserSessionId,
          action.jobId,
          action.jobRevision,
          action.objective.kind,
          action.objective.version,
          action.logicalStep,
          action.effectId,
          payload.canonicalActionId,
          action.phase,
          action.updatedAt,
        ),
    ];
  }
  if (event.type === "WORKFLOW_CHECKPOINT_RECEIPTED") {
    const payload = event.payload as {
      receipt: {
        receiptId: string;
        deviceId: string;
        jobId: string;
        browserSessionId: string;
        actionId: string;
        stepId: string;
        objective: { kind: string; version: number };
        jobRevision: number;
        logicalStep: string;
        effectId: string;
        leaseEpoch: number;
        outcome: string;
        predicateIds: string[];
        recordedAt: string;
      };
      checkpoint: {
        checkpointId: string;
        jobId: string;
        jobRevision: number;
        eventSequence: number;
        state: string;
        currentStep: string;
        currentEffectId: string;
        objective: { kind: string; version: number };
        actionPhase: string;
        createdAt: string;
      };
    };
    const { receipt, checkpoint } = payload;
    return [
      db
        .prepare(
          `INSERT INTO action_receipts
           (principal_id, browser_session_id, receipt_id, job_id, action_id,
            outcome, predicate_ids_json, recorded_at, schema_version, device_id,
            step_id, objective_kind, objective_version, job_revision,
            logical_step, effect_id, lease_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(principal_id, browser_session_id, receipt_id) DO NOTHING`,
        )
        .bind(
          principalId,
          browserSessionId,
          receipt.receiptId,
          receipt.jobId,
          receipt.actionId,
          receipt.outcome,
          JSON.stringify(receipt.predicateIds),
          receipt.recordedAt,
          receipt.deviceId,
          receipt.stepId,
          receipt.objective.kind,
          receipt.objective.version,
          receipt.jobRevision,
          receipt.logicalStep,
          receipt.effectId,
          receipt.leaseEpoch,
        ),
      db
        .prepare(
          `INSERT INTO checkpoints
           (principal_id, job_id, checkpoint_id, job_version, event_sequence,
            state, created_at, schema_version, checkpoint_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?)
           ON CONFLICT(principal_id, job_id, checkpoint_id) DO UPDATE SET
             event_sequence = excluded.event_sequence,
             state = excluded.state,
             checkpoint_json = excluded.checkpoint_json`,
        )
        .bind(
          principalId,
          checkpoint.jobId,
          checkpoint.checkpointId,
          checkpoint.jobRevision,
          checkpoint.eventSequence,
          checkpoint.state,
          checkpoint.createdAt,
          JSON.stringify(checkpoint),
        ),
      db
        .prepare(
          `UPDATE browser_actions SET phase = 'RECEIPTED',
             postcondition = 'SATISFIED', updated_at = ?
           WHERE principal_id = ? AND browser_session_id = ? AND action_id = ?`,
        )
        .bind(
          receipt.recordedAt,
          principalId,
          browserSessionId,
          receipt.actionId,
        ),
      db
        .prepare(
          `UPDATE workflow_effect_projections
           SET action_phase = 'RECEIPTED', receipt_id = ?, checkpoint_id = ?,
               updated_at = ?
           WHERE principal_id = ? AND browser_session_id = ?
             AND logical_step = ? AND effect_id = ?`,
        )
        .bind(
          receipt.receiptId,
          checkpoint.checkpointId,
          receipt.recordedAt,
          principalId,
          browserSessionId,
          receipt.logicalStep,
          receipt.effectId,
        ),
      db
        .prepare(
          `INSERT INTO workflow_effect_projections
           (principal_id, browser_session_id, job_id, job_revision,
            workflow_kind, workflow_version, logical_step, effect_id,
            canonical_action_id, action_phase, receipt_id, checkpoint_id,
            updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
           ON CONFLICT(principal_id, browser_session_id, logical_step) DO NOTHING`,
        )
        .bind(
          principalId,
          browserSessionId,
          checkpoint.jobId,
          checkpoint.jobRevision,
          checkpoint.objective.kind,
          checkpoint.objective.version,
          checkpoint.currentStep,
          checkpoint.currentEffectId,
          checkpoint.actionPhase,
          checkpoint.checkpointId,
          checkpoint.createdAt,
        ),
    ];
  }
  if (event.type === "AUTOMATION_CANCELED") {
    const payload = event.payload as Record<string, unknown>;
    if (
      typeof payload.cancellationId !== "string" ||
      typeof payload.jobId !== "string" ||
      typeof payload.expectedJobRevision !== "number" ||
      typeof payload.jobRevision !== "number"
    ) {
      return [];
    }
    return [
      db
        .prepare(
          `INSERT INTO workflow_cancellations
           (principal_id, browser_session_id, cancellation_id, job_id,
            expected_job_revision, resulting_job_revision, event_sequence,
            accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(principal_id, browser_session_id, cancellation_id)
           DO NOTHING`,
        )
        .bind(
          principalId,
          browserSessionId,
          payload.cancellationId,
          payload.jobId,
          payload.expectedJobRevision,
          payload.jobRevision,
          event.sequence,
          event.occurredAt,
        ),
      db
        .prepare(
          `UPDATE jobs SET state = 'CANCELED', version = ?, updated_at = ?
           WHERE principal_id = ? AND job_id = ? AND version = ?`,
        )
        .bind(
          payload.jobRevision,
          event.occurredAt,
          principalId,
          payload.jobId,
          payload.expectedJobRevision,
        ),
    ];
  }
  return [];
}
