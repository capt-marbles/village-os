import { useEffect, useRef, useState } from "react";
import type {
  GmailCredentialMutationResult,
  GmailCredentialSnapshot,
} from "@village/contracts";

export interface GmailConnectionBridge {
  getGmailConnectionStatus(): Promise<GmailCredentialSnapshot>;
  connectGmail(): Promise<GmailCredentialMutationResult>;
  disconnectGmail(): Promise<GmailCredentialMutationResult>;
}

const unavailable = Object.freeze({
  provider: "GMAIL",
  state: "UNAVAILABLE",
  reason: "CREDENTIAL_STORE_UNAVAILABLE",
} satisfies GmailCredentialSnapshot);

export function GmailConnectionCard({
  bridge,
}: {
  bridge: GmailConnectionBridge;
}) {
  const [snapshot, setSnapshot] = useState<GmailCredentialSnapshot | null>(
    null,
  );
  const [pending, setPending] = useState<"CONNECT" | "DISCONNECT" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    void bridge
      .getGmailConnectionStatus()
      .then((next) => active && setSnapshot(next))
      .catch(() => active && setSnapshot(unavailable));
    return () => {
      active = false;
    };
  }, [bridge]);

  const apply = (
    result: GmailCredentialMutationResult,
    operation: "CONNECT" | "DISCONNECT",
  ) => {
    if (result.status === "snapshot") {
      setSnapshot(result.snapshot);
      setError(null);
      return;
    }
    setError(
      result.reason === "OAUTH_CANCELED"
        ? "Gmail connection was canceled."
        : result.reason === "OAUTH_CONNECT_IN_PROGRESS"
          ? "A Gmail connection is already waiting in your browser."
          : operation === "CONNECT"
            ? "Village could not connect Gmail. Try again."
            : "Village could not disconnect Gmail. Review the connection and try again.",
    );
  };

  const mutate = async (operation: "CONNECT" | "DISCONNECT") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(operation);
    setError(null);
    try {
      apply(
        operation === "CONNECT"
          ? await bridge.connectGmail()
          : await bridge.disconnectGmail(),
        operation,
      );
    } catch {
      setError(
        operation === "CONNECT"
          ? "Village could not connect Gmail. Try again."
          : "Village could not disconnect Gmail. Review the connection and try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const connected = snapshot?.state === "CONNECTED";
  return (
    <section className="ritual-tool" aria-label="Gmail connection">
      <div className="ritual-tool__mark" aria-hidden="true">
        G
      </div>
      <div className="ritual-tool__body">
        <div className="ritual-tool__heading">
          <div>
            <p className="ritual-tool__eyebrow">Steward&rsquo;s email source</p>
            <h2>{connected ? "Gmail connected" : "Connect Gmail"}</h2>
          </div>
          <span
            className={`ritual-tool__status ritual-tool__status--${connected ? "saved" : "local"}`}
          >
            {connected ? "Read-only" : "Local setup"}
          </span>
        </div>
        {!snapshot ? (
          <p role="status">Checking the Gmail connection on this Mac.</p>
        ) : connected ? (
          <>
            <p>{snapshot.accountEmail}</p>
            <p>
              The Inbox priority Ritual reads bounded message headers and
              labels, never bodies, attachments, or mail changes. Its derived
              Receipt is stored locally, and Gmail metadata is not sent to
              ChatGPT.
            </p>
            <div className="ritual-tool__actions">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void mutate("DISCONNECT")}
              >
                {pending === "DISCONNECT"
                  ? "Disconnecting…"
                  : "Disconnect Gmail"}
              </button>
            </div>
          </>
        ) : snapshot.state === "CONFIGURATION_REQUIRED" ? (
          <p>
            Gmail OAuth is not configured in this build. Add the desktop OAuth
            client ID, then reopen Village.
          </p>
        ) : snapshot.state === "UNAVAILABLE" ? (
          <p>
            Gmail setup is unavailable on this Mac. Check secure storage and try
            again.
          </p>
        ) : (
          <>
            <p>
              Village requests read-only message metadata. It reviews up to 25
              recent unread inbox items using headers and labels—never bodies,
              attachments, drafts, sends, labels, or other mail changes. This
              first version ranks the metadata locally. Gmail metadata is not
              sent to ChatGPT.
            </p>
            <div className="ritual-tool__actions">
              <button
                type="button"
                className="ritual-tool__action--primary"
                disabled={pending !== null}
                onClick={() => void mutate("CONNECT")}
              >
                {pending === "CONNECT" ? "Opening Google…" : "Connect Gmail"}
              </button>
            </div>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
