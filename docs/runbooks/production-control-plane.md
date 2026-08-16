# Production control plane

Village can serve its web shell and Worker API from one custom Cloudflare
origin. The production config uses Cloudflare Access authentication, an exact
browser origin, D1, and the two Durable Object coordinators. It never enables
the development principal header.

This is a self-hosting deployment path. It does not create a Cloudflare Access
application or choose an identity provider for the owner.

For a personal alpha before a permanent name or domain is chosen, Village can
instead use an explicitly selected `workers.dev` origin. Cloudflare Access must
still protect that exact Worker URL before it is used. Keep this temporary mode
owner-only; Cloudflare recommends a custom domain for business-critical
production deployments.

## Before deployment

1. Create the custom hostname that will serve Village.
2. Add an OAuth or OIDC identity provider to Cloudflare Access. Google is a
   supported owner-facing choice; another compatible OIDC provider can be
   added later. Village does not store a separate password.
3. Add the Village hostname as a Cloudflare Access self-hosted application and
   create an allow policy for the intended owner. Access must be active before
   the first production deploy.
4. Add the narrowly scoped native-protocol Access applications described below.
   Do not bypass Access for the whole Worker or for browser-facing API routes.
5. Record the Access team domain and application audience.
6. Create the production D1 database. Do not reuse a development database.
7. Authenticate Wrangler to the Cloudflare account that owns the hostname and
   database.

Cloudflare Access checks every request before it reaches Village. The Worker
also validates the `Cf-Access-Jwt-Assertion` signature, issuer, audience, and
algorithm before mapping the owner to a Village principal. See Cloudflare's
[Access application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
and [JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
Cloudflare Access can use multiple identity providers for one application; see
the [identity FAQ](https://developers.cloudflare.com/cloudflare-one/faq/authentication-faq/).

### Native desktop paths

The owner-facing shell remains behind Access, but a newly paired desktop does
not possess the browser's Access cookie. Create three more-specific Access
applications with a `Bypass` policy whose only include rule is `Everyone`.
Cloudflare chooses these exact-path applications ahead of the whole-origin
owner application:

- Pairing consume:
  `village.example.com/api/pairing/*/consume`
- Signed desktop runtime (five destinations in one application):
  `village.example.com/api/browser-sessions/*/connect`,
  `village.example.com/api/browser-sessions/*/commands`,
  `village.example.com/api/browser-sessions/*/results`,
  `village.example.com/api/browser-sessions/*/automation-sync`, and
  `village.example.com/api/browser-sessions/*/workflow-operations`
- Signed continuity runtime (five destinations in one application):
  `village.example.com/api/site-session-continuity/recipient-keys`,
  `village.example.com/api/site-session-continuity/activations`,
  `village.example.com/api/site-session-continuity/grants/*/revisions`,
  `village.example.com/api/site-session-continuity/grants/*/fetch`, and
  `village.example.com/api/site-session-continuity/grants/*/acknowledgements`

Replace `village.example.com` with the exact production hostname, including a
temporary `workers.dev` hostname. These paths are public only at the Access
layer. Village still requires the one-time high-entropy pairing secret or a
device-bound signed envelope with its principal, device, Site Session,
sequence, and expiry bindings. Never add `Bypass` to `/api/*`, the whole
hostname, continuity owner controls, observer routes, or the web shell.

An unauthenticated probe to a native path should return a bounded Village JSON
validation error, not an Access redirect or HTML login page. A probe to
`/api/identity` must still require Access.

## Required environment

```sh
export VILLAGE_PRODUCTION_WORKER_NAME=village-production
export VILLAGE_PRODUCTION_ORIGIN=https://village.example.com
export VILLAGE_CLOUDFLARE_D1_DATABASE_NAME=village-production
export VILLAGE_CLOUDFLARE_D1_DATABASE_ID=<real-d1-uuid>
export CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
export CF_ACCESS_AUD=<access-application-audience>
```

For the temporary owner-only `workers.dev` mode, also set:

```sh
export VILLAGE_PRODUCTION_ROUTE_MODE=workers-dev
export VILLAGE_PRODUCTION_ORIGIN=https://village-production.<account-subdomain>.workers.dev
```

The first hostname label must exactly match
`VILLAGE_PRODUCTION_WORKER_NAME`. Omitting `VILLAGE_PRODUCTION_ROUTE_MODE`
retains the custom-domain-only default.

The production origin must be HTTPS with no path, query, fragment, credentials,
or non-default port. The deploy command derives the Wrangler route mode and
`VILLAGE_ALLOWED_ORIGINS` from that one value.

## Dry run

```sh
pnpm deploy:production -- --dry-run
```

The dry run builds `@village/web` and its workspace dependencies, writes the
ignored mode-600 production config, and asks Wrangler to validate the complete
Worker plus Static Assets bundle. It does not apply migrations or deploy.

## Deploy

Review the generated config at
`apps/control-plane/wrangler.production.generated.jsonc`, confirm that the
Access application already protects the exact hostname, then run:

```sh
pnpm deploy:production -- --confirm-production
```

The command builds the web shell, applies all D1 migrations remotely, and then
deploys the combined application. Omitting `--confirm-production` fails before
any Cloudflare mutation.

After deployment, sign in through Access in a normal browser. Pair each Mac
from that authenticated page. The paired desktop persists the same control
plane origin and uses its device-bound signed protocol for enrollment and Site
Session continuity; it does not receive or reuse the browser's Access token.
The web shell shows the verified email for the current Village Identity and
withholds pairing and handoff controls until `/api/identity` succeeds. Its
sign-out action uses the application-local Access logout endpoint, which clears
the application authorization cookie.

The Static Assets settings follow Cloudflare's current
[single-page application routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/):
the React shell is served as the SPA and `/api/*` is routed to the Worker.
