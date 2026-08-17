import type {
  ApprovedRitualRevision,
  RitualInboxItem,
  RitualSchedule,
  RitualScheduleUpdateRequest,
} from "@village/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";

export function RitualAutomationPanel({
  approved,
  schedule,
  inbox,
  pending,
  error,
  onConfigure,
  onPause,
}: {
  approved: ApprovedRitualRevision | null;
  schedule: RitualSchedule | null;
  inbox: readonly RitualInboxItem[];
  pending: boolean;
  error: string | null;
  onConfigure(request: RitualScheduleUpdateRequest): void;
  onPause(): void;
}) {
  const [localTime, setLocalTime] = useState(schedule?.localTime ?? "08:30");
  const [cadence, setCadence] = useState<"DAILY" | "WEEKDAYS">(
    schedule?.cadence ?? "WEEKDAYS",
  );
  const dirty = useRef(false);
  useEffect(() => {
    if (!schedule) return;
    if (
      dirty.current &&
      (schedule.localTime !== localTime || schedule.cadence !== cadence)
    ) {
      return;
    }
    dirty.current = false;
    setLocalTime(schedule.localTime);
    setCadence(schedule.cadence);
  }, [schedule]);
  const attentionCount = inbox.filter((item) => item.attention).length;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!approved) return;
    onConfigure({
      schemaVersion: 1,
      ritualId: approved.ritualId,
      ritualRevision: approved.ritualRevision,
      cadence,
      localTime,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
  };

  return (
    <section
      className="ritual-automation"
      aria-labelledby="steward-inbox-title"
    >
      <header>
        <div>
          <p className="ritual-eyebrow">Repeatable work</p>
          <h2 id="steward-inbox-title">Steward inbox</h2>
        </div>
        <span>
          {attentionCount ? `${attentionCount} needs attention` : "Clear"}
        </span>
      </header>

      {approved ? (
        <form className="ritual-schedule" onSubmit={submit}>
          <label>
            Rhythm
            <select
              value={cadence}
              disabled={pending}
              onChange={(event) => {
                dirty.current = true;
                setCadence(event.currentTarget.value as "DAILY" | "WEEKDAYS");
              }}
            >
              <option value="DAILY">Every day</option>
              <option value="WEEKDAYS">Weekdays</option>
            </select>
          </label>
          <label>
            Local time
            <input
              aria-label="Ritual local time"
              type="time"
              required
              value={localTime}
              disabled={pending}
              onChange={(event) => {
                dirty.current = true;
                setLocalTime(event.currentTarget.value);
              }}
            />
          </label>
          <button type="submit" disabled={pending}>
            {schedule?.state === "ENABLED"
              ? "Update schedule"
              : "Enable schedule"}
          </button>
          {schedule?.state === "ENABLED" ? (
            <button type="button" disabled={pending} onClick={onPause}>
              Pause
            </button>
          ) : null}
          {schedule ? (
            <small>
              {schedule.state === "ENABLED"
                ? `Next Run ${formatLocal(schedule.nextRunAt)}`
                : "Paused. On-demand Runs remain available."}
            </small>
          ) : (
            <small>Scheduling is off. On-demand Runs remain available.</small>
          )}
        </form>
      ) : (
        <p className="ritual-automation__empty">
          Approve a Ritual before choosing when it repeats.
        </p>
      )}

      {error ? <p role="alert">{error}</p> : null}
      {inbox.length ? (
        <ol className="ritual-inbox-list">
          {inbox.slice(0, 5).map((item) => (
            <li key={item.run.runId}>
              <span className={item.attention ? "needs-attention" : "history"}>
                {inboxLabel(item)}
              </span>
              <div>
                <strong>{runTitle(item)}</strong>
                <small>
                  {formatLocal(item.run.updatedAt)} · Run{" "}
                  {item.run.runId.slice(-8)}
                </small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="ritual-automation__empty">No Runs yet.</p>
      )}
    </section>
  );
}

function inboxLabel(item: RitualInboxItem): string {
  switch (item.attention) {
    case "OWNER_APPROVAL":
      return "Approve";
    case "RESOURCE":
      return "Connect";
    case "REVIEW":
      return "Review";
    case "FAILURE":
      return "Stopped";
    default:
      return item.run.status === "COMPLETED" ? "Done" : item.run.status;
  }
}

function runTitle(item: RitualInboxItem): string {
  if (item.receipt) return item.receipt.summary;
  const active = item.run.steps.find(
    (step) => step.stepKey === item.run.currentStepKey,
  );
  return active?.title ?? `Ritual Run ${item.run.status.toLowerCase()}`;
}

function formatLocal(instant: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(instant));
}
