import { useEffect, useState, type FormEvent } from "react";
import type {
  RitualBuilderEvent,
  RitualBuilderIdentity,
  RitualBuilderState,
} from "./ritual-builder-state.js";

const now = () => new Date().toISOString();
const localTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function RitualBuilder({
  state,
  onEvent,
  identity,
}: {
  state: RitualBuilderState;
  onEvent(event: RitualBuilderEvent): void;
  identity: RitualBuilderIdentity;
}) {
  const submitPurpose = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onEvent({
      type: "SUBMIT_PURPOSE",
      draftId: identity.draftId,
      purpose: String(data.get("purpose") ?? ""),
    });
  };
  const edit = (field: "name" | "purpose" | "completion", value: string) =>
    onEvent({ type: "EDIT_FIELD", field, value, occurredAt: now() });

  return (
    <main className="ritual-builder">
      <section
        className="ritual-conversation"
        aria-label="Conversation with Steward"
      >
        <header className="ritual-conversation__header">
          <p className="ritual-eyebrow">Steward&rsquo;s workroom</p>
          <h1>Shape a Ritual with your Steward</h1>
          <p>
            Describe the outcome. Your Steward will turn it into a reviewable
            agreement without making you configure a workflow.
          </p>
        </header>

        <ol className="ritual-messages" aria-live="polite">
          {state.messages.map((entry) => (
            <li
              className={`ritual-message ritual-message--${entry.speaker.toLowerCase()}`}
              key={entry.id}
            >
              <span>
                {entry.speaker === "STEWARD"
                  ? "Steward"
                  : entry.speaker === "SYSTEM"
                    ? "Village"
                    : "You"}
              </span>
              <p>{entry.text}</p>
            </li>
          ))}
        </ol>

        {state.phase === "DESCRIBE_PURPOSE" ? (
          <form className="ritual-composer" onSubmit={submitPurpose}>
            <label htmlFor="ritual-goal">What should become repeatable?</label>
            <textarea
              id="ritual-goal"
              name="purpose"
              rows={3}
              maxLength={320}
              placeholder="For example: Review my pipeline each weekday and prepare the next follow-ups."
              required
            />
            <button type="submit">Start the draft</button>
          </form>
        ) : null}

        {state.phase === "DRAFTING" ? (
          <div className="ritual-drafting" role="status">
            <span aria-hidden="true" />
            <p>The Steward is shaping your first reviewable draft…</p>
          </div>
        ) : null}

        {state.phase === "STARTING_NEW_RITUAL" ? (
          <div className="ritual-drafting" role="status">
            <span aria-hidden="true" />
            <p>Preparing another Ritual…</p>
          </div>
        ) : null}

        {state.phase === "CHOOSE_TRIGGER" ? (
          <DecisionGroup
            label="Choose how the Ritual begins"
            options={[
              {
                title: "On demand",
                detail: "Only when you ask",
                accent: "A",
                action: () =>
                  onEvent({
                    type: "SELECT_TRIGGER",
                    trigger: "ON_DEMAND",
                    timeZone: localTimeZone(),
                    occurredAt: now(),
                  }),
              },
              {
                title: "Weekdays",
                detail: "8:30 AM in your timezone",
                accent: "W",
                action: () =>
                  onEvent({
                    type: "SELECT_TRIGGER",
                    trigger: "WEEKDAYS",
                    timeZone: localTimeZone(),
                    occurredAt: now(),
                  }),
              },
              {
                title: "When new work arrives",
                detail: "Respond to a source event",
                accent: "N",
                action: () =>
                  onEvent({
                    type: "SELECT_TRIGGER",
                    trigger: "EVENT",
                    timeZone: localTimeZone(),
                    occurredAt: now(),
                  }),
              },
            ]}
          />
        ) : null}

        {state.phase === "CHOOSE_REVIEW" ? (
          <DecisionGroup
            label="Choose your Review rhythm"
            options={[
              {
                title: "Review every Run",
                detail: "Best while the Ritual is learning",
                accent: "1",
                action: () =>
                  onEvent({
                    type: "SELECT_REVIEW",
                    ownerReview: "EVERY_RUN",
                    occurredAt: now(),
                  }),
              },
              {
                title: "Surface exceptions",
                detail: "Bring me blocked or uncertain work",
                accent: "!",
                action: () =>
                  onEvent({
                    type: "SELECT_REVIEW",
                    ownerReview: "EXCEPTIONS_ONLY",
                    occurredAt: now(),
                  }),
              },
            ]}
          />
        ) : null}

        {state.error && !state.draft ? <p role="alert">{state.error}</p> : null}
      </section>

      <aside className="ritual-draft" aria-label="Ritual draft side pane">
        <header className="ritual-draft__header">
          <div>
            <p className="ritual-eyebrow">Ritual draft</p>
            <h2>{state.draft?.name ?? "Waiting for an outcome"}</h2>
          </div>
          <span className="ritual-revision">
            {state.approved
              ? `Approved · Revision ${state.approved.approvedDraftRevision}`
              : state.draft
                ? `Draft · Revision ${state.draft.revision}`
                : "Not started"}
          </span>
        </header>

        {state.draft ? (
          <div className="ritual-charter">
            <EditableRitualField
              id="ritual-name"
              label="Name"
              value={state.draft.name}
              maxLength={80}
              disabled={
                state.phase === "APPROVED" ||
                state.phase === "SAVING_APPROVAL" ||
                state.phase === "STARTING_NEW_RITUAL"
              }
              onCommit={(value) => edit("name", value)}
            />

            <EditableRitualField
              id="ritual-purpose"
              label="Purpose"
              value={state.draft.purpose}
              maxLength={320}
              rows={3}
              disabled={
                state.phase === "APPROVED" ||
                state.phase === "SAVING_APPROVAL" ||
                state.phase === "STARTING_NEW_RITUAL"
              }
              onCommit={(value) => edit("purpose", value)}
            />

            <RitualField label="Begins">
              <strong>{state.draft.trigger.summary}</strong>
            </RitualField>

            <section aria-labelledby="ritual-steps-title">
              <div className="ritual-field-heading">
                <span id="ritual-steps-title">Proposed work</span>
                <small>{state.draft.steps.length} steps</small>
              </div>
              <ol className="ritual-step-list">
                {state.draft.steps.map((step, index) => (
                  <li key={step.stepKey}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{step.title}</strong>
                      <p>{step.description}</p>
                      <small>
                        {step.actor.role}
                        {step.approval === "OWNER_REQUIRED"
                          ? " · Your approval"
                          : ""}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <EditableRitualField
              id="ritual-completion"
              label="Done when"
              value={state.draft.completion}
              maxLength={320}
              rows={2}
              disabled={
                state.phase === "APPROVED" ||
                state.phase === "SAVING_APPROVAL" ||
                state.phase === "STARTING_NEW_RITUAL"
              }
              onCommit={(value) => edit("completion", value)}
            />

            <RitualField label="Permissions">
              <ul>
                {state.draft.permissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </RitualField>

            <RitualField label="Review">
              <strong>
                {state.draft.reviewPolicy.ownerReview === "EVERY_RUN"
                  ? "Review every Run"
                  : "Review exceptions and uncertain results"}
              </strong>
            </RitualField>

            <RitualField label="Learning">
              <strong>Suggest improvements after Review</strong>
              <small>Changes always require your approval.</small>
            </RitualField>

            {state.error ? (
              <p className="ritual-charter__error" role="alert">
                {state.error}
              </p>
            ) : null}

            {state.phase === "READY_FOR_APPROVAL" ? (
              <div className="ritual-approval">
                <p>
                  You are approving revision {state.draft.revision}. No Run
                  starts until you ask.
                </p>
                <button
                  type="button"
                  disabled={state.error !== null}
                  onClick={() =>
                    onEvent({
                      type: "APPROVE",
                      ritualId: identity.ritualId,
                      expectedRevision: state.draft.revision,
                      occurredAt: now(),
                    })
                  }
                >
                  Approve Ritual
                </button>
              </div>
            ) : null}

            {state.phase === "SAVING_APPROVAL" ? (
              <div className="ritual-approved" role="status">
                <strong>Saving approval…</strong>
                <p>No Run has started.</p>
              </div>
            ) : null}

            {state.phase === "APPROVED" ? (
              <div className="ritual-approved">
                <div role="status">
                  <strong>Ritual approved</strong>
                  <p>
                    No Run has started. Your Steward will offer a test next.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onEvent({ type: "START_NEW_RITUAL" })}
                >
                  Shape another Ritual
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ritual-draft__empty">
            <span aria-hidden="true">R</span>
            <p>
              Your Ritual will take shape here as the Steward understands the
              work.
            </p>
          </div>
        )}
      </aside>
    </main>
  );
}

function EditableRitualField({
  id,
  label,
  value,
  maxLength,
  rows,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  rows?: number;
  disabled: boolean;
  onCommit(value: string): void;
}) {
  const [pendingValue, setPendingValue] = useState(value);
  useEffect(() => setPendingValue(value), [value]);
  const shared = {
    id,
    value: pendingValue,
    maxLength,
    disabled,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setPendingValue(event.currentTarget.value),
    onBlur: () => onCommit(pendingValue),
  };
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {rows ? <textarea {...shared} rows={rows} /> : <input {...shared} />}
    </>
  );
}

function DecisionGroup({
  label,
  options,
}: {
  label: string;
  options: readonly {
    title: string;
    detail: string;
    accent: string;
    action(): void;
  }[];
}) {
  return (
    <fieldset className="ritual-decisions">
      <legend>{label}</legend>
      <div>
        {options.map((option) => (
          <button key={option.title} type="button" onClick={option.action}>
            <span aria-hidden="true">{option.accent}</span>
            <strong>{option.title}</strong>
            <small>{option.detail}</small>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function RitualField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ritual-field">
      <span>{label}</span>
      {children}
    </div>
  );
}
