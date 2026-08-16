# Two-Mac Site Session continuity proof — 2026-08-15

## Outcome

Village passed its first physical Mac-to-Mac continuity proof for the owned fixture. A Mac Studio published 20 encrypted Site Session revisions to an isolated Cloudflare Worker and SQLite Durable Object while the destination app was not running. A MacBook Air then applied all 20 revisions, retained the authenticated fixture state after restart, applied the source logout as revision 21, rejected access after revocation, and confirmed grant deletion.

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
  "site": "OWNED_FIXTURE"
}
```

The complete run took about 32 seconds after package-size repair. The final D1 audit found two test grants and both were `DELETED`. No temporary `village-two-mac-*` profile or private-key directory remained on either Mac.

## Defects found and fixed

1. Activation discovery and Durable Object fetch/ack shared one local sequence stream, although the server keeps independent sequence authorities. The first real destination run failed closed with `CONTINUITY_REQUEST_REPLAYED`. Village now persists distinct activation, enrollment, and mailbox sequence scopes while preserving the existing control-plane sequence key for backward compatibility.
2. Repeated proof packaging recursively embedded older packages from `dist/**`. The first transfer expanded to about 8 GB. Continuity packages now build outside `dist`, and their file manifest explicitly excludes every generated package directory. The resulting app is 292 MB with a 17 MB application payload.

## Boundaries and remaining gates

- Only `OWNED_FIXTURE` was accepted. LinkedIn was not opened, copied, or automated.
- The destination app was stopped while the source published, proving buffered resume. Sleep and a true network-loss/reconnect cycle remain manual follow-up coverage.
- The internal package forces `MOCK_TEST_ONLY` Keychain mode. It therefore cannot prove signed-build Keychain prompt behavior. Apple signing/notarization and prompt-count validation remain deferred as agreed.
- The run exercised a real Worker, remote D1, and SQLite Durable Object. It did not independently read raw Durable Object storage; zero-plaintext-at-rest remains supported by the encrypted envelope contract and existing adversarial tests, not a provider-side storage dump.
- The Cloudflare deployment used an isolated, temporary test environment with development-header owner setup. It is not suitable as a long-lived public service and should be removed after evidence capture.

## Next gate

Add a short owner-visible setup ceremony around this proven transport: name the two Macs, show the exact fixture/site scope, require explicit approval, display transfer/logout/revocation status, and provide one action that deletes the continuity relationship. A signed package can later repeat the same proof for Keychain and Gatekeeper behavior without changing the transport contract.
