import type { VillageIdentitySession } from "@village/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { VillageIdentityClient } from "./village-identity-client.js";

type IdentityState =
  | { status: "LOADING" }
  | { status: "AUTHENTICATED"; identity: VillageIdentitySession }
  | { status: "UNAUTHENTICATED" };

export function VillageIdentityGate({
  children,
  client,
}: {
  children: ReactNode;
  client?: VillageIdentityClient;
}) {
  const activeClient = useMemo(
    () =>
      client ??
      new VillageIdentityClient(
        typeof window === "undefined"
          ? "https://village.invalid"
          : window.origin,
      ),
    [client],
  );
  const [state, setState] = useState<IdentityState>({ status: "LOADING" });

  useEffect(() => {
    const abort = new AbortController();
    void activeClient
      .load(abort.signal)
      .then((identity) => {
        if (!abort.signal.aborted) {
          setState({ status: "AUTHENTICATED", identity });
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ status: "UNAUTHENTICATED" });
      });
    return () => abort.abort();
  }, [activeClient]);

  if (state.status === "LOADING") {
    return <p role="status">Checking Village sign-in…</p>;
  }
  if (state.status === "UNAUTHENTICATED") {
    return (
      <section
        className="village-identity-card"
        aria-labelledby="village-sign-in-heading"
      >
        <p className="observer-card__eyebrow">VILLAGE IDENTITY</p>
        <h2 id="village-sign-in-heading">Sign in required</h2>
        <p>Sign in before pairing a desktop or approving a handoff.</p>
        <a href="/">Sign in to Village</a>
      </section>
    );
  }

  const { identity } = state;
  return (
    <>
      <section
        className="village-identity-card"
        aria-labelledby="village-identity-heading"
      >
        <p className="observer-card__eyebrow">VILLAGE IDENTITY</p>
        <h2 id="village-identity-heading">Signed in</h2>
        <p>
          {identity.provider === "CLOUDFLARE_ACCESS"
            ? identity.email
            : "Development identity"}
        </p>
        {identity.provider === "CLOUDFLARE_ACCESS" ? (
          <a href={identity.signOutPath}>Sign out</a>
        ) : null}
      </section>
      {children}
    </>
  );
}
