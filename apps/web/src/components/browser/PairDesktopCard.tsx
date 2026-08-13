import { useMemo, useState } from "react";
import {
  PairingSetupClient,
  pairingCompletionUrl,
  pairingSessionUrl,
  parsePublicPairingRequest,
  type PairedBrowserSession,
  type PairingChallenge,
} from "./pairing-setup-client.js";

type Step = "ENTRY" | "CONFIRM" | "WAITING" | "READY";

export function PairDesktopCard({ client }: { client?: PairingSetupClient }) {
  const activeClient = useMemo(
    () =>
      client ??
      new PairingSetupClient(
        typeof window === "undefined"
          ? "https://village.invalid"
          : window.origin,
      ),
    [client],
  );
  const [publicRequest, setPublicRequest] = useState("");
  const [challenge, setChallenge] = useState<PairingChallenge | null>(null);
  const [session, setSession] = useState<PairedBrowserSession | null>(null);
  const [step, setStep] = useState<Step>("ENTRY");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await activeClient.begin(
        parsePublicPairingRequest(publicRequest),
      );
      setChallenge(next);
      setStep("CONFIRM");
    } catch (caught) {
      setError(
        import.meta.env.DEV && caught instanceof Error
          ? `Pairing failed: ${caught.message}`
          : "That public request is invalid or expired. Copy a fresh request from Village Desktop.",
      );
    } finally {
      setPending(false);
    }
  };

  const confirm = async () => {
    if (!challenge || pending) return;
    setPending(true);
    setError(null);
    try {
      await activeClient.confirm(challenge.pairingId);
      setStep("WAITING");
    } catch {
      setError(
        "Village could not confirm this desktop. Start again with a fresh request.",
      );
    } finally {
      setPending(false);
    }
  };

  const waitForDesktop = async () => {
    if (!challenge || pending) return;
    setPending(true);
    setError(null);
    try {
      const deadline = Math.min(
        Date.parse(challenge.expiresAt),
        Date.now() + 5 * 60_000,
      );
      while (Date.now() < deadline) {
        const status = await activeClient.status(challenge.pairingId);
        if (status === "CONSUMED") {
          const next = await activeClient.createSession(challenge.deviceId);
          setSession(next);
          setStep("READY");
          return;
        }
        if (status === "EXPIRED" || status === "REJECTED")
          throw new Error(status);
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      throw new Error("EXPIRED");
    } catch {
      setError(
        "The desktop did not finish pairing. Copy a fresh request and try again.",
      );
      setStep("ENTRY");
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="pair-desktop-card"
      aria-labelledby="pair-desktop-heading"
    >
      <p className="observer-card__eyebrow">LOCAL BROWSER</p>
      <h2 id="pair-desktop-heading">Add desktop</h2>
      {step === "ENTRY" ? (
        <>
          <p>
            Paste the public request shown by Village Desktop. It contains no
            password, cookies, or private key.
          </p>
          <label htmlFor="pairing-request">Public pairing request</label>
          <textarea
            id="pairing-request"
            value={publicRequest}
            onChange={(event) => setPublicRequest(event.currentTarget.value)}
            rows={7}
            spellCheck={false}
          />
          <button
            type="button"
            disabled={pending || publicRequest.trim() === ""}
            onClick={() => void begin()}
          >
            Review desktop
          </button>
        </>
      ) : null}
      {step === "CONFIRM" && challenge ? (
        <>
          <p>Confirm that this fingerprint matches the desktop window:</p>
          <output className="pair-desktop-card__fingerprint">
            {challenge.fingerprint}
          </output>
          <button
            type="button"
            disabled={pending}
            onClick={() => void confirm()}
          >
            Confirm desktop
          </button>
        </>
      ) : null}
      {step === "WAITING" && challenge ? (
        <>
          <p>
            Open the confirmed request on this Mac, then return here to finish
            assigning its LinkedIn browser.
          </p>
          <a
            className="pair-desktop-card__link"
            href={pairingCompletionUrl(challenge)}
            onClick={() => void waitForDesktop()}
          >
            Continue on this Mac
          </a>
          {pending ? <p role="status">Waiting for Village Desktop...</p> : null}
        </>
      ) : null}
      {step === "READY" && challenge && session ? (
        <>
          <p>
            The desktop is paired and a local LinkedIn browser session is ready.
          </p>
          <a
            className="pair-desktop-card__link"
            href={pairingSessionUrl(challenge, session)}
          >
            Open assigned browser
          </a>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
