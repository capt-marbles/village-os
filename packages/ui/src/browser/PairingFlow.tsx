import type { BrowserPairing } from "./browser-ui-state-matrix.js";

export function PairingFlow({ state }: { state: BrowserPairing }) {
  if (state === "PAIRED") return null;
  return (
    <section aria-labelledby="pairing-title" style={{ padding: "1rem" }}>
      <h2 id="pairing-title">Connect this desktop</h2>
      <p>Pairing is one-time, expires quickly, and must be confirmed by you.</p>
      <p>Finish or restart pairing in the secure desktop setup window.</p>
    </section>
  );
}
