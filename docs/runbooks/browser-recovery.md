# Browser recovery runbook

Use this runbook when the local Browser Session crashes, disconnects, or stops making progress. Recovery must preserve the owner's ability to browse while preventing duplicate automated effects.

## First response

1. Read the visible controller, connection, Action Phase, and last update. Do not infer control from whether the page accepts clicks.
2. If the owner needs immediate access, request takeover. Offline takeover creates a local marker and blocks automation; it does not claim a cloud Lease Epoch.
3. Keep the Village process open when practical. Do not delete the profile directory, cookies, journal, or lock file manually.
4. Open Local diagnostics. The preview stays on the Mac and contains only component, code, and whether retry is available.

## Recovery cases

- **Browser or renderer crash:** restart Village. The host must reopen the exact scoped profile, reconcile any accepted or dispatched Browser Action, and resume only with a fresh valid lease. An unknown non-idempotent effect waits for the owner.
- **Network loss:** manual browsing may continue after local takeover. Automation remains blocked until the coordinator sees the takeover marker, advances the Lease Epoch, and reconciliation completes.
- **Lost acknowledgement:** inspect the action postcondition before retry. Never repeat credential input or submit solely because a receipt is absent.
- **Host unavailable:** the Job reports `WAITING_FOR_BROWSER`. Village must not silently substitute a VPS or remote browser.
- **Repeated recovery failure:** leave the Job waiting, copy only the bounded diagnostic code, app version, macOS version, and approximate time, then escalate. Never send page captures, URLs with query strings, cookies, credentials, profile archives, or vault files.

## Destructive recovery

Canceling a Job preserves the signed-in profile. Use Forget session only when the owner wants the exact Site Session removed. It requires step-up authorization and native confirmation, fences automation, closes the target, clears live scoped storage and permissions, revokes credential references, and writes a private exact-scope deletion continuation. Village then restarts so Chromium has released the partition before removing the whole scoped profile, including journals, temporary data, and downloads. Startup verifies absence before recreating a clean browser profile. A partial failure remains retriable and must not be labelled complete.

## Exit criteria

Recovery is complete only when control ownership is unambiguous, no stale Lease Epoch can dispatch, the in-flight action has a known or owner-gated outcome, and the visible Job state agrees with the coordinator. Restart retention and crash recovery remain packaged-alpha gates; unit tests alone are not production proof.

For the owned fixture, `pnpm --filter @village/desktop package:mac:credential-e2e` is the packaged erasure gate. It seeds Chromium cookies, local storage, IndexedDB, Cache Storage, journal, temporary, download, and credential-reference state; checks missing, expired, replayed, and every exact-binding mismatch; proves confirmation cancellation preserves the profile; injects a staging failure and retries with fresh authorization; then starts a second packaged process to complete deletion. The second process proves the target profile, lock, and credential reference are absent, the pending request is consumed, and a sibling Site Session's cookie, LocalStorage, IndexedDB, Cache Storage, journal, credential marker, and deny-by-default permission posture survive. The proof uses the production main-process request controller with a deterministic owner-presence seam; the real fixed macOS authorization command remains separately unit-tested and requires an owner-operated packaged smoke before release.

Run the owner-operated macOS gate with `pnpm --filter @village/desktop package:mac:profile-e2e`. It intentionally requests Keychain access, shows the fixed system administrator-authorization prompt, and then shows the same native forget-session confirmation used by production. Confirming the proof does not erase a real Site Session: it operates only on a temporary owned-fixture profile and removes that profile afterward. A passing run verifies encrypted cookie persistence, private profile storage, Time Machine exclusion, Spotlight exclusion, current-owner authorization, and native confirmation. Canceling either owner prompt is a safe failed gate, never an implicit approval.
