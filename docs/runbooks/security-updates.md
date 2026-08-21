# Security updates and macOS release runbook

Village alpha supports Electron major 43 on macOS. A dependency upgrade to another Electron major is a security review, packaged regression run, and explicit policy change—not an automatic version bump.

## Release prerequisites

The distributable configuration requires hardened runtime, ASAR integrity validation, app-only ASAR loading, encrypted cookies, disabled Node CLI/environment escape hatches, Developer ID signing, and Apple notarization. The main-process updater routes every downloaded candidate through the pinned endpoint, signer, checksum, product, channel, and downgrade policy. Automatic publication remains disabled until the signed packaged update ceremony below passes against the owned endpoint.

Before packaging, provide signing material through Electron Builder's supported `CSC_LINK` or `CSC_NAME` mechanism, one supported Apple notarization credential set, and `VILLAGE_RELEASE_SIGNER_SHA256` with the reviewed certificate fingerprint. Run:

```sh
export VILLAGE_RELEASE_METRICS_PATH="$PWD/release/evidence/release-metrics.json"
pnpm release:validate
pnpm --filter @village/desktop package:mac:release
```

The evidence file and collection procedure are defined in
`docs/runbooks/release-metrics.md`. Release validation fails before signing when
the measured setup, recovery, leakage, attention, or replay gates are absent,
stale, incomplete, or below threshold.

The validation command intentionally fails in an ordinary checkout. This repository has no Apple signing credentials and cannot currently claim a signed or notarized release. Never commit credentials, certificate archives, passwords, API keys, or notarization profiles.

For local packaged E2E only, use:

```sh
pnpm --filter @village/desktop package:mac:e2e
pnpm --filter @village/desktop verify:clean-install
```

The first command uses the explicit ad-hoc, non-notarized, non-publishing configuration. The second copies that bundle into a fresh temporary `Applications` directory, re-verifies its signature and fuses, launches it with isolated state, and requires the trusted packaged workflow to reach one receipted terminal result. The temporary install and profile are removed afterward. This is clean-install compatibility evidence, not distributable signing, notarization, or Gatekeeper evidence.

## Update acceptance

Before installation, the trusted update boundary rejects:

- product identifier other than `com.village.desktop`;
- channel other than `alpha`;
- a request outside `https://updates.village.run/desktop/alpha/manifest.json`;
- an artifact outside the direct-child ZIP namespace at `https://updates.village.run/desktop/alpha/`;
- any manifest or artifact redirect, including another HTTPS host;
- a certificate fingerprint different from the compiled trust policy;
- malformed or mismatched SHA-512 artifact digest; and
- an equal, lower, or malformed semantic version.

Only a release package embeds `VILLAGE_RELEASE_SIGNER_SHA256` into its packaged metadata; ad-hoc and proof packages explicitly contain no usable pin and do not start the updater. The runtime fetches a strict, bounded JSON manifest without following redirects, streams the bounded ZIP into a private staging directory, rejects unsafe archive paths before extraction, verifies the app bundle with `codesign`, derives the leaf-certificate SHA-256 fingerprint and bundle identifier from the artifact, and compares the actual checksum. Only then does it give Electron a private `file:` feed for Squirrel.Mac's own staging and signature check. A native main-process prompt controls immediate restart; choosing Later keeps the staged update for the next restart.

The endpoint's ownership, TLS behavior, availability, no-redirect behavior, and manifest publication process have not yet been proven from a signed package. Until that ceremony passes, do not publish a manifest. The manifest has exactly these fields: `productId`, `channel`, `version`, `artifactUrl`, and lowercase hexadecimal `sha512`; release notes and other unbounded data are not accepted at this trust boundary.

## Artifact verification

For each candidate release, archive evidence for the source commit, dependency audit, static configuration gate, tests, package hash, `codesign` identity and entitlements, notarization result, Gatekeeper assessment, Electron fuse state, the updater pin extracted from packaged `package.json`, update manifest, redirect behavior, and clean-install/update/downgrade tests. The packaged verifier requires the updater pin to equal the certificate fingerprint it observed on the app. A source configuration is not proof that the produced artifact has those properties.

`pnpm audit:sbom` fails closed when an installed production component or the bundled Electron runtime lacks a version, license, or complete dependency reference. A successful release package writes the deterministic CycloneDX 1.6 inventory to `release/sbom/village.cdx.json` after artifact verification. Archive that file beside the signed release artifacts; it contains package URLs and safe distribution references but no local filesystem paths.

## Response targets

- Triage a credible critical Electron or Village security report within 24 hours.
- Decide within 48 hours whether to patch, disable the affected feature, or pause alpha distribution.
- Target a signed replacement within 72 hours when credentials and upstream fixes are available.
- If those targets cannot be met, disable update publication and tell alpha users to stop using the affected build. These are operational targets, not a guaranteed public SLA.

Once automatic updates are enabled, rollback means withdrawing the bad manifest, keeping downgrade protection enabled, and publishing a strictly newer corrected version. Never direct users to bypass signing, Gatekeeper, signer checks, or monotonic-version enforcement.
