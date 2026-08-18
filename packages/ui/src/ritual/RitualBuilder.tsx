import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  ApprovedRitualRevision,
  RitualRun,
  RitualRunReceipt,
  RitualStarter,
  RitualAuditTimeline,
} from "@village/contracts";
import type {
  RitualBuilderEvent,
  RitualBuilderIdentity,
  RitualBuilderState,
} from "./ritual-builder-state.js";
import { GmailPriorityReport } from "./GmailPriorityReport.js";

const now = () => new Date().toISOString();
const localTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export interface RitualFollowUpMessage {
  id: string;
  speaker: "OWNER" | "STEWARD";
  text: string;
}

export function RitualBuilder({
  state,
  onEvent,
  identity,
  researchSetup,
  stewardDesk,
  auditTimeline = [],
  auditTimelineError,
  onRefreshAuditTimeline,
  revisionRestore,
  onDraftDirtyChange,
  stewardFollowUp,
}: {
  state: RitualBuilderState;
  onEvent(event: RitualBuilderEvent): void;
  identity: RitualBuilderIdentity;
  researchSetup?: ReactNode;
  stewardDesk?: ReactNode;
  auditTimeline?: RitualAuditTimeline;
  auditTimelineError?: string | null;
  onRefreshAuditTimeline?(): void;
  onDraftDirtyChange?(dirty: boolean): void;
  stewardFollowUp?: {
    messages: readonly RitualFollowUpMessage[];
    pending: boolean;
    error: string | null;
    submit(question: string): void;
  };
  revisionRestore?: {
    pending: boolean;
    error: string | null;
    submit(ritualRevision: number): Promise<boolean>;
  };
}) {
  const [starterMode, setStarterMode] = useState<
    "CUSTOM" | RitualStarter["kind"]
  >("CUSTOM");
  const [followUpQuestion, setFollowUpQuestion] = useState("");
  useEffect(() => {
    setFollowUpQuestion("");
  }, [state.approved?.ritualId, state.approved?.ritualRevision]);
  const submitPurpose = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (starterMode === "LAST_30_DAYS") {
      const topic = String(data.get("topic") ?? "").trim();
      const starter: RitualStarter = {
        kind: "LAST_30_DAYS",
        topic,
      };
      onEvent({
        type: "SUBMIT_STARTER",
        draftId: identity.draftId,
        starter,
      });
      return;
    }
    if (starterMode === "INBOX_PRIORITY") {
      onEvent({
        type: "SUBMIT_STARTER",
        draftId: identity.draftId,
        starter: { kind: "INBOX_PRIORITY" },
      });
      return;
    }
    onEvent({
      type: "SUBMIT_PURPOSE",
      draftId: identity.draftId,
      purpose: String(data.get("purpose") ?? ""),
    });
  };
  const submitTestSample = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onEvent({
      type: "SUBMIT_TEST_SAMPLE",
      sample: String(data.get("sample") ?? ""),
    });
  };
  const submitFeedback = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onEvent({
      type: "SUBMIT_FEEDBACK",
      feedback: String(data.get("feedback") ?? ""),
    });
  };
  const submitClarification = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.phase !== "CLARIFYING") return;
    const data = new FormData(event.currentTarget);
    onEvent({
      type: "ANSWER_CLARIFICATION",
      questionId: state.question.questionId,
      selection: {
        kind: "TEXT",
        text: String(data.get("clarification") ?? ""),
      },
    });
  };
  const edit = (field: "name" | "purpose" | "completion", value: string) =>
    onEvent({ type: "EDIT_FIELD", field, value, occurredAt: now() });
  const fieldsEditable =
    state.phase === "CHOOSE_TRIGGER" ||
    state.phase === "CHOOSE_REVIEW" ||
    state.phase === "READY_FOR_APPROVAL";

  return (
    <main className="ritual-builder">
      <section
        className="ritual-conversation"
        aria-label="Conversation with Steward"
      >
        <header className="ritual-conversation__header">
          <div className="ritual-steward-identity">
            <span aria-hidden="true">S</span>
            <div>
              <p className="ritual-eyebrow">Village</p>
              <h1>Your Steward</h1>
            </div>
          </div>
          <p className="ritual-steward-status">
            <span aria-hidden="true" /> Local and ready
          </p>
        </header>

        {state.phase === "DESCRIBE_PURPOSE" ? (
          <section
            className="ritual-welcome"
            aria-labelledby="ritual-welcome-title"
          >
            <p className="ritual-eyebrow">Start with the outcome</p>
            <h2 id="ritual-welcome-title">What should we make repeatable?</h2>
            <p>
              Talk it through. Your Steward will shape the work into a clear
              agreement for you to review before anything runs.
            </p>
          </section>
        ) : null}

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
          {stewardFollowUp?.messages.map((entry) => (
            <li
              className={`ritual-message ritual-message--${entry.speaker.toLowerCase()}`}
              key={entry.id}
            >
              <span>{entry.speaker === "STEWARD" ? "Steward" : "You"}</span>
              <p>{entry.text}</p>
            </li>
          ))}
        </ol>

        {state.approved && stewardFollowUp ? (
          <form
            className="ritual-follow-up"
            onSubmit={(event) => {
              event.preventDefault();
              const question = followUpQuestion.trim();
              if (!question || stewardFollowUp.pending) return;
              stewardFollowUp.submit(question);
              setFollowUpQuestion("");
            }}
          >
            <div className="ritual-follow-up__heading">
              <label htmlFor="ritual-follow-up-question">
                Ask the Steward about this Ritual
              </label>
              <span>Read-only follow-up</span>
            </div>
            <textarea
              id="ritual-follow-up-question"
              value={followUpQuestion}
              rows={2}
              minLength={3}
              maxLength={600}
              required
              disabled={stewardFollowUp.pending}
              placeholder="Ask about the agreement, latest result, evidence, or uncertainty."
              onChange={(event) =>
                setFollowUpQuestion(event.currentTarget.value)
              }
            />
            <button type="submit" disabled={stewardFollowUp.pending}>
              {stewardFollowUp.pending
                ? "Steward is reviewing…"
                : "Ask Steward"}
            </button>
            <small>
              Answers cannot start a Run, change the Ritual, or expand its
              permissions.
            </small>
            {stewardFollowUp.error ? (
              <p role="alert">{stewardFollowUp.error}</p>
            ) : null}
          </form>
        ) : null}

        {state.phase === "DESCRIBE_PURPOSE" ? (
          <section className="ritual-start">
            <fieldset className="ritual-start__choices">
              <legend>How would you like to begin?</legend>
              <button
                type="button"
                aria-pressed={starterMode === "CUSTOM"}
                onClick={() => {
                  setStarterMode("CUSTOM");
                  onDraftDirtyChange?.(false);
                }}
              >
                <span aria-hidden="true">O</span>
                <strong>Describe an outcome</strong>
                <small>Shape any regular work with your Steward</small>
              </button>
              <button
                type="button"
                aria-pressed={starterMode === "LAST_30_DAYS"}
                onClick={() => {
                  setStarterMode("LAST_30_DAYS");
                  onDraftDirtyChange?.(false);
                }}
              >
                <span aria-hidden="true">30</span>
                <strong>30-day signal brief</strong>
                <small>Track one topic across recent public-web sources</small>
              </button>
              <button
                type="button"
                aria-pressed={starterMode === "INBOX_PRIORITY"}
                onClick={() => {
                  setStarterMode("INBOX_PRIORITY");
                  onDraftDirtyChange?.(false);
                }}
              >
                <span aria-hidden="true">@</span>
                <strong>Inbox priority review</strong>
                <small>
                  Identify likely replies from recent Gmail metadata
                </small>
              </button>
            </fieldset>
            <form className="ritual-composer" onSubmit={submitPurpose}>
              {starterMode === "LAST_30_DAYS" ? (
                <>
                  <label htmlFor="ritual-topic">
                    What topic should I track?
                  </label>
                  <input
                    id="ritual-topic"
                    name="topic"
                    minLength={3}
                    maxLength={160}
                    placeholder="For example: AI coding agents"
                    required
                    autoComplete="off"
                    onChange={(event) =>
                      onDraftDirtyChange?.(
                        event.currentTarget.value.trim().length > 0,
                      )
                    }
                  />
                  <p>
                    This first version uses up to five Exa public-web results
                    from the previous 30 days. It does not yet rank Reddit, X,
                    or YouTube engagement.
                  </p>
                  <button type="submit">Shape the 30-day brief</button>
                </>
              ) : starterMode === "INBOX_PRIORITY" ? (
                <>
                  <p>
                    Review up to 25 unread inbox messages from the previous
                    three days using headers and labels only.
                  </p>
                  <p>
                    This first version does not read message bodies or
                    attachments, send replies, or change your mailbox.
                  </p>
                  <button type="submit">Shape the inbox review</button>
                </>
              ) : (
                <>
                  <label htmlFor="ritual-goal">
                    What should become repeatable?
                  </label>
                  <textarea
                    id="ritual-goal"
                    name="purpose"
                    rows={3}
                    maxLength={320}
                    placeholder="For example: Review my pipeline each weekday and prepare the next follow-ups."
                    required
                    autoComplete="off"
                    onChange={(event) =>
                      onDraftDirtyChange?.(
                        event.currentTarget.value.trim().length > 0,
                      )
                    }
                  />
                  <button type="submit">Start the draft</button>
                </>
              )}
            </form>
          </section>
        ) : null}

        {state.phase === "DRAFTING" ? (
          <div className="ritual-drafting" role="status">
            <span aria-hidden="true" />
            <p>The Steward is shaping your first reviewable draft…</p>
          </div>
        ) : null}

        {state.phase === "CLARIFYING" ? (
          <>
            <DecisionGroup
              label={state.question.prompt}
              options={state.question.options.map((option, index) => ({
                id: option.optionId,
                title: option.label,
                detail: option.detail,
                accent: String(index + 1),
                action: () =>
                  onEvent({
                    type: "ANSWER_CLARIFICATION",
                    questionId: state.question.questionId,
                    selection: {
                      kind: "OPTION",
                      optionId: option.optionId,
                    },
                  }),
              }))}
            />
            <form
              className="ritual-composer ritual-clarification"
              onSubmit={submitClarification}
            >
              <label htmlFor="ritual-clarification">Something else</label>
              <input
                id="ritual-clarification"
                name="clarification"
                maxLength={320}
                placeholder="Add a short answer in your own words"
                required
                autoComplete="off"
              />
              <button type="submit">Use this answer</button>
            </form>
          </>
        ) : null}

        {state.phase === "PREPARING_TEST" ? (
          <form
            className="ritual-composer ritual-test-composer"
            onSubmit={submitTestSample}
          >
            <label htmlFor="ritual-test-sample">Representative sample</label>
            <textarea
              id="ritual-test-sample"
              name="sample"
              rows={6}
              minLength={16}
              maxLength={4_000}
              placeholder="Paste a small, representative example for the approved Ritual to review."
              required
              autoComplete="off"
            />
            <p>
              Used for this test only. The sample is not attached to the
              Receipt; only the bounded result and evidence are saved.
            </p>
            <button type="submit">Run safe test</button>
          </form>
        ) : null}

        {state.phase === "RUNNING_TEST" ? (
          <div className="ritual-drafting" role="status">
            <span aria-hidden="true" />
            <p>
              The Steward is testing the approved Ritual against your sample…
            </p>
          </div>
        ) : null}

        {state.phase === "GIVE_FEEDBACK" ? (
          <form className="ritual-composer" onSubmit={submitFeedback}>
            <label htmlFor="ritual-feedback">
              What should the Steward keep or change?
            </label>
            <textarea
              id="ritual-feedback"
              name="feedback"
              rows={5}
              minLength={8}
              maxLength={1_000}
              placeholder="For example: Keep the priority explanation, but put messages from existing customers first."
              required
              autoComplete="off"
            />
            <p>
              Your feedback becomes a proposal. The approved Ritual does not
              change until you approve a revision.
            </p>
            <button type="submit">Propose an improvement</button>
          </form>
        ) : null}

        {state.phase === "SHAPING_LEARNING" ? (
          <div className="ritual-drafting" role="status">
            <span aria-hidden="true" />
            <p>The Steward is shaping a reviewable improvement…</p>
          </div>
        ) : null}

        {state.phase === "SAVING_LEARNING" ? (
          <div className="ritual-drafting" role="status">
            <span aria-hidden="true" />
            <p>Saving the approved revision. No Run has started…</p>
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
                id: "on-demand",
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
                id: "weekdays",
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
                id: "event",
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
                id: "every-run",
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
                id: "exceptions-only",
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

      <aside
        className="ritual-draft"
        aria-label="Ritual agreement and activity"
      >
        {stewardDesk || researchSetup ? (
          <div className="ritual-desk-tools">
            {stewardDesk}
            {researchSetup}
          </div>
        ) : null}
        <header className="ritual-draft__header">
          <div>
            <p className="ritual-eyebrow">Working agreement</p>
            <h2>{state.draft?.name ?? "No Ritual yet"}</h2>
          </div>
          <span className="ritual-revision">
            {state.approved
              ? `Approved · Revision ${state.approved.ritualRevision}`
              : state.draft
                ? `Draft · Revision ${state.draft.revision}`
                : "Not started"}
          </span>
        </header>

        {auditTimeline.length > 0 || auditTimelineError ? (
          <RitualAuditHistory
            timeline={auditTimeline}
            currentRevision={state.approved?.ritualRevision ?? null}
            {...(auditTimelineError !== undefined
              ? { error: auditTimelineError }
              : {})}
            {...(revisionRestore ? { revisionRestore } : {})}
            {...(onRefreshAuditTimeline ? { onRefreshAuditTimeline } : {})}
          />
        ) : null}

        {state.draft ? (
          <div className="ritual-charter">
            <EditableRitualField
              id="ritual-name"
              label="Name"
              value={state.draft.name}
              maxLength={80}
              disabled={!fieldsEditable}
              onCommit={(value) => edit("name", value)}
            />

            <EditableRitualField
              id="ritual-purpose"
              label="Purpose"
              value={state.draft.purpose}
              maxLength={320}
              rows={3}
              disabled={!fieldsEditable}
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
              disabled={!fieldsEditable}
              onCommit={(value) => edit("completion", value)}
            />

            <RitualField label="Permissions">
              <ul>
                {state.draft.permissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
            </RitualField>

            {state.draft.research ? (
              <RitualField label="Research resource">
                <strong>Exa · public web</strong>
                <small>
                  {state.draft.research.query} · up to{" "}
                  {state.draft.research.maxResults} sources from the last{" "}
                  {state.draft.research.lookbackDays} days
                </small>
              </RitualField>
            ) : null}

            {state.draft.gmailReview ? (
              <RitualField label="Inbox resource">
                <strong>Gmail · metadata only</strong>
                <small>
                  Up to {state.draft.gmailReview.maxMessages} unread inbox
                  headers from the previous{" "}
                  {state.draft.gmailReview.lookbackDays}
                  days. Message bodies and attachments are not read.
                </small>
              </RitualField>
            ) : null}

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
                  onClick={() => onEvent({ type: "START_RUN" })}
                >
                  Run Ritual
                </button>
                <button
                  type="button"
                  onClick={() => onEvent({ type: "START_TEST" })}
                >
                  Test this Ritual
                </button>
                <button
                  type="button"
                  onClick={() => onEvent({ type: "START_NEW_RITUAL" })}
                >
                  Shape another Ritual
                </button>
              </div>
            ) : null}

            {state.phase === "STARTING_RUN" ||
            state.phase === "RUNNING_RITUAL" ? (
              <section className="ritual-receipt" role="status">
                <p className="ritual-eyebrow">Local Ritual Run</p>
                <h3>Run in progress</h3>
                <p>
                  Village is following the exact approved steps. Public-web
                  approved resources may read bounded Exa or Gmail metadata;
                  external effects remain blocked.
                </p>
                {state.run ? <RunStepProgress run={state.run} /> : null}
                {state.phase === "RUNNING_RITUAL" || state.run ? (
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "CANCEL_RUN" })}
                  >
                    Cancel Run
                  </button>
                ) : null}
              </section>
            ) : null}

            {state.phase === "RUN_WAITING_FOR_OWNER" ? (
              <section className="ritual-receipt" role="status">
                <p className="ritual-eyebrow">Human gate</p>
                <h3>Owner approval required</h3>
                <p>
                  Approve only this step. The approved Ritual and its resource
                  limits remain unchanged.
                </p>
                <RunStepProgress run={state.run} />
                <button
                  type="button"
                  onClick={() => onEvent({ type: "APPROVE_RUN_STEP" })}
                >
                  Approve step
                </button>
                <button
                  type="button"
                  onClick={() => onEvent({ type: "CANCEL_RUN" })}
                >
                  Cancel Run
                </button>
              </section>
            ) : null}

            {state.phase === "RUN_WAITING_FOR_RESOURCE" ? (
              <section className="ritual-receipt" role="status">
                <p className="ritual-eyebrow">Resource needed</p>
                <h3>
                  {state.run.waitingSource === "STEWARD"
                    ? "Steward report is waiting"
                    : state.run.waitingSource === "GMAIL"
                      ? "Gmail metadata is waiting"
                      : "Exa research is waiting"}
                </h3>
                <p>
                  {resourceWaitingCopy(
                    state.run.waitingReason,
                    state.run.waitingSource ?? "RESEARCH",
                  )}
                </p>
                <RunStepProgress run={state.run} />
                <button
                  type="button"
                  onClick={() => onEvent({ type: "START_RUN" })}
                >
                  {state.run.waitingSource === "STEWARD"
                    ? "Retry report"
                    : state.run.waitingSource === "GMAIL"
                      ? "Retry inbox review"
                      : "Retry research"}
                </button>
                <button
                  type="button"
                  onClick={() => onEvent({ type: "CANCEL_RUN" })}
                >
                  Cancel Run
                </button>
              </section>
            ) : null}

            {state.phase === "RUN_FAILED" || state.phase === "RUN_CANCELED" ? (
              <section className="ritual-receipt" role="status">
                <p className="ritual-eyebrow">Local Ritual Run</p>
                <h3>
                  {state.phase === "RUN_FAILED"
                    ? "Run stopped"
                    : "Run canceled"}
                </h3>
                <p>
                  {state.run.steps.some((step) => step.mailReport)
                    ? "Gmail metadata was read locally, but no message bodies, attachments, or mail mutations were requested. The approved Ritual is unchanged."
                    : state.run.steps.some((step) => step.research)
                      ? "Public-web research already occurred, but it was read-only; no external mutations occurred. The approved Ritual is unchanged."
                      : "No public-web research completed and no external mutations occurred. The approved Ritual is unchanged."}
                </p>
                <RunStepProgress run={state.run} />
                <button
                  type="button"
                  onClick={() => onEvent({ type: "START_RUN" })}
                >
                  Run again
                </button>
              </section>
            ) : null}

            {state.phase === "REVIEW_RUN" ? (
              <section
                className="ritual-receipt"
                aria-labelledby="run-receipt-title"
              >
                <header>
                  <div>
                    <p className="ritual-eyebrow">Proof of work</p>
                    <h3 id="run-receipt-title">Run Receipt</h3>
                  </div>
                  <span>Needs review</span>
                </header>
                <p className="ritual-receipt__summary">
                  {state.runReceipt.summary}
                </p>
                <div className="ritual-receipt__proof">
                  <span>Run</span>
                  <code>{state.run.runId.slice(-8)}</code>
                  <span>Executor</span>
                  <strong>Local Ritual v1</strong>
                  <span>Safety</span>
                  <strong>
                    {state.runReceipt.stepEvidence.some(
                      (step) => step.mailReport,
                    )
                      ? "No mail mutations; Gmail metadata only"
                      : state.runReceipt.stepEvidence.some(
                            (step) => step.research,
                          )
                        ? "No external mutations; public-web search only"
                        : "No external mutations"}
                  </strong>
                </div>
                <RunStepProgress run={state.run} />
                <GmailPriorityReport receipt={state.runReceipt} />
                <ResearchReport receipt={state.runReceipt} />
                <ResearchEvidence receipt={state.runReceipt} />
                <div className="ritual-receipt__uncertainty">
                  <h4>Boundary</h4>
                  <p>{state.runReceipt.uncertainties[0]}</p>
                </div>
                <footer>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_FEEDBACK" })}
                  >
                    Give feedback
                  </button>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_RUN" })}
                  >
                    Run again
                  </button>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_NEW_RITUAL" })}
                  >
                    Shape another Ritual
                  </button>
                </footer>
              </section>
            ) : null}

            {state.phase === "REVIEW_TEST" ? (
              <section
                className="ritual-receipt"
                aria-labelledby="test-receipt-title"
              >
                <header>
                  <div>
                    <p className="ritual-eyebrow">Proof of work</p>
                    <h3 id="test-receipt-title">Test Receipt</h3>
                  </div>
                  <span>
                    {state.receipt.outcome === "COMPLETED"
                      ? "Complete"
                      : "Needs review"}
                  </span>
                </header>
                <p className="ritual-receipt__summary">
                  {state.receipt.summary}
                </p>
                <div className="ritual-receipt__proof">
                  <span>Run</span>
                  <code>{state.receipt.runId.slice(-8)}</code>
                  <span>Input</span>
                  <strong>
                    {state.receipt.sampleCharacterCount} characters
                  </strong>
                  <span>Safety</span>
                  <strong>No external effects</strong>
                </div>
                {state.receipt.evidence.length ? (
                  <div>
                    <h4>Evidence</h4>
                    <ul>
                      {state.receipt.evidence.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {state.receipt.uncertainties.length ? (
                  <div className="ritual-receipt__uncertainty">
                    <h4>Uncertainty</h4>
                    <ul>
                      {state.receipt.uncertainties.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <footer>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_FEEDBACK" })}
                  >
                    Give feedback
                  </button>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_RUN" })}
                  >
                    Run Ritual
                  </button>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_TEST" })}
                  >
                    Run another test
                  </button>
                  <button
                    type="button"
                    onClick={() => onEvent({ type: "START_NEW_RITUAL" })}
                  >
                    Shape another Ritual
                  </button>
                </footer>
              </section>
            ) : null}

            {state.phase === "GIVE_FEEDBACK" ||
            state.phase === "SHAPING_LEARNING" ? (
              <section className="ritual-learning-pending" role="status">
                <p className="ritual-eyebrow">Learning Review</p>
                <strong>
                  Revision {state.approved.ritualRevision} remains active
                </strong>
                <p>
                  Feedback can shape a proposal, but it cannot change this
                  Ritual or start a Run.
                </p>
              </section>
            ) : null}

            {state.phase === "REVIEW_LEARNING" ||
            state.phase === "SAVING_LEARNING_DECISION" ||
            state.phase === "SAVING_LEARNING" ? (
              <LearningProposalReview state={state} onEvent={onEvent} />
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

function LearningProposalReview({
  state,
  onEvent,
}: {
  state: Extract<
    RitualBuilderState,
    {
      phase: "REVIEW_LEARNING" | "SAVING_LEARNING_DECISION" | "SAVING_LEARNING";
    }
  >;
  onEvent(event: RitualBuilderEvent): void;
}) {
  const proposed = state.proposal.proposedDefinition;
  const current = state.approved;
  const saving = state.phase === "SAVING_LEARNING";
  const deciding = state.phase === "SAVING_LEARNING_DECISION";
  const busy = saving || deciding;
  return (
    <section className="ritual-learning" aria-labelledby="learning-title">
      <header>
        <div>
          <p className="ritual-eyebrow">Learning proposal</p>
          <h3 id="learning-title">
            Review revision {current.ritualRevision + 1}
          </h3>
        </div>
        <span>No change yet</span>
      </header>
      <p className="ritual-learning__rationale">{state.proposal.rationale}</p>
      <blockquote>{state.proposal.ownerFeedback}</blockquote>
      <div
        className="ritual-learning__comparison"
        aria-label="Current and proposed Ritual comparison"
      >
        <ComparisonColumn
          label={`Current · Revision ${current.ritualRevision}`}
          name={current.name}
          purpose={current.purpose}
          trigger={current.trigger.summary}
          completion={current.completion}
          steps={current.steps}
          permissions={current.permissions}
          review={reviewLabel(current.reviewPolicy.ownerReview)}
        />
        <ComparisonColumn
          label={`Proposed · Revision ${current.ritualRevision + 1}`}
          name={proposed.name}
          purpose={proposed.purpose}
          trigger={proposed.trigger.summary}
          completion={proposed.completion}
          steps={proposed.steps}
          permissions={proposed.permissions}
          review={reviewLabel(proposed.reviewPolicy.ownerReview)}
        />
      </div>
      <p className="ritual-learning__guardrail">
        Permissions remain within the current Ritual. Nothing changes until
        approval, and approval does not start a Run.
      </p>
      <footer>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onEvent({ type: "APPROVE_LEARNING", occurredAt: now() })
          }
        >
          {saving
            ? "Saving revision…"
            : `Approve revision ${current.ritualRevision + 1}`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onEvent({ type: "REVISE_LEARNING" })}
        >
          Ask for changes
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onEvent({ type: "REJECT_LEARNING" })}
        >
          {deciding && state.pendingDecision === "REJECTED"
            ? "Saving rejection…"
            : "Reject"}
        </button>
      </footer>
    </section>
  );
}

function ComparisonColumn({
  label,
  name,
  purpose,
  trigger,
  completion,
  steps,
  permissions,
  review,
}: {
  label: string;
  name: string;
  purpose: string;
  trigger: string;
  completion: string;
  steps: ApprovedRitualRevision["steps"];
  permissions: readonly string[];
  review: string;
}) {
  return (
    <article>
      <h4>{label}</h4>
      <strong>{name}</strong>
      <p>{purpose}</p>
      <small>Begins</small>
      <p>{trigger}</p>
      <small>Work</small>
      <ol>
        {steps.map((step) => (
          <li key={step.stepKey}>
            <strong>{step.title}</strong>
            <small>
              {step.actor.role} · {approvalLabel(step.approval)}
            </small>
          </li>
        ))}
      </ol>
      <small>Done when</small>
      <p>{completion}</p>
      <small>Permissions</small>
      <ul>
        {permissions.map((permission) => (
          <li key={permission}>{permission}</li>
        ))}
      </ul>
      <small>Review</small>
      <p>{review}</p>
    </article>
  );
}

function approvalLabel(approval: "NONE" | "OWNER_REQUIRED"): string {
  return approval === "OWNER_REQUIRED"
    ? "Owner approval required"
    : "No owner approval";
}

function reviewLabel(review: "EVERY_RUN" | "EXCEPTIONS_ONLY"): string {
  return review === "EVERY_RUN" ? "Review every Run" : "Review exceptions";
}

function RunStepProgress({ run }: { run: RitualRun }) {
  return (
    <ol className="ritual-step-list" aria-label="Run progress">
      {run.steps.map((step, index) => (
        <li key={step.stepKey}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{step.title}</strong>
            <p>{step.status.toLowerCase().replaceAll("_", " ")}</p>
            <small>{step.actor.role}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ResearchEvidence({ receipt }: { receipt: RitualRunReceipt }) {
  const sources = receipt.stepEvidence.flatMap(
    (step) => step.research?.sources ?? [],
  );
  if (sources.length === 0) return null;
  return (
    <section aria-labelledby="ritual-research-evidence-title">
      <div className="ritual-field-heading">
        <span id="ritual-research-evidence-title">Research evidence</span>
        <small>{sources.length} public sources</small>
      </div>
      <ol className="ritual-step-list">
        {sources.map((source, index) => (
          <li key={`${source.url}-${index}`}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{source.title}</strong>
              <p>{source.highlights[0] ?? "No excerpt returned."}</p>
              <small>
                {source.author ?? "Unknown author"}
                {source.publishedAt
                  ? ` · ${source.publishedAt.slice(0, 10)}`
                  : ""}
              </small>
              <code>{source.url}</code>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ResearchReport({ receipt }: { receipt: RitualRunReceipt }) {
  const reportedSteps = receipt.stepEvidence.filter(
    (step) => step.report && step.research,
  );
  if (reportedSteps.length === 0) return null;
  return (
    <section aria-label="Steward research report">
      {reportedSteps.map((step) => {
        const report = step.report!;
        const sources = step.research!.sources;
        return (
          <article key={step.stepKey}>
            <p className="ritual-eyebrow">Steward report</p>
            <h3>{report.headline}</h3>
            <p>{report.summary}</p>
            <ol className="ritual-step-list">
              {report.findings.map((finding, index) => (
                <li key={`${step.stepKey}-finding-${index + 1}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <p>{finding.claim}</p>
                    <small>
                      {finding.sourceNumbers.map(
                        (sourceNumber, citationIndex) => {
                          const source = sources[sourceNumber - 1];
                          if (!source) return null;
                          return (
                            <span key={sourceNumber}>
                              {citationIndex > 0 ? " · " : ""}
                              <cite title={source.title}>
                                Source {sourceNumber}
                              </cite>
                            </span>
                          );
                        },
                      )}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
            {report.uncertainties.length > 0 ? (
              <div className="ritual-receipt__uncertainty">
                <h4>What remains uncertain</h4>
                <p>{report.uncertainties.join(" ")}</p>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

function RitualAuditHistory({
  timeline,
  error,
  currentRevision,
  revisionRestore,
  onRefreshAuditTimeline,
}: {
  timeline: RitualAuditTimeline;
  error?: string | null;
  currentRevision: number | null;
  revisionRestore?: {
    pending: boolean;
    error: string | null;
    submit(ritualRevision: number): Promise<boolean>;
  };
  onRefreshAuditTimeline?(): void;
}) {
  const [restoreCandidate, setRestoreCandidate] = useState<number | null>(null);
  return (
    <details className="ritual-history">
      <summary>
        <span>
          <strong>Ritual history</strong>
          <small>Latest approvals, Receipts, and learning decisions</small>
        </span>
        <span>{timeline.length}</span>
      </summary>
      {error ? (
        <div className="ritual-history__error">
          <p role="alert">{error}</p>
          {onRefreshAuditTimeline ? (
            <button type="button" onClick={onRefreshAuditTimeline}>
              Refresh history
            </button>
          ) : null}
        </div>
      ) : null}
      {revisionRestore?.error ? (
        <p role="alert">{revisionRestore.error}</p>
      ) : null}
      <ol>
        {timeline.map((entry) => {
          const canRestore =
            entry.kind === "REVISION_APPROVED" &&
            currentRevision !== null &&
            entry.ritualRevision < currentRevision &&
            Boolean(revisionRestore);
          return (
            <li key={`${entry.kind}-${entry.sourceId}-${entry.ritualRevision}`}>
              <span aria-hidden="true" />
              <div>
                <strong>{auditEntryLabel(entry)}</strong>
                <small>
                  Revision {entry.ritualRevision} ·{" "}
                  <time dateTime={entry.occurredAt}>
                    {formatAuditDate(entry.occurredAt)}
                  </time>
                </small>
                {canRestore ? (
                  <button
                    type="button"
                    disabled={revisionRestore?.pending}
                    onClick={() => setRestoreCandidate(entry.ritualRevision)}
                  >
                    Restore revision {entry.ritualRevision}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {restoreCandidate !== null && currentRevision !== null ? (
        <section
          className="ritual-history__restore"
          aria-label={`Confirm restore of revision ${restoreCandidate}`}
        >
          <strong>
            Restore revision {restoreCandidate} as revision{" "}
            {currentRevision + 1}?
          </strong>
          <p>
            Village will keep every earlier revision and Receipt, pause the
            current schedule, and create a new approved revision. No Run will
            start.
          </p>
          <div>
            <button
              type="button"
              disabled={revisionRestore?.pending}
              onClick={() => {
                if (!revisionRestore) return;
                void revisionRestore
                  .submit(restoreCandidate)
                  .then((restored) => {
                    if (restored) setRestoreCandidate(null);
                  });
              }}
            >
              {revisionRestore?.pending ? "Restoring…" : "Confirm restore"}
            </button>
            <button
              type="button"
              disabled={revisionRestore?.pending}
              onClick={() => setRestoreCandidate(null)}
            >
              Keep current revision
            </button>
          </div>
        </section>
      ) : null}
    </details>
  );
}

function formatAuditDate(occurredAt: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(occurredAt),
  );
}

function auditEntryLabel(entry: RitualAuditTimeline[number]): string {
  switch (entry.kind) {
    case "REVISION_APPROVED":
      if (entry.source === "INITIAL") return "Ritual approved";
      if (entry.source === "LEARNING") return "Learned revision approved";
      return `Restored from revision ${entry.restoredFromRevision}`;
    case "TEST_RECORDED":
      return `Test Receipt · ${auditOutcomeLabel(entry.outcome)}`;
    case "RUN_RECORDED":
      return `Run Receipt · ${auditOutcomeLabel(entry.outcome)}`;
    case "LEARNING_DECIDED":
      return entry.decision === "REJECTED"
        ? "Learning proposal rejected"
        : "Learning revision requested";
  }
}

function auditOutcomeLabel(outcome: RitualRunReceipt["outcome"]): string {
  return outcome === "COMPLETED" ? "Completed" : "Needs review";
}

function resourceWaitingCopy(
  reason: RitualRun["waitingReason"],
  source: NonNullable<RitualRun["waitingSource"]>,
): string {
  if (source === "GMAIL") {
    switch (reason) {
      case "AUTHENTICATION_REQUIRED":
        return "Connect Gmail above, then retry this exact metadata-only Run.";
      case "RATE_LIMITED":
        return "Gmail is rate-limiting metadata requests. Wait briefly, then retry this exact Run.";
      case "TIME_BUDGET_EXHAUSTED":
        return "The Gmail metadata request took too long. Retry when the connection is stable.";
      case "CREDENTIAL_STORE_UNAVAILABLE":
        return "Village cannot access the local Gmail grant. Unlock this Mac and retry.";
      case "PROVIDER_REQUEST_REJECTED":
        return "Gmail rejected the bounded metadata request. Review the connection before retrying.";
      case "MALFORMED_PROVIDER_OUTPUT":
        return "Gmail returned metadata Village could not safely validate. Retry later.";
      default:
        return "Gmail metadata is unavailable on this Mac. Check the connection above, then retry.";
    }
  }
  if (source === "STEWARD") {
    switch (reason) {
      case "AUTHENTICATION_REQUIRED":
        return "Connect ChatGPT for the Steward, then retry this report without repeating the saved Exa research.";
      case "TIME_BUDGET_EXHAUSTED":
        return "The Steward took too long to shape the report. Retry the report without repeating the saved Exa research.";
      case "MALFORMED_PROVIDER_OUTPUT":
        return "The Steward returned a report Village could not safely validate. Retry the report without repeating the saved Exa research.";
      default:
        return "The Steward is unavailable on this Mac. Check the ChatGPT connection, then retry the report without repeating the saved Exa research.";
    }
  }
  switch (reason) {
    case "AUTHENTICATION_REQUIRED":
      return "Add or replace the Exa key above, then retry this exact Run.";
    case "CREDITS_EXHAUSTED":
      return "Exa credits are exhausted. Open the Exa key dashboard to review billing, then retry this exact Run.";
    case "RATE_LIMITED":
      return "Exa is rate-limiting requests. Wait briefly, then retry this exact Run.";
    case "TIME_BUDGET_EXHAUSTED":
      return "The research request took too long. Retry this exact Run when the connection is stable.";
    case "PROVIDER_REQUEST_REJECTED":
      return "Exa rejected the approved query. Review the Ritual before trying again.";
    case "MALFORMED_PROVIDER_OUTPUT":
      return "Exa returned evidence Village could not safely validate. Retry later or revise the Ritual.";
    case "CREDENTIAL_STORE_UNAVAILABLE":
      return "Village cannot access the locally saved Exa key. Unlock this Mac and retry.";
    case "PROVIDER_UNAVAILABLE":
    case null:
    case undefined:
      return "Exa is unavailable on this Mac. Check the resource setup above, then retry.";
  }
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
    id: string;
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
          <button key={option.id} type="button" onClick={option.action}>
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
