# Self-hosting boundary

The control plane is built as a standard Cloudflare Worker and is deployable
with the owner's Cloudflare account and Wrangler credentials. The desktop and
web clients use the documented authoritative HTTP contract; a notification
WebSocket may be added without replacing cursor-based recovery. Clients must
not assume a Village-owned hostname, account, tenant, or secret store.

A future managed deployment may supply an endpoint during onboarding, but it
cannot change wire schemas or make owner export, deletion, or migration depend
on a managed-only service.

## Authentication modes

`development-header` is accepted only when `VILLAGE_ENVIRONMENT` is
`development` or `test`. It exists for local development and must never be used
for an Internet deployment.

Production deployments use `cloudflare-access` and must set:

- `VILLAGE_ENVIRONMENT=production`
- `VILLAGE_AUTH_MODE=cloudflare-access`
- `CF_ACCESS_TEAM_DOMAIN` to the exact Access team origin
- `CF_ACCESS_AUD` to the application's Access audience
- `VILLAGE_ALLOWED_ORIGINS` to an exact comma-separated allowlist

The Worker verifies the Access assertion signature, issuer, audience, and
algorithm before mapping its subject to a stable Village principal. Browser
mutations additionally require an exact allowed origin and a matching
double-submit CSRF value. Desktop protocol requests carry short-lived
device-signed envelopes bound to principal, device, job, session, action,
lease epoch, sequence, and protocol version. The registered credential records
its exact algorithm and protection class; the Worker accepts only the matching
P-256/ES256 hardware path or the Ed25519 OS-protected fallback.

The checked-in Wrangler variables intentionally describe local development.
Do not deploy them unchanged. Replace the placeholder D1 database identifier,
apply every migration in order, configure Access, and disable the public
`workers.dev` route unless it is explicitly protected.

The supported production path is documented in
[`docs/runbooks/production-control-plane.md`](../runbooks/production-control-plane.md).
It generates an ignored production Wrangler config, serves the web shell and
API from one Access-protected custom origin, and requires an explicit
`--confirm-production` flag before applying migrations or deploying.

## Authority and recovery

Each browser session has one Durable Object coordinator. Its SQLite event log,
lease epoch, accepted actions, result sequence, and projection outbox are the
authority. D1 stores owner-scoped jobs and rebuildable query projections. A D1
projection failure therefore exposes lag without discarding accepted control
state; replay by event sequence repairs the projection. The WebSocket stream is
only a low-latency notification path: it replays from a caller cursor, and the
HTTP event cursor remains the recovery contract after disconnects or gaps.

## Desktop device keys

On a packaged Mac, a new desktop identity prefers a P-256 signing key generated
inside the Secure Enclave. A small bundled Swift helper returns only the public
JWK, signatures, and CryptoKit's device-bound wrapped representation; raw
private-key material cannot cross into Electron. The main process stores that
wrapped representation in an owner-only versioned file and invokes the helper
through bounded JSON on standard input. Renderers receive neither the wrapped
representation nor a signing capability.

If the Secure Enclave is genuinely unavailable, Village uses the supported
Ed25519 fallback. It exports private key material only transiently for
encryption by Electron `safeStorage`, zeroes the temporary byte buffer, and
persists only a versioned encrypted blob with owner-only permissions. On load,
the key is imported as non-exportable before use. An existing version-1
Ed25519 identity remains on this fallback until the owner re-pairs or rotates
that device; Village never silently replaces an enrolled credential.

Village fails closed if a stored Secure Enclave identity can no longer be
opened or if a supposedly available hardware provider fails during creation.
It also fails closed when the fallback OS-protected provider is unavailable;
in particular, Linux's `basic_text` backend is not accepted. Corrupt files,
symbolic links, public-key mismatches, and files with group or world
permissions are rejected rather than silently replaced.
