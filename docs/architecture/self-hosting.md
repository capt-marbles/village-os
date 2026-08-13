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
double-submit CSRF value. Desktop protocol requests carry short-lived Ed25519
envelopes bound to principal, device, job, session, action, lease epoch,
sequence, and protocol version.

The checked-in Wrangler variables intentionally describe local development.
Do not deploy them unchanged. Replace the placeholder D1 database identifier,
apply every migration in order, configure Access, and disable the public
`workers.dev` route unless it is explicitly protected.

## Authority and recovery

Each browser session has one Durable Object coordinator. Its SQLite event log,
lease epoch, accepted actions, result sequence, and projection outbox are the
authority. D1 stores owner-scoped jobs and rebuildable query projections. A D1
projection failure therefore exposes lag without discarding accepted control
state; replay by event sequence repairs the projection.
