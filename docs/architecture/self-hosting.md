# Self-hosting boundary

The control plane is built as a standard Cloudflare Worker and is deployable
with the owner's Cloudflare account and Wrangler credentials. The desktop and
web clients communicate through documented HTTP and WebSocket contracts; they
must not assume a Village-owned hostname, account, tenant, or secret store.

A future managed deployment may supply an endpoint during onboarding, but it
cannot change wire schemas or make owner export, deletion, or migration depend
on a managed-only service.
