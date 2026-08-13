import { useEffect, useState } from "react";

export interface PairingRequestView {
  deviceId: string;
  deviceDisplayName: string;
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  protection: "OS_PROTECTED_FALLBACK";
  secretHash: string;
}

export interface VillagePairingBridge {
  getPairingRequest(): Promise<PairingRequestView>;
  subscribePairingState(
    listener: (state: PairingViewState) => void,
  ): () => void;
}

export type PairingViewState =
  | "WAITING_FOR_CONFIRMATION"
  | "WAITING_FOR_SESSION"
  | "REJECTED"
  | "EXPIRED"
  | "PAIRED";

export function PairingBootstrap({
  bridge = globalThis.window?.villagePairing,
}: {
  bridge?: VillagePairingBridge;
}) {
  const [request, setRequest] = useState<PairingRequestView | null>(null);
  const [state, setState] = useState<PairingViewState>(
    "WAITING_FOR_CONFIRMATION",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      setError("Pairing is unavailable in this window.");
      return;
    }
    let active = true;
    const unsubscribe = bridge.subscribePairingState((next) => {
      if (active) setState(next);
    });
    void bridge
      .getPairingRequest()
      .then((next) => active && setRequest(next))
      .catch(() => active && setError("Secure device setup is unavailable."));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  return (
    <main className="pairing-bootstrap" aria-labelledby="pairing-heading">
      <p className="pairing-bootstrap__eyebrow">VILLAGE DESKTOP</p>
      <h1 id="pairing-heading">Pair this Mac</h1>
      <p>
        In Village on the web, choose <strong>Add desktop</strong> and paste the
        public request below. Confirm the device fingerprint there. This window
        continues automatically; private keys and the one-time secret never
        enter this page.
      </p>
      {request ? (
        <pre aria-label="Public pairing request">
          {JSON.stringify(request, null, 2)}
        </pre>
      ) : (
        <p role="status">Preparing a protected device identity...</p>
      )}
      <section aria-live="polite" aria-atomic="true">
        <h2>{pairingStateLabel[state]}</h2>
        <p>{pairingStateExplanation[state]}</p>
      </section>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}

const pairingStateLabel: Record<PairingViewState, string> = {
  WAITING_FOR_CONFIRMATION: "Waiting for your confirmation",
  WAITING_FOR_SESSION: "Desktop paired",
  REJECTED: "Pairing was rejected",
  EXPIRED: "Pairing expired",
  PAIRED: "Ready",
};

const pairingStateExplanation: Record<PairingViewState, string> = {
  WAITING_FOR_CONFIRMATION:
    "Complete the short-lived request in the authenticated Village web app.",
  WAITING_FOR_SESSION:
    "Choose or create a browser job in Village. This Mac will open it when assigned.",
  REJECTED: "Start a new request in Village and confirm this Mac again.",
  EXPIRED: "The one-time request expired. Start a new request in Village.",
  PAIRED: "The assigned browser session is opening on this Mac.",
};
