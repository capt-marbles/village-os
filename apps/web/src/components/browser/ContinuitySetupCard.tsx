import { useEffect, useMemo, useState } from "react";
import {
  ContinuitySetupClient,
  type ContinuitySetupGrant,
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
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void activeClient
      .load(abort.signal)
      .then((snapshot) => {
        setSessions(snapshot.sessions);
        const active = snapshot.grants.find((item) =>
          ["PENDING", "ACTIVE"].includes(item.state),
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

  const approve = async () => {
    if (!source || !destination || pending) return;
    setPending(true);
    setError(null);
    try {
      setGrant(await activeClient.createGrant(source, destination));
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
      setGrant(null);
      setStopped(true);
      setStep("CLOSED");
    } catch {
      setError("Village could not stop this handoff. Try again.");
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
          {loading ? <p>Checking paired Macs…</p> : null}
          {!loading && sourceCandidates.length > 0 ? (
            <>
              <p>
                {sessions.length === 2
                  ? "Two paired Macs are available."
                  : `${sessions.length} paired Macs are available.`}
              </p>
              <button
                type="button"
                onClick={() => {
                  setStopped(false);
                  setStep("SOURCE");
                }}
              >
                Set up handoff
              </button>
            </>
          ) : null}
          {!loading && sourceCandidates.length === 0 ? (
            <>
              <p>
                {sessions.length < 2
                  ? "Pair two Macs to try the demo handoff."
                  : "Finish continuity enrollment on a destination Mac."}
              </p>
              <p className="continuity-card__boundary">
                LinkedIn stays local for now.
              </p>
            </>
          ) : null}
          {stopped ? (
            <p className="continuity-card__success">Handoff stopped</p>
          ) : null}
        </div>
      ) : null}

      {step === "SOURCE" ? (
        <SetupChoice
          progress="Step 1 of 3"
          legend="Where should the session come from?"
          help="Choose the Mac where the Village demo account is already signed in."
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
          legend="Where should Village keep it available?"
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
            <li>Village demo account only</li>
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
          <p className="continuity-card__success">Handoff ready</p>
          <h3>
            {sourceName} <span aria-hidden="true">→</span> {destinationName}
          </h3>
          <p>
            Village can keep the demo session available until{" "}
            {formatDate(grant.expiresAt)}.
          </p>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void stop()}
            disabled={pending}
          >
            {pending ? "Stopping…" : "Stop handoff"}
          </button>
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
