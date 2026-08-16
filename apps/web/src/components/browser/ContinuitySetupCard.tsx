import { useEffect, useMemo, useState } from "react";
import {
  ContinuitySetupClient,
  type ContinuitySetupGrant,
  type ContinuityGrantStatus,
  type ContinuitySetupSession,
} from "./continuity-setup-client.js";

type SetupStep = "CLOSED" | "SOURCE" | "DESTINATION" | "REVIEW" | "ACTIVE";

interface ContinuitySetupOperations {
  load(signal?: AbortSignal): Promise<{
    ok: true;
    sessions: ContinuitySetupSession[];
    grants: ContinuitySetupGrant[];
  }>;
  createGrant(
    source: ContinuitySetupSession,
    destination: ContinuitySetupSession,
  ): Promise<ContinuitySetupGrant>;
  revokeGrant(grantId: string): Promise<void>;
  deleteGrant(grantId: string): Promise<void>;
  loadGrantStatus(
    grantId: string,
    signal?: AbortSignal,
  ): Promise<ContinuityGrantStatus>;
}

export function ContinuitySetupCard({
  client,
}: {
  client?: ContinuitySetupOperations;
}) {
  const activeClient = useMemo<ContinuitySetupOperations>(
    () =>
      client ??
      new ContinuitySetupClient(
        typeof window === "undefined"
          ? "https://village.invalid"
          : window.origin,
      ),
    [client],
  );
  const [sessions, setSessions] = useState<ContinuitySetupSession[]>([]);
  const [grant, setGrant] = useState<ContinuitySetupGrant | null>(null);
  const [step, setStep] = useState<SetupStep>("CLOSED");
  const [sourceId, setSourceId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [transfer, setTransfer] = useState<
    ContinuityGrantStatus["transfer"] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void activeClient
      .load(abort.signal)
      .then((snapshot) => {
        setSessions(snapshot.sessions);
        const active =
          snapshot.grants.find((item) =>
            ["PENDING", "ACTIVE"].includes(item.state),
          ) ??
          snapshot.grants.find((item) =>
            ["REVOKED", "EXPIRED"].includes(item.state),
          );
        if (active) {
          setGrant(active);
          setStep("ACTIVE");
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError("Continuity setup is unavailable. Try again shortly.");
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [activeClient]);

  useEffect(() => {
    if (!grant || !["PENDING", "ACTIVE"].includes(grant.state)) {
      return;
    }
    const abort = new AbortController();
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const status = await activeClient.loadGrantStatus(
          grant.grantId,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setGrant((current) => {
            const effectiveState = status.transfer.state;
            return current?.state === effectiveState
              ? current
              : { ...status.grant, state: effectiveState };
          });
          setTransfer(status.transfer);
        }
      } catch {
        // The setup state remains usable when transient status refresh fails.
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(refresh, 3_000);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeClient, grant]);

  const source = sessions.find((item) => item.browserSessionId === sourceId);
  const sourceCandidates = sessions.filter((candidate) =>
    sessions.some(
      (possibleDestination) =>
        possibleDestination.deviceId !== candidate.deviceId &&
        possibleDestination.recipientKeyState === "READY",
    ),
  );
  const destination = sessions.find(
    (item) => item.browserSessionId === destinationId,
  );
  const destinations = sessions.filter(
    (item) =>
      item.deviceId !== source?.deviceId && item.recipientKeyState === "READY",
  );
  const sourceName =
    source?.deviceName ?? nameFor(grant?.sourceBrowserSessionId, sessions);
  const destinationName =
    destination?.deviceName ??
    nameFor(grant?.destinationBrowserSessionId, sessions);

  if (loading || (!error && !grant && sourceCandidates.length === 0)) {
    return null;
  }

  const approve = async () => {
    if (!source || !destination || pending) return;
    setPending(true);
    setError(null);
    try {
      setGrant(await activeClient.createGrant(source, destination));
      setDeleted(false);
      setStep("ACTIVE");
    } catch {
      setError(
        "Village could not create this handoff. Review both Macs and try again.",
      );
    } finally {
      setPending(false);
    }
  };

  const stop = async () => {
    if (!grant || pending) return;
    setPending(true);
    setError(null);
    try {
      await activeClient.revokeGrant(grant.grantId);
      setGrant((current) =>
        current ? { ...current, state: "REVOKED" } : current,
      );
      setTransfer((current) =>
        current ? { ...current, state: "REVOKED" } : current,
      );
    } catch {
      setError("Village could not stop this handoff. Try again.");
    } finally {
      setPending(false);
    }
  };

  const deleteGrant = async () => {
    if (!grant || pending) return;
    setPending(true);
    setError(null);
    try {
      await activeClient.deleteGrant(grant.grantId);
      setGrant(null);
      setTransfer(null);
      setConfirmingDeletion(false);
      setDeleted(true);
      setStep("CLOSED");
    } catch {
      setError("Village could not delete this handoff. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="continuity-card" aria-labelledby="continuity-heading">
      <div className="continuity-card__header">
        <div>
          <p className="observer-card__eyebrow">EXPERIMENTAL CONTINUITY</p>
          <h2 id="continuity-heading">Keep work on another Mac</h2>
        </div>
        {step !== "CLOSED" && step !== "ACTIVE" ? (
          <button
            type="button"
            className="continuity-card__quiet-action"
            onClick={() => setStep("CLOSED")}
          >
            Close
          </button>
        ) : null}
      </div>

      {step === "CLOSED" ? (
        <div className="continuity-card__summary" aria-live="polite">
          {sourceCandidates.length > 0 ? (
            <>
              <p>
                {sessions.length === 2
                  ? "Two paired Macs are available."
                  : `${sessions.length} paired Macs are available.`}
              </p>
              <button
                type="button"
                onClick={() => {
                  setDeleted(false);
                  setStep("SOURCE");
                }}
              >
                Set up handoff
              </button>
            </>
          ) : null}
          {deleted ? (
            <p className="continuity-card__success">Handoff deleted</p>
          ) : null}
        </div>
      ) : null}

      {step === "SOURCE" ? (
        <SetupChoice
          progress="Step 1 of 3"
          legend="Where should the Site Session come from?"
          help="Choose the Mac where the owned fixture Site Session is already signed in."
          sessions={sourceCandidates}
          value={sourceId}
          onChange={(value) => {
            setSourceId(value);
            setDestinationId("");
          }}
          onContinue={() => setStep("DESTINATION")}
          continueLabel="Continue"
        />
      ) : null}

      {step === "DESTINATION" ? (
        <SetupChoice
          progress="Step 2 of 3"
          legend="Where should Village keep this Site Session available?"
          help="Only Macs that have enrolled a protected recipient key can receive it."
          sessions={destinations}
          value={destinationId}
          onChange={setDestinationId}
          onContinue={() => setStep("REVIEW")}
          continueLabel="Review handoff"
          onBack={() => setStep("SOURCE")}
        />
      ) : null}

      {step === "REVIEW" && source && destination ? (
        <div className="continuity-card__step">
          <p className="continuity-card__progress">Step 3 of 3</p>
          <h3>Review the agreement</h3>
          <p className="continuity-card__route">
            {source.deviceName} <span aria-hidden="true">→</span>{" "}
            {destination.deviceName}
          </p>
          <ul className="continuity-card__agreement">
            <li>Village-owned test fixture only</li>
            <li>One-way handoff</li>
            <li>Expires after 7 days</li>
            <li>Cloudflare stores encrypted session data it cannot read</li>
          </ul>
          <p className="continuity-card__boundary">LinkedIn is not included.</p>
          <div className="continuity-card__actions">
            <button
              type="button"
              className="button-secondary"
              onClick={() => setStep("DESTINATION")}
              disabled={pending}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void approve()}
              disabled={pending}
            >
              {pending ? "Creating handoff…" : "Approve handoff"}
            </button>
          </div>
        </div>
      ) : null}

      {step === "ACTIVE" && grant ? (
        <div className="continuity-card__step" aria-live="polite">
          <p className="continuity-card__success">{grantStateCopy(grant)}</p>
          <h3>
            {sourceName} <span aria-hidden="true">→</span> {destinationName}
          </h3>
          {confirmingDeletion ? (
            <div className="continuity-card__agreement">
              <p>
                This permanently deletes the encrypted mailbox and continuity
                relationship. It does not delete either local Site Session.
              </p>
              <div className="continuity-card__actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setConfirmingDeletion(false)}
                  disabled={pending}
                >
                  Keep handoff
                </button>
                <button
                  type="button"
                  onClick={() => void deleteGrant()}
                  disabled={pending}
                >
                  {pending ? "Deleting…" : "Confirm deletion"}
                </button>
              </div>
            </div>
          ) : grant.state === "REVOKED" || grant.state === "EXPIRED" ? (
            <>
              <p>No further Site Session revisions can be transferred.</p>
              <button
                type="button"
                className="button-secondary"
                onClick={() => setConfirmingDeletion(true)}
              >
                Delete handoff data
              </button>
            </>
          ) : (
            <>
              <p>
                Village can keep this Site Session available until{" "}
                {formatDate(grant.expiresAt)}.
              </p>
              {transfer ? <TransferStatus transfer={transfer} /> : null}
              <div className="continuity-card__actions">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void stop()}
                  disabled={pending}
                >
                  {pending ? "Stopping…" : "Stop handoff"}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setConfirmingDeletion(true)}
                  disabled={pending}
                >
                  Delete handoff data
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="continuity-card__error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function SetupChoice({
  progress,
  legend,
  help,
  sessions,
  value,
  onChange,
  onContinue,
  continueLabel,
  onBack,
}: {
  progress: string;
  legend: string;
  help: string;
  sessions: ContinuitySetupSession[];
  value: string;
  onChange(value: string): void;
  onContinue(): void;
  continueLabel: string;
  onBack?: () => void;
}) {
  return (
    <div className="continuity-card__step">
      <p className="continuity-card__progress">{progress}</p>
      <fieldset>
        <legend>{legend}</legend>
        <p>{help}</p>
        <div className="continuity-card__choices">
          {sessions.map((session) => (
            <label key={session.browserSessionId}>
              <input
                type="radio"
                name={progress}
                value={session.browserSessionId}
                checked={value === session.browserSessionId}
                onChange={(event) => onChange(event.currentTarget.value)}
              />
              <span>
                <strong>{session.deviceName}</strong>
                <small>{connectionCopy(session.connection)}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="continuity-card__actions">
        {onBack ? (
          <button type="button" className="button-secondary" onClick={onBack}>
            Back
          </button>
        ) : null}
        <button type="button" disabled={!value} onClick={onContinue}>
          {continueLabel}
        </button>
      </div>
    </div>
  );
}

function connectionCopy(connection: ContinuitySetupSession["connection"]) {
  return connection === "ONLINE"
    ? "Available now"
    : connection === "OFFLINE"
      ? "Currently offline"
      : "Reconnect required";
}

function nameFor(
  browserSessionId: string | undefined,
  sessions: ContinuitySetupSession[],
) {
  return (
    sessions.find((item) => item.browserSessionId === browserSessionId)
      ?.deviceName ?? "Paired Mac"
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function grantStateCopy(grant: ContinuitySetupGrant) {
  return grant.state === "REVOKED"
    ? "Handoff stopped"
    : grant.state === "EXPIRED"
      ? "Handoff expired"
      : "Handoff ready";
}

function TransferStatus({
  transfer,
}: {
  transfer: ContinuityGrantStatus["transfer"];
}) {
  const pending = transfer.pendingRevisions;
  return (
    <div className="continuity-card__agreement" aria-label="Transfer status">
      <p>
        {transfer.publishedRevision === 0
          ? "No updates published yet"
          : `${transfer.publishedRevision} ${transfer.publishedRevision === 1 ? "update" : "updates"} published`}
      </p>
      <p>Destination applied revision {transfer.appliedRevision}</p>
      <p>
        {pending === 0
          ? "Latest revision is applied"
          : `${pending} ${pending === 1 ? "update is" : "updates are"} waiting for the destination`}
      </p>
    </div>
  );
}
