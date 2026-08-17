import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  RitualRun,
  RitualRunReceipt,
  RitualStarter,
} from "@village/contracts";
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
  researchSetup,
  stewardDesk,
}: {
  state: RitualBuilderState;
  onEvent(event: RitualBuilderEvent): void;
  identity: RitualBuilderIdentity;
  researchSetup?: ReactNode;
  stewardDesk?: ReactNode;
}) {
  const [starterMode, setStarterMode] = useState<
    "CUSTOM" | RitualStarter["kind"]
  >("CUSTOM");
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
        </ol>

        {state.phase === "DESCRIBE_PURPOSE" ? (
          <section className="ritual-start">
            <fieldset className="ritual-start__choices">
              <legend>How would you like to begin?</legend>
              <button
                type="button"
                aria-pressed={starterMode === "CUSTOM"}
                onClick={() => setStarterMode("CUSTOM")}
              >
                <span aria-hidden="true">O</span>
                <strong>Describe an outcome</strong>
                <small>Shape any regular work with your Steward</small>
              </button>
              <button
                type="button"
                aria-pressed={starterMode === "LAST_30_DAYS"}
                onClick={() => setStarterMode("LAST_30_DAYS")}
              >
                <span aria-hidden="true">30</span>
                <strong>30-day signal brief</strong>
                <small>Track one topic across recent public-web sources</small>
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
                  />
                  <p>
                    This first version uses up to five Exa public-web results
                    from the previous 30 days. It does not yet rank Reddit, X,
                    or YouTube engagement.
                  </p>
                  <button type="submit">Shape the 30-day brief</button>
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
                  research may use Exa when this Ritual includes it; external
                  effects remain blocked.
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
                <h3>Exa research is waiting</h3>
                <p>{researchWaitingCopy(state.run.waitingReason)}</p>
                <RunStepProgress run={state.run} />
                <button
                  type="button"
                  onClick={() => onEvent({ type: "START_RUN" })}
                >
                  Retry research
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
                  {state.run.steps.some((step) => step.research)
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
                    {state.runReceipt.stepEvidence.some((step) => step.research)
                      ? "No external mutations; public-web search only"
                      : "No external mutations"}
                  </strong>
                </div>
                <RunStepProgress run={state.run} />
                <ResearchEvidence receipt={state.runReceipt} />
                <div className="ritual-receipt__uncertainty">
                  <h4>Boundary</h4>
                  <p>{state.runReceipt.uncertainties[0]}</p>
                </div>
                <footer>
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
    { phase: "REVIEW_LEARNING" | "SAVING_LEARNING" }
  >;
  onEvent(event: RitualBuilderEvent): void;
}) {
  const proposed = state.proposal.proposedDefinition;
  const current = state.approved;
  const saving = state.phase === "SAVING_LEARNING";
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
          steps={current.steps.map((step) => step.title)}
          permissions={current.permissions}
          review={reviewLabel(current.reviewPolicy.ownerReview)}
        />
        <ComparisonColumn
          label={`Proposed · Revision ${current.ritualRevision + 1}`}
          name={proposed.name}
          purpose={proposed.purpose}
          trigger={proposed.trigger.summary}
          completion={proposed.completion}
          steps={proposed.steps.map((step) => step.title)}
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
          disabled={saving}
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
          disabled={saving}
          onClick={() => onEvent({ type: "REVISE_LEARNING" })}
        >
          Ask for changes
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onEvent({ type: "REJECT_LEARNING" })}
        >
          Reject
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
  steps: readonly string[];
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
          <li key={step}>{step}</li>
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

function researchWaitingCopy(reason: RitualRun["waitingReason"]): string {
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
