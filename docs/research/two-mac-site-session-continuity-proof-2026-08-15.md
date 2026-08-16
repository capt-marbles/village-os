# Two-Mac Site Session continuity proof — 2026-08-15

## Outcome

Village passed its first physical Mac-to-Mac continuity proof for the owned fixture and then repeated the proof through the owner-visible ceremony. The owner selected the Mac Studio as source, selected the MacBook Air as destination, approved the exact handoff, observed revision 21 after logout, stopped the handoff, and permanently deleted its encrypted cloud data. Behind that ceremony, the Studio published 20 encrypted Site Session revisions while the destination app was not running; the Air applied all 20, retained the authenticated fixture state after restart, applied the logout, and rejected access after revocation.

This is a **go** for continuing the Village-native continuity design. It is not yet a shipping claim for LinkedIn or arbitrary sites.

## Evidence

The run used the same unsigned, fixture-only Electron package on both Apple Silicon Macs. The machines communicated with Cloudflare independently; SSH over Tailscale was used only to install and launch the temporary destination package and retrieve its bounded JSON reports.

```json
{
  "status": "PASS",
  "sourceHost": "As-Mac-Studio",
  "destinationHost": "As-MacBook-Air",
  "transfersApplied": 20,
  "destinationRevision": 20,
  "restartRevision": 20,
  "restartNoNewRevision": true,
  "authenticatedAfterRestart": true,
  "logoutRevision": 21,
  "logoutPropagated": true,
  "revokedActivationAbsent": true,
  "revokedFetchRejected": true,
  "grantDeleted": true,
  "destinationOfflineDuringPublish": true,
  "keychainMode": "MOCK_TEST_ONLY",
  "site": "OWNED_FIXTURE",
  "ownerCeremony": true,
  "ownerApprovedGrant": true,
  "ownerObservedLogout": true,
  "ownerStoppedHandoff": true,
  "ownerDeletedHandoff": true
}
```

The complete run took about 32 seconds after package-size repair. The final D1 audit found two test grants and both were `DELETED`. No temporary `village-two-mac-*` profile or private-key directory remained on either Mac.

## Defects found and fixed

1. Activation discovery and Durable Object fetch/ack shared one local sequence stream, although the server keeps independent sequence authorities. The first real destination run failed closed with `CONTINUITY_REQUEST_REPLAYED`. Village now persists distinct activation, enrollment, and mailbox sequence scopes while preserving the existing control-plane sequence key for backward compatibility.
2. Repeated proof packaging recursively embedded older packages from `dist/**`. The first transfer expanded to about 8 GB. Continuity packages now build outside `dist`, and their file manifest explicitly excludes every generated package directory. The resulting app is 292 MB with a 17 MB application payload.
3. The first owner-visible attempt could load setup but could not create the handoff. The HTTPS development proxy preserved the localhost origin for the upstream TLS request and did not use the macOS system certificate store; after that was repaired, the browser still preferred a fixed development CSRF value over the issued proof cookie. The proxy now targets the upstream origin, the proof launch uses the system CA store, and the browser reads an issued CSRF cookie before using its local fallback. Focused regression tests cover both boundaries.

## Boundaries and remaining gates

- Only `OWNED_FIXTURE` was accepted. LinkedIn was not opened, copied, or automated.
- The destination app was stopped while the source published, proving buffered resume. Sleep and a true network-loss/reconnect cycle remain manual follow-up coverage.
- The internal package forces `MOCK_TEST_ONLY` Keychain mode. It therefore cannot prove signed-build Keychain prompt behavior. Apple signing/notarization and prompt-count validation remain deferred as agreed.
- The run exercised a real Worker, remote D1, and SQLite Durable Object. It did not independently read raw Durable Object storage; zero-plaintext-at-rest remains supported by the encrypted envelope contract and existing adversarial tests, not a provider-side storage dump.
- The Cloudflare deployment used an isolated, temporary test environment with development-header owner setup. It is not suitable as a long-lived public service and should be removed after evidence capture.

## Next gate

Integrate the proven owner ceremony into the normal paired-desktop experience and replace the proof-only development-header launch with production authentication. A signed package can later repeat the same proof for Keychain and Gatekeeper behavior without changing the transport contract.
