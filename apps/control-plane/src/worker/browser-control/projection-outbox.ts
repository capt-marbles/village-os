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
      events.map((event) =>
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
      ),
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
    await environment.VILLAGE_DB.prepare(
      `DELETE FROM browser_session_event_projections
       WHERE principal_id = ? AND browser_session_id = ?`,
    )
      .bind(principal.data, session.data)
      .run();
    for (let offset = 0; offset < allEvents.length; offset += 100) {
      const page = allEvents.slice(offset, offset + 100);
      await environment.VILLAGE_DB.batch(
        page.map((event) =>
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
        ),
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
