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

Canceling a Job preserves the signed-in profile. Use Forget session only when the owner wants the exact Site Session removed. It requires step-up authorization, closes the target, clears scoped storage, permissions, journals, temporary data, downloads, and credential references, removes the profile, and verifies absence. A partial failure is retriable with a new authorization and must not be labelled complete.

## Exit criteria

Recovery is complete only when control ownership is unambiguous, no stale Lease Epoch can dispatch, the in-flight action has a known or owner-gated outcome, and the visible Job state agrees with the coordinator. Restart retention and crash recovery remain packaged-alpha gates; unit tests alone are not production proof.
