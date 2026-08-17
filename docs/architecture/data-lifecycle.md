# Data lifecycle

Village separates the local Site Session from cloud continuity records. Cancel, forget, and principal deletion are different operations and must not be described as interchangeable.

## Local records

| Record                             | Retention and protection                                                                       | Deletion                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Browser profile and Site Session   | Dedicated principal/device/site partition in a user-private directory; retained across restart | Only an owner-confirmed forget-session flow closes the target and removes its exact scope               |
| Credential vault and references    | OS-protected local vault; credentials remain local                                             | Forget-session revokes scoped credential references; vault deletion is verified by the owning operation |
| Action journal and takeover marker | Retained as needed for reconciliation and duplicate-effect prevention                          | Cleared for the exact Browser Session by successful forget-session                                      |
| Temporary files and downloads      | Local and session-scoped where the host can enforce it                                         | Included in the forget-session cleanup contract                                                         |
| Diagnostic preview                 | In-memory bounded fields; no automatic upload                                                  | Cleared with process lifetime; there is no server copy                                                  |

Cancel blocks future automation after reconciliation but deliberately preserves the Site Session. Forget-session requires a fresh single-use step-up token bound to principal, device, browser session, site, operation, and current state. Partial deletion is reported as retriable and never presented as complete until an absence check passes.

## Cloud records

Cloud records are principal-scoped. `GET /api/owner/data-export` returns an owner-authenticated, sanitized export of D1 records plus a record-count summary from every authoritative Browser Session coordinator. It excludes identity subjects, device public keys, pairing hashes, raw payload JSON, and continuity ciphertext.

Cloud deletion is deliberately two-stage. `POST /api/owner/deletion-requests` requires exact-origin CSRF protection and the closed confirmation phrase. The matching confirmation route derives the principal from authentication, destroys every enumerated Browser Session coordinator and continuity mailbox, deletes D1 owner data, and marks its surviving tombstone complete only after absence verification. A lost success response can be retried without recreating the deleted principal. Another principal's coordinator and records are never selected by either operation.

The bounded-history policy currently applies 30-day retention to projections, ordered events, checkpoints, receipts, workflow effects, actor markers, and cancellations for terminal Jobs. The remaining record-class inventory, ephemeral quota/replay cleanup, and continuity-grant cron cleanup remain release gates; the owner routes do not imply those gates are complete.

Cloud deletion is not browser-profile deletion because the cloud never owns that profile. Conversely, deleting a local profile does not erase principal-scoped control-plane history. An owner requesting complete removal must complete both lifecycles.

## Backup and verification limits

Active cloud records can be removed and checked immediately; immutable backup copies may persist until the provider's documented backup-retention window expires. The service must not claim immediate physical deletion from backups. The exact provider window, restore procedure, and deletion-verification evidence must be recorded before external alpha distribution.

On macOS, backup/indexing exclusions are a release gate. Source-level directory permissions alone do not prove Time Machine, Spotlight, third-party backup, or restored-device behavior. A packaged test must record the effective exclusion state and fail closed when the supported posture cannot be met.
