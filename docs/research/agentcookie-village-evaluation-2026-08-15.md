# AgentCookie relevance to Village

Date: 2026-08-15  
Upstream audited: `mvanhorn/agentcookie` v1.0.0, commit `e498e93bcaac867386dfba12ea709882dff037ba`

## Verdict

AgentCookie is a strong reference implementation for future Mac-to-Mac session continuity, but it is not a drop-in session layer for Village. It did not block Village PR #16. The first isolated spike now proves a narrow, owner-approved, LinkedIn-only destination adapter.

Village should not expose a production CDP port or write AgentCookie data directly into Chromium SQLite. The safer seam is an authenticated AgentCookie-compatible receiver that maps an explicitly allowlisted cookie batch into the exact Village Electron `Session` through `session.cookies.set()`.

## Current spike boundary

The current spike validates a signed-envelope shape, exact destination binding, a one-minute lifetime, owner authorization, replay rejection, a strict LinkedIn cookie allowlist, direct Electron cookie insertion, persistent-store flushing, and secret-free results and errors. Its verifier and replay store are injected seams, and the importer is not wired into the production desktop runtime.

It does not yet extract Chrome cookies, pair two Macs, encrypt or transport an envelope, persist replay state across restart, expose an owner ceremony, propagate logout, or prove that LinkedIn accepts the transferred Site Session. Those are separate go/no-go work, not implied capabilities.

## Verified upstream behavior

AgentCookie continuously reads and decrypts Chrome cookies on a source Mac, filters them, seals a versioned envelope under a paired key, and sends it over Tailscale. A sink filters again and either writes Chrome storage or injects cookies into a live Chromium browser. [README](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/README.md#L34-L62), [architecture](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/docs/architecture.md#L5-L57)

Pairing uses X25519 and HKDF-SHA256; payload encryption uses AES-256-GCM over the Tailscale channel. Replay state is persisted. [pairing](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/pairing/pairing.go#L1-L16), [protocol](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/docs/protocol.md#L7-L36)

The envelope can also carry Local Storage, IndexedDB tarballs, and a secrets bus. Those surfaces materially enlarge the risk beyond selective cookie portability and should remain outside a first Village spike. [envelope](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/protocol/envelope.go#L15-L48)

The repository is MIT licensed, copyright 2026 Matthew Charles Van Horn. Copied or substantially ported code requires preservation of the license notice. [LICENSE](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/LICENSE)

The v1.0.0 release is very new. The repository was created in May 2026 and v1.0.0 was published on 2026-08-14. Documentation already contains some drift: the quickstart calls continuous watch a roadmap item while the current CLI and README ship it. Pin any experiment to a reviewed tag or commit.

Local verification: `go test ./...` passed for the audited commit. The downloaded v1.0.0 macOS arm64 archive matched its published SHA-256 digest, and its binary carries a timestamped Developer ID signature for Matthew Charles Van Horn.

## Fit with Village

Village owns a protected Electron profile per principal, device, and site through `session.fromPath(...)`. AgentCookie's macOS sink targets Google Chrome storage; its live path targets a Chromium CDP endpoint. Neither target is Village's scoped Electron session.

Electron exposes main-process cookie operations, including HttpOnly, Secure, SameSite, expiry, and persistent-store flushing. This is the appropriate import boundary. [Electron Cookies API](https://www.electronjs.org/docs/latest/api/cookies)

Enabling remote debugging to make the existing CDP sink work would reverse a deliberate Village security decision. AgentCookie itself states that any same-user process can control the authenticated browser while the loopback CDP endpoint is open. [AgentCookie threat model](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/docs/threat-model.md)

AgentCookie can make Keychain access more predictable, but it is not zero-ceremony. Reading source Chrome cookies requires access to `Chrome Safe Storage`. Its wizard can convert repeated GUI prompts into a one-time terminal entry of the macOS login password. [Keychain implementation](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/chrome/keychain.go#L18-L56)

## Security differences Village must enforce

- macOS AgentCookie defaults to an empty blocklist, which means sync all cookies. Village must use an explicit allowlist and initially accept only the exact LinkedIn hosts proven necessary. [policy implementation](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/config/allowlist.go#L69-L89)
- Paired long-term keys are currently JSON files protected by `0700`/`0600` permissions, not Keychain-backed non-exportable device credentials. Village should retain its device-bound identity and local vault boundary. [peer keystore](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/keystore/keystore.go#L1-L90)
- The plaintext sidecar is a bearer-session store unless optional sealing is enabled. Village should not create or consume it.
- Sync appears additive. No cookie-deletion tombstone was found. A source logout therefore cannot be treated as proven sink logout; Village needs explicit deletion and revocation semantics.
- Raw cookies must never enter the renderer, model context, cloud control plane, logs, diagnostics, or screenshots.

## LinkedIn-specific limits

No LinkedIn-specific test or implementation was found. The repository does not prove that a transferred LinkedIn session survives restart, cookie rotation, mobile verification, or a second-device risk challenge.

Cookie transfer cannot carry the original browser/device fingerprint, IP reputation, passkeys, or device-bound credentials. LinkedIn can request verification for unfamiliar devices or suspicious sign-in activity. [LinkedIn sign-in verification](https://www.linkedin.com/help/linkedin/answer/a1339220/security-verification-when-signing-in?lang=en)

LinkedIn also restricts third-party automation. Session portability and automated LinkedIn activity must remain separate product decisions. [LinkedIn automated activity policy](https://www.linkedin.com/help/linkedin/answer/a1341543), [User Agreement](https://www.linkedin.com/legal/user-agreement)

## Recommended spike

1. Keep PR #16 unchanged and merge it independently.
2. Extend the isolated destination spike into a Mac-to-Mac continuity experiment only after its residual security seams are implemented.
3. Use an explicit owner ceremony: “Make this LinkedIn session available on Mac X.”
4. Pair enrolled Village devices with revocable, device-bound credentials.
5. Export only an allowlisted cookie subset from an authorized local source.
6. Import through the exact destination Electron `Session` with `cookies.set()` and `flushStore()`; do not open CDP or rewrite SQLite.
7. Show source, destination, site, last sync, expiry, and a prominent Revoke/Delete action.
8. Test packaged builds for prompt count, signed-in state, restart survival, logout propagation, expiry, 2FA/challenges, host-only cookies, SameSite/HttpOnly, stale/replayed envelopes, and wrong-device rejection.

Go/no-go gate: a fresh second Mac opens Village's LinkedIn pane signed in after one explicit transfer ceremony, remains signed in after restart, produces no recurring Keychain prompts, and reliably loses access after owner revocation. Anything less remains an experiment, not a continuity promise.
