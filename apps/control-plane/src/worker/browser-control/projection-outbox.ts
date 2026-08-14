import {
  actionPhaseSchema,
  browserSessionIdSchema,
  instantSchema,
  principalIdSchema,
  setupCheckpointSchema,
  setupLogicalStepSchema,
} from "@village/contracts";
import { z } from "zod";
import type { Environment } from "../../env.js";

type CoordinatorEvent = {
  sequence: number;
  type: string;
  payload: unknown;
  occurredAt: string;
};

export async function getObserverWorkflowProjection(
  environment: Environment,
  principalCandidate: unknown,
  sessionCandidate: unknown,
  cursorCandidate: unknown,
) {
  const principal = principalIdSchema.safeParse(principalCandidate);
  const session = browserSessionIdSchema.safeParse(sessionCandidate);
  const cursor = z.number().int().nonnegative().safeParse(cursorCandidate);
  if (!principal.success || !session.success || !cursor.success) {
    return { ok: false as const, code: "INVALID_OBSERVER_CURSOR" };
  }
  const coordinator = environment.BROWSER_SESSION_COORDINATOR.getByName(
    session.data,
  );
  const control = await coordinator.snapshot(principal.data);
  if (!control.ok) return control;
  const job = await environment.VILLAGE_DB.prepare(
    `SELECT jobs.job_id AS jobId, jobs.state, jobs.version,
            jobs.active_human_gate_id AS activeHumanGateId,
            jobs.updated_at AS updatedAt, jobs.objective_kind AS workflowKind,
            jobs.objective_version AS workflowVersion
       FROM browser_sessions JOIN jobs
         ON jobs.principal_id = browser_sessions.principal_id
        AND jobs.job_id = browser_sessions.job_id
      WHERE browser_sessions.principal_id = ?
        AND browser_sessions.browser_session_id = ?`,
  )
    .bind(principal.data, session.data)
    .first<{
      jobId: string;
      state: string;
      version: number;
      activeHumanGateId: string | null;
      updatedAt: string;
      workflowKind: string | null;
      workflowVersion: number | null;
    }>();
  if (
    !job ||
    job.workflowKind !== "OWNED_FIXTURE_ACCOUNT_SETUP_V1" ||
    job.workflowVersion !== 1
  ) {
    return { ok: false as const, code: "OBSERVER_WORKFLOW_MISMATCH" };
  }
  if (cursor.data > control.eventSequence) {
    return { ok: false as const, code: "OBSERVER_CURSOR_AHEAD" };
  }
  const effect = await environment.VILLAGE_DB.prepare(
    `SELECT logical_step AS logicalStep, action_phase AS actionPhase,
            updated_at AS updatedAt
       FROM workflow_effect_projections
      WHERE principal_id = ? AND browser_session_id = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(principal.data, session.data)
    .first<{ logicalStep: string; actionPhase: string; updatedAt: string }>();
  const actor = await environment.VILLAGE_DB.prepare(
    `SELECT actor, logical_step AS logicalStep, occurred_at AS occurredAt
       FROM workflow_last_effect_actor
      WHERE principal_id = ? AND browser_session_id = ?`,
  )
    .bind(principal.data, session.data)
    .first<{
      actor: "AGENT" | "OWNER";
      logicalStep: string;
      occurredAt: string;
    }>();
  const cancellation = await environment.VILLAGE_DB.prepare(
    `SELECT accepted_at AS acknowledgedAt
       FROM workflow_cancellations
      WHERE principal_id = ? AND browser_session_id = ?
      ORDER BY event_sequence DESC LIMIT 1`,
  )
    .bind(principal.data, session.data)
    .first<{ acknowledgedAt: string }>();
  const checkpointRow = await environment.VILLAGE_DB.prepare(
    `SELECT checkpoint_json AS checkpointJson FROM checkpoints
      WHERE principal_id = ? AND job_id = ? AND checkpoint_json IS NOT NULL
      ORDER BY event_sequence DESC LIMIT 1`,
  )
    .bind(principal.data, job.jobId)
    .first<{ checkpointJson: string }>();
  const checkpoint = checkpointRow
    ? setupCheckpointSchema.safeParse(JSON.parse(checkpointRow.checkpointJson))
    : null;
  const logicalStep = setupLogicalStepSchema.safeParse(
    effect?.logicalStep ??
      (checkpoint?.success ? checkpoint.data.currentStep : null),
  );
  const actionPhase = actionPhaseSchema.safeParse(
    effect?.actionPhase ??
      (checkpoint?.success ? checkpoint.data.actionPhase : null),
  );
  const terminalEvidence =
    job.state === "SUCCEEDED" &&
    logicalStep.success &&
    logicalStep.data === "FINALIZE_SETUP" &&
    actionPhase.success &&
    actionPhase.data === "RECEIPTED"
      ? "RECEIPTED_SUCCESS"
      : job.state === "CANCELED"
        ? "CANCELLED"
        : job.state === "FAILED" &&
            checkpoint?.success &&
            checkpoint.data.reconciliation === "WAITING_FOR_USER"
          ? "NON_CONVERGENT"
          : job.state === "FAILED"
            ? "FAILED"
            : null;
  return {
    ok: true as const,
    projection: {
      cursor: control.eventSequence - control.projectionLag,
      projectionLag: control.projectionLag,
      jobRevision: job.version,
      jobState: job.state,
      workflowKind: job.workflowKind,
      workflowVersion: job.workflowVersion,
      logicalStep: logicalStep.success ? logicalStep.data : null,
      actionPhase: actionPhase.success ? actionPhase.data : null,
      lastEffectActor: actor?.actor ?? null,
      controller: control.control.controller,
      connection: control.control.connection,
      automationFenced: control.control.automationBlocked,
      humanGate: job.activeHumanGateId === null ? null : "UNKNOWN_CHALLENGE",
      terminalEvidence,
      cancellationAcknowledgedAt: cancellation?.acknowledgedAt ?? null,
      lastDurableUpdateAt: [effect?.updatedAt, actor?.occurredAt, job.updatedAt]
        .filter((value): value is string => value !== undefined)
        .sort()
        .at(-1)!,
    },
  };
}

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
        `DELETE FROM workflow_last_effect_actor
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
          `INSERT INTO workflow_last_effect_actor
           (principal_id, browser_session_id, job_id, workflow_kind,
            workflow_version, logical_step, actor, event_sequence, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, 'AGENT', ?, ?)
           ON CONFLICT(principal_id, browser_session_id) DO UPDATE SET
             job_id = excluded.job_id,
             workflow_kind = excluded.workflow_kind,
             workflow_version = excluded.workflow_version,
             logical_step = excluded.logical_step,
             actor = excluded.actor,
             event_sequence = excluded.event_sequence,
             occurred_at = excluded.occurred_at
           WHERE excluded.event_sequence > workflow_last_effect_actor.event_sequence`,
        )
        .bind(
          principalId,
          browserSessionId,
          receipt.jobId,
          receipt.objective.kind,
          receipt.objective.version,
          receipt.logicalStep,
          event.sequence,
          event.occurredAt,
        ),
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
  if (event.type === "WORKFLOW_OWNER_PROGRESS_RECORDED") {
    const payload = event.payload as Record<string, unknown>;
    const objective = payload.objective as Record<string, unknown> | undefined;
    const logicalStep = setupLogicalStepSchema.safeParse(payload.logicalStep);
    const actionPhase = actionPhaseSchema.safeParse(payload.actionPhase);
    if (
      typeof payload.jobId !== "string" ||
      typeof payload.effectId !== "string" ||
      typeof payload.jobRevision !== "number" ||
      !logicalStep.success ||
      !actionPhase.success ||
      payload.actor !== "OWNER" ||
      objective?.kind !== "OWNED_FIXTURE_ACCOUNT_SETUP_V1" ||
      objective.version !== 1
    ) {
      return [];
    }
    return [
      db
        .prepare(
          `INSERT INTO workflow_effect_projections
           (principal_id, browser_session_id, job_id, job_revision,
            workflow_kind, workflow_version, logical_step, effect_id,
            canonical_action_id, action_phase, receipt_id, checkpoint_id,
            updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)
           ON CONFLICT(principal_id, browser_session_id, logical_step) DO UPDATE SET
             action_phase = excluded.action_phase,
             updated_at = excluded.updated_at
           WHERE workflow_effect_projections.effect_id = excluded.effect_id`,
        )
        .bind(
          principalId,
          browserSessionId,
          payload.jobId,
          payload.jobRevision,
          objective.kind,
          objective.version,
          logicalStep.data,
          payload.effectId,
          actionPhase.data,
          event.occurredAt,
        ),
      db
        .prepare(
          `INSERT INTO workflow_last_effect_actor
           (principal_id, browser_session_id, job_id, workflow_kind,
            workflow_version, logical_step, actor, event_sequence, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, 'OWNER', ?, ?)
           ON CONFLICT(principal_id, browser_session_id) DO UPDATE SET
             job_id = excluded.job_id,
             workflow_kind = excluded.workflow_kind,
             workflow_version = excluded.workflow_version,
             logical_step = excluded.logical_step,
             actor = excluded.actor,
             event_sequence = excluded.event_sequence,
             occurred_at = excluded.occurred_at
           WHERE excluded.event_sequence > workflow_last_effect_actor.event_sequence`,
        )
        .bind(
          principalId,
          browserSessionId,
          payload.jobId,
          objective.kind,
          objective.version,
          logicalStep.data,
          event.sequence,
          event.occurredAt,
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
