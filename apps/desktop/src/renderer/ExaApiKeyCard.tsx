import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ExaCredentialMutationResult,
  ExaCredentialSnapshot,
} from "@village/contracts";

export interface ExaCredentialBridge {
  getExaCredentialStatus(): Promise<ExaCredentialSnapshot>;
  configureExaApiKey(apiKey: Uint8Array): Promise<ExaCredentialMutationResult>;
  removeExaApiKey(): Promise<ExaCredentialMutationResult>;
  openExaDashboard(): Promise<void>;
}

const unavailable = Object.freeze({
  provider: "EXA",
  state: "UNAVAILABLE",
  reason: "CREDENTIAL_STORE_UNAVAILABLE",
} satisfies ExaCredentialSnapshot);

export function ExaApiKeyCard({ bridge }: { bridge: ExaCredentialBridge }) {
  const [snapshot, setSnapshot] = useState<ExaCredentialSnapshot | null>(null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<
    "SAVE" | "REMOVE" | "REFRESH" | "OPEN" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void bridge
      .getExaCredentialStatus()
      .then((next) => active && setSnapshot(next))
      .catch(() => active && setSnapshot(unavailable));
    return () => {
      active = false;
    };
  }, [bridge]);

  const apply = (result: ExaCredentialMutationResult) => {
    if (result.status === "snapshot") {
      setSnapshot(result.snapshot);
      setEditing(false);
      setError(null);
      return;
    }
    setError(
      result.reason === "INVALID_API_KEY"
        ? "The key was not saved. Check the key and try again."
        : result.reason === "CREDENTIAL_CHANGED"
          ? "The saved key changed while the confirmation was open. Review it and try again."
          : "Secure key storage is unavailable on this Mac. Try again after checking macOS Keychain.",
    );
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("SAVE");
    setError(null);
    const transient = new TextEncoder().encode(input.current?.value ?? "");
    if (input.current) input.current.value = "";
    try {
      apply(await bridge.configureExaApiKey(transient));
    } catch {
      setError("The key was not saved. Check the key and try again.");
    } finally {
      transient.fill(0);
      inFlight.current = false;
      setPending(null);
    }
  };

  const remove = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("REMOVE");
    setError(null);
    try {
      apply(await bridge.removeExaApiKey());
    } catch {
      setError("Village could not remove the local key. Try again.");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("REFRESH");
    setError(null);
    try {
      setSnapshot(await bridge.getExaCredentialStatus());
    } catch {
      setSnapshot(unavailable);
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const openDashboard = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("OPEN");
    setError(null);
    try {
      await bridge.openExaDashboard();
    } catch {
      setError("Village could not open the Exa dashboard. Try again.");
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const keySaved = snapshot?.state === "CONFIGURED";
  const title = !snapshot
    ? "Checking web research…"
    : keySaved
      ? "Exa key saved"
      : snapshot.state === "UNAVAILABLE"
        ? "Web research unavailable"
        : "Add web research";

  return (
    <section className="ritual-tool" aria-label="Exa research connection">
      <div className="ritual-tool__mark" aria-hidden="true">
        E
      </div>
      <div className="ritual-tool__body">
        <div className="ritual-tool__heading">
          <div>
            <p className="ritual-tool__eyebrow">
              Steward&rsquo;s research tool
            </p>
            <h2>{title}</h2>
          </div>
          <span
            className={`ritual-tool__status ritual-tool__status--${keySaved ? "saved" : "local"}`}
          >
            {keySaved ? "Saved locally" : "Local setup"}
          </span>
        </div>

        {!snapshot ? (
          <p role="status">Checking encrypted storage on this Mac.</p>
        ) : keySaved && !editing ? (
          <>
            <p>
              The saved key stays encrypted on this Mac. Village will validate
              it with Exa when a research step first runs.
            </p>
            <div className="ritual-tool__actions">
              <button
                type="button"
                className="ritual-tool__action--primary"
                disabled={pending !== null}
                onClick={() => setEditing(true)}
              >
                Replace key
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void remove()}
              >
                {pending === "REMOVE" ? "Removing…" : "Remove key"}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void openDashboard()}
              >
                {pending === "OPEN" ? "Opening…" : "Open Exa key dashboard"}
              </button>
            </div>
          </>
        ) : snapshot.state === "UNAVAILABLE" ? (
          <>
            <p>
              Village could not open secure key storage. Check macOS Keychain,
              then try again.
            </p>
            <div className="ritual-tool__actions">
              <button
                type="button"
                className="ritual-tool__action--primary"
                disabled={pending !== null}
                onClick={() => void refresh()}
              >
                {pending === "REFRESH" ? "Checking…" : "Try again"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Give the Steward bounded public-web research. When research runs,
              your key is sent only to Exa; Village stores it encrypted on this
              Mac.
            </p>
            {editing ? (
              <form className="ritual-tool__form" onSubmit={save}>
                <label htmlFor="exa-api-key">Exa API key</label>
                <input
                  id="exa-api-key"
                  type="password"
                  minLength={8}
                  maxLength={512}
                  ref={input}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <div className="ritual-tool__actions">
                  <button
                    type="submit"
                    className="ritual-tool__action--primary"
                    disabled={pending !== null}
                  >
                    {pending === "SAVE" ? "Saving locally…" : "Save key"}
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => {
                      if (input.current) input.current.value = "";
                      setEditing(false);
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void openDashboard()}
                  >
                    {pending === "OPEN" ? "Opening…" : "Get an Exa key"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="ritual-tool__actions">
                <button
                  type="button"
                  className="ritual-tool__action--primary"
                  disabled={pending !== null}
                  onClick={() => setEditing(true)}
                >
                  Connect Exa
                </button>
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void openDashboard()}
                >
                  {pending === "OPEN" ? "Opening…" : "Get an Exa key"}
                </button>
              </div>
            )}
          </>
        )}
        {error ? (
          <p role="alert" className="ritual-tool__error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
