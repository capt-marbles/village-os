# Production control plane

Village can serve its web shell and Worker API from one custom Cloudflare
origin. The production config uses Cloudflare Access authentication, an exact
browser origin, D1, and the two Durable Object coordinators. It never enables
the development principal header.

This is a self-hosting deployment path. It does not create a Cloudflare Access
application or choose an identity provider for the owner.

## Before deployment

1. Create the custom hostname that will serve Village.
2. Add that hostname as a Cloudflare Access self-hosted application and create
   an allow policy for the intended owner. Access must be active before the
   first production deploy.
3. Record the Access team domain and application audience.
4. Create the production D1 database. Do not reuse a development database.
5. Authenticate Wrangler to the Cloudflare account that owns the hostname and
   database.

Cloudflare Access checks every request before it reaches Village. The Worker
also validates the `Cf-Access-Jwt-Assertion` signature, issuer, audience, and
algorithm before mapping the owner to a Village principal. See Cloudflare's
[Access application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
and [JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Required environment

```sh
export VILLAGE_PRODUCTION_WORKER_NAME=village-production
export VILLAGE_PRODUCTION_ORIGIN=https://village.example.com
export VILLAGE_CLOUDFLARE_D1_DATABASE_NAME=village-production
export VILLAGE_CLOUDFLARE_D1_DATABASE_ID=<real-d1-uuid>
export CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
export CF_ACCESS_AUD=<access-application-audience>
```

The production origin must be an HTTPS custom domain with no path, query,
fragment, credentials, or non-default port. The deploy command derives the
Wrangler custom-domain route and `VILLAGE_ALLOWED_ORIGINS` from that one value.

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

The Static Assets settings follow Cloudflare's current
[single-page application routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/):
the React shell is served as the SPA and `/api/*` is routed to the Worker.
