# Village

Village is a self-hostable, local-first agent workspace. The cloud control
plane stores durable job state and sanitized events; the desktop owns browser
profiles, credentials, and interactive control.

This repository is an independent implementation. It does not copy source,
assets, schemas, tests, prose, or history from OpenMausBot. One small UI state
primitive is selectively adapted from MIT-licensed Downy and is tracked in the
provenance manifest and third-party notice.

## Development

Use Node 24.15 and pnpm 10.33:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

`apps/control-plane` can be deployed to an owner's Cloudflare account with
Wrangler. No Village-managed service is required by the protocol or build.

The LinkedIn compatibility spike is internal and human-only. It does not
authorize automated LinkedIn activity or external distribution.
