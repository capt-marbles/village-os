# Security updates and macOS release runbook

Village alpha supports Electron major 43 on macOS. A dependency upgrade to another Electron major is a security review, packaged regression run, and explicit policy change—not an automatic version bump.

## Release prerequisites

The distributable configuration requires hardened runtime, ASAR integrity validation, app-only ASAR loading, encrypted cookies, disabled Node CLI/environment escape hatches, Developer ID signing, and Apple notarization. Automatic publication is disabled until a main-process updater routes every downloaded candidate through the pinned endpoint, signer, checksum, product, channel, and downgrade policy.

Before packaging, provide signing material through Electron Builder's supported `CSC_LINK` or `CSC_NAME` mechanism, one supported Apple notarization credential set, and `VILLAGE_RELEASE_SIGNER_SHA256` with the reviewed certificate fingerprint. Run:

```sh
pnpm release:validate
pnpm --filter @village/desktop package:mac:release
```

The validation command intentionally fails in an ordinary checkout. This repository has no Apple signing credentials and cannot currently claim a signed or notarized release. Never commit credentials, certificate archives, passwords, API keys, or notarization profiles.

For local packaged E2E only, use:

```sh
pnpm --filter @village/desktop package:mac:e2e
```

That command uses the explicit ad-hoc, non-notarized, non-publishing configuration. Its artifact is not distributable release evidence.

## Update acceptance

Before installation, the trusted update boundary rejects:

- product identifier other than `com.village.desktop`;
- channel other than `alpha`;
- a request outside `https://updates.village.run/desktop/alpha/manifest.json`;
- any redirect, including another HTTPS host;
- a certificate fingerprint different from the compiled trust policy;
- malformed or mismatched SHA-512 artifact digest; and
- an equal, lower, or malformed semantic version.

The current module validates update evidence but is not yet wired to a production downloader or installer. The endpoint's ownership, TLS behavior, availability, and no-redirect behavior must be verified from a packaged build before enabling updates.

## Artifact verification

For each candidate release, archive evidence for the source commit, dependency audit, static configuration gate, tests, package hash, `codesign` identity and entitlements, notarization result, Gatekeeper assessment, Electron fuse state, update manifest, redirect behavior, and clean-install/update/downgrade tests. A source configuration is not proof that the produced artifact has those properties.

## Response targets

- Triage a credible critical Electron or Village security report within 24 hours.
- Decide within 48 hours whether to patch, disable the affected feature, or pause alpha distribution.
- Target a signed replacement within 72 hours when credentials and upstream fixes are available.
- If those targets cannot be met, disable update publication and tell alpha users to stop using the affected build. These are operational targets, not a guaranteed public SLA.

Once automatic updates are enabled, rollback means withdrawing the bad manifest, keeping downgrade protection enabled, and publishing a strictly newer corrected version. Never direct users to bypass signing, Gatekeeper, signer checks, or monotonic-version enforcement.
