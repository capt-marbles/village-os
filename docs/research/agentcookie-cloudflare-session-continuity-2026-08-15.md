# AgentCookie and Cloudflare Site Session continuity — 2026-08-15

## Decision

**Do not delay the Ritual-learning PR. Run a later, isolated Mac-to-Mac continuity spike, but implement it as a Village-native, end-to-end-encrypted mailbox—not by copying AgentCookie's Chrome SQLite/CDP path into Village.**

AgentCookie validates the user problem extremely well: an agent computer is much more useful when it wakes up already authenticated. Its author describes one-way, continuous session transfer from a person's Mac to an unattended agent machine, and the current `v1.0.0` README explicitly targets Grok Bot/cloud-agent VMs. The implementation combines a watched Chrome profile, domain filtering, X25519/HKDF pairing, AES-GCM envelopes, replay sequencing, and a destination cookie injector. [AgentCookie README at `v1.0.0`](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/README.md#L1-L62) · [pairing implementation](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/pairing/pairing.go#L1-L16) · [wire envelope](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/protocol/envelope.go#L1-L48)

The author's public launch thread frames the same substantive claim around OpenClaw/Hermes on a Mac mini: avoiding repeated logins by continuously transferring cookies and other auth material over a paired, encrypted Tailscale connection. I could verify the author's account and repo-backed claims, but the search-accessible copy of the recent Grok Bot-specific post did not expose a stable canonical X status URL; no claim below depends on an unverified quote. The repository's Grok Bot positioning is primary and pinned above. xAI's public product documentation confirms cross-device conversation/settings continuity and browser-based model login, but I found no first-party Grok Bot architecture page specifying its VM or cookie design. [xAI Grok overview](https://docs.x.ai/grok/overview) · [xAI Grok Build authentication](https://docs.x.ai/build/overview)

This is a **QOL feature, not a prerequisite for Ritual learning**. It changes the highest-risk boundary in Village and deserves its own threat model, packaged proof, and owner-facing consent flow.

## What is verified about AgentCookie

- `v1.0.0` is MIT-licensed and was inspected at commit `e498e93bcaac867386dfba12ea709882dff037ba`; `go test ./...` passed locally. Reuse is legally plausible if the copyright and permission notice accompany copied substantial portions. [license](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/LICENSE)
- The source reads ordinary Chromium-family profile databases and decrypts them through browser-specific macOS Safe Storage entries. Village instead owns a protected Electron `session.fromPath(...)` profile per principal/device/site. AgentCookie has no Village/Electron adapter. [browser adapters](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/chrome/browser.go) · [Village local browser host](../../apps/desktop/src/browser/local-browser-host.ts)
- Its macOS cold sink upserts Chrome SQLite and deliberately pins older metadata behavior; its live sink uses a remote-debugging/CDP endpoint. Neither is a good fit for Village, which disables production debugging and deliberately does not attach CDP to LinkedIn. [SQLite writer](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/chrome/write.go#L18-L98) · [CDP injection](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/livecdp/inject.go) · [Village browser boundary](../architecture/browser-trust-boundary.md)
- On macOS, missing/empty policy is effectively **sync-all/blocklist-empty**; on Linux it is **allowlist-empty/ship nothing**. Village should use neither platform default: every transfer must be bound to one explicitly selected Site Session and an immutable destination-domain allowlist. [policy implementation](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/config/allowlist.go)
- AgentCookie carries complete cookie snapshots and can additionally carry the entire Local Storage directory and optional IndexedDB tarballs. Those storage archives are not filtered by the cookie-domain allowlist. Its cookie write/injection paths are additive and the envelope has no cookie-deletion tombstones, so source logout/deletion is not exact destination revocation. [source packing](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/cli/source.go#L235-L389) · [directory packer](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/chromedirsync/chromedirsync.go) · [full-set envelope](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/protocol/envelope.go#L1-L12)
- Its source must gain access to Chrome Safe Storage. The signed-binary/partition-list setup can reduce steady-state prompts, but still needs one password-mediated onboarding action and modifies Chrome's Keychain access policy. Village can avoid this entire decryption path by exporting only from its own live Electron `Session` through `cookies.get()` and importing through `cookies.set()` plus `flushStore()`. [AgentCookie Keychain path](https://github.com/mvanhorn/agentcookie/blob/e498e93bcaac867386dfba12ea709882dff037ba/internal/chrome/keychain.go#L18-L56) · [Electron Cookies API](https://www.electronjs.org/docs/latest/api/cookies) · [Electron Session API](https://www.electronjs.org/docs/latest/api/session)
- There is no LinkedIn-specific proof in AgentCookie. A transferred bearer cookie may work, expire, be challenged, or be insufficient because of other storage/device signals. LinkedIn's current agreement explicitly mentions copying cookies in its account-misuse prohibition and separately restricts automated scraping/copying; Village's existing written-terms-review gate remains in force. [LinkedIn User Agreement section 8.2](https://www.linkedin.com/legal/user-agreement#dos)

## Proposed Cloudflare architecture

```text
Source Village on Mac A                         Destination Village on Mac B
-----------------------                         ----------------------------
Electron Session.cookies.get()                  fetch encrypted revision
  -> exact Site Session allowlist               verify source signature
  -> authoritative revision + tombstones       decrypt locally
  -> encrypt to Mac B public key                validate exact site scope
  -> sign envelope                              Session.cookies.set/remove()
            |                                             |
            +---- HTTPS ---- Cloudflare Worker -----------+
                              |
                       per-pair Durable Object
                    ciphertext + seq + ack + expiry
                    (no cookie values or E2EE keys)
```

### Device and cryptographic boundary

Each packaged Village install creates a non-exported Ed25519 signing key and X25519 recipient key in the macOS-protected local vault. Pairing is owner-visible and out-of-band (QR/short-code plus public-key fingerprint). The source creates a fresh content key per revision, encrypts the canonical Site Session payload with an audited AEAD construction, wraps that key to each approved destination public key, and signs the complete envelope. Associated data binds opaque pair/session IDs, source/destination key IDs, revision, previous digest, creation time, and expiry.

Cloudflare stores only ciphertext, public keys, signatures, opaque IDs, counters, digests, timestamps, and acknowledgements. A Worker or Cloudflare operator can observe timing, sizes, IPs, and account metadata; it can drop, delay, duplicate, or serve stale ciphertext. It cannot decrypt cookies or forge a newer valid revision without a device private key. Clients reject expired, wrong-recipient, wrong-site, invalid-signature, lower-sequence, broken-chain, and already-applied revisions.

This is an inference/design recommendation, not behavior present in AgentCookie or Village today. Use a standard reviewed library/protocol rather than inventing primitives.

### Durable Object as the source of truth

Use one SQLite-backed Durable Object per pairing or principal-device pair. A Durable Object gives a globally addressable coordinator with strongly consistent transactional storage—well suited to enforcing one monotonic revision, current device membership, pending destination acknowledgements, and revocation. Store the latest encrypted revision and a short bounded predecessor window, not an indefinite log. [Durable Object model](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) · [storage guidance](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

Protocol:

1. `PUT revision`: authenticate device, verify signature and exact next sequence, transactionally persist ciphertext/digest/expiry and pending acknowledgements; idempotently return the existing result for the same revision+digest.
2. `GET after=<sequence>` or hibernatable WebSocket wake: return the current encrypted revision. Polling/reconnect is safe because delivery is at least once at the application level.
3. Destination verifies/decrypts, computes an exact managed-cookie diff, applies it inside the selected Electron Session, calls `flushStore()`, and sends a signed acknowledgement.
4. The object records acknowledgements transactionally. An alarm removes superseded ciphertext after all intended devices acknowledge or after a short maximum TTL. Alarm handlers must be idempotent because Cloudflare notes they may run more than once. [Durable Object alarm guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
5. `REVOKE device`: immediately denies future fetch/upload and excludes that key from future envelopes. It cannot claw back plaintext already decrypted on that Mac or invalidate the website's server-side session; the UI must separately offer “forget on that Mac” and recommend/perform owner-controlled site logout where appropriate.

An authoritative payload must include the complete set of Village-managed cookies for that exact site plus explicit deletion semantics. Otherwise a deleted/logout cookie can survive on Mac B. Do not sync Local Storage, IndexedDB, passwords, passkeys, or arbitrary profile files in the first spike.

### Cloudflare component choices

| Component                            | Use                                                                      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durable Objects**                  | Strongly consistent revision/ack/device state and small ciphertext blobs | **Primary choice.** The 2 MiB per key/value limit is ample for one site's cookies; use opaque object names. Cloudflare-managed encryption at rest is not E2EE, so retain client ciphertext. [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [data security](https://developers.cloudflare.com/durable-objects/reference/data-security/)                                                                                                                       |
| **R2**                               | Large encrypted artifacts                                                | **Not for v1 cookie payloads.** It is durable and strongly consistent, but still needs a coordinator for sequence/ack/revocation. Lifecycle deletion is asynchronous and typically occurs within 24 hours. Add only if future encrypted profile artifacts exceed DO value limits, with the DO holding their digests and state. [R2 architecture](https://developers.cloudflare.com/r2/how-r2-works/) · [lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) |
| **Queues**                           | Wake/cleanup fan-out                                                     | **Optional notification only, not truth.** Queues are at-least-once, may duplicate, and do not preserve order; Free retention is 24 hours and Paid defaults to four days/configures up to 14. The destination must always reconcile against the DO sequence. [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) · [retention/pricing](https://developers.cloudflare.com/queues/platform/pricing/)                                                |
| **Workers Secrets**                  | Deployment-wide server credentials                                       | **Never store per-user cookie keys or plaintext cookies.** Worker code can read these bindings. Use only for operational service credentials that do not defeat E2EE. [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)                                                                                                                                                                                                                                    |
| **Cloudflare Access service tokens** | Protect admin or a private self-hosted deployment                        | **Defense-in-depth, not device identity.** They are static client-ID/secret bearer credentials with separate renewal/revocation and would add another secret to every Mac. Device request signatures remain the product identity layer. [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)                                                                                                                               |
| **Client mTLS**                      | Edge rejection of unknown device certificates                            | **Later hardening option.** It provides strong transport identity but per-device certificate issuance, renewal, recovery, and revocation substantially increase onboarding complexity. It still does not replace application signatures/E2EE. [Cloudflare client certificates](https://developers.cloudflare.com/ssl/client-certificates/)                                                                                                                                                   |
| **Service Bindings**                 | Split public API, authorization, and DO router Workers                   | **Useful internal hygiene, not client security.** They keep internal Workers off public URLs and add no service-binding cost, but do not authenticate a Mac. [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)                                                                                                                                                                                                                           |

### Retention and deletion honesty

Use a short configurable payload TTL (proposed spike default: 24 hours) and delete acknowledged superseded revisions immediately. Delete the DO alarm and call `deleteAll()` when a pairing is destroyed; Cloudflare documents that deleting individual keys is not enough to remove the object and its remaining metadata. SQLite-backed DO point-in-time recovery can restore prior state within a 30-day window, so Village must say “removed from active service” rather than promise immediate physical disappearance from backups. The retained data is ciphertext, but it remains sensitive. [DO deletion and PITR](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)

## Threat model and non-goals

| Threat                                 | Control                                                                                  | Residual limitation                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Cloudflare/storage compromise          | Recipient-only AEAD; device signatures; no server decryption key                         | Metadata/traffic analysis and denial of service remain possible                                   |
| Replay/reorder/duplicate               | Monotonic sequence, previous digest, expiry, DO transaction, destination idempotency     | A compromised source can publish a malicious newer snapshot                                       |
| Unauthorized domain injection          | Exact Site Session contract and independent destination allowlist/schema validation      | Site cookie names and requirements change over time                                               |
| Lost/stolen destination Mac            | Keychain-backed device keys, local app lock, remote membership revocation                | Already-decrypted cookies remain usable until local deletion/site invalidation                    |
| Cloud account takeover                 | E2EE prevents plaintext disclosure; signatures prevent forged device revisions           | Attacker can delete/withhold ciphertext or change public metadata; key-change UX must detect this |
| Malicious local same-user process      | No CDP/debug port; keys stay in packaged app vault; scoped profile permissions           | macOS same-user compromise is still a trusted-host failure                                        |
| Destination offline/crash during apply | Persist “received/applied/acked” journal; idempotent revision; `flushStore()` before ack | Some sites may reject the copied session despite correct cookie transfer                          |

Never describe continuity as backup of the account, guaranteed login, challenge bypass, or permission to automate a site's actions. For LinkedIn, portability and automation remain separate decisions.

## Reliability, UX, and cost

The owner experience should be: **Connect another Mac → verify both device names/fingerprint → choose one Site Session → review “this grants the other Mac your current signed-in authority” → enable → see last delivered/applied status → pause/revoke/forget.** Default is off, one site, one destination, one-way. No cookie values, domains beyond the approved adapter, or profile archives appear in chat, diagnostics, model context, logs, or Cloudflare.

For a small personal deployment, event-driven upload plus reconnect fetch should fit within Cloudflare's Free DO allowances (100,000 requests/day, 5 GB total SQLite storage). Workers Paid includes one million DO requests/month and has a $5/month minimum before overages; actual spend should be measured in the spike, not promised. Avoid frequent polling and permanently active WebSockets; use hibernation/reconnect or low-rate conditional fetch. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

Compared with AgentCookie/Tailscale, Cloudflare removes the requirement that both Macs share a tailnet and naturally buffers while Mac B is offline. It adds a public service, account/device lifecycle, abuse controls, deployment operations, privacy disclosures, and an application cryptography burden. TCO is likely low in dollars for one user but materially higher in engineering/security complexity.

## Staged spike and go/no-go

### Stage 0 — owned fixture, local relay emulator (2–3 days)

Define the versioned, site-scoped snapshot/tombstone contract; export/import only through Electron `Session.cookies`; prove no CDP, SQLite read/write, Local Storage, Keychain-password prompt, renderer exposure, or model exposure. Prove login, logout deletion, duplicate delivery, stale revision, corrupted ciphertext, and crash-before-ack against the owned auth fixture.

### Stage 1 — Cloudflare ciphertext mailbox (3–5 days)

Deploy one Worker + SQLite DO; implement device pairing, signatures, recipient encryption, transactional sequence/ack, 24-hour alarm cleanup, revoke, `deleteAll()`, bounded diagnostics, and usage metering. Simulate offline Mac B, reordered/replayed calls, duplicate upload/apply/ack, expired payload, source key rotation, and Cloudflare unavailability.

### Stage 2 — packaged two-Mac proof (3–5 days)

Run signed/notarized packaged builds when Apple credentials are available. Measure end-to-end transfer latency, restart persistence, prompt count, source logout propagation, destination forget, device revoke, recovery after sleep/network loss, and active-service deletion. Only then run an owner-operated, human-visible LinkedIn compatibility check after refreshing the written terms review; do not attach CDP or automate LinkedIn activity.

**Go** only if:

- Cloudflare logs/storage contain zero plaintext cookies, content keys, passwords, or Site Session payloads under adversarial instrumentation.
- A destination cannot decrypt another destination's envelope, and a revoked device cannot fetch new ciphertext.
- Exactly one current revision is applied; duplicates/replays/stale/forked revisions are harmless and observable.
- Logout/removal on Mac A removes the Village-managed cookie on Mac B within the declared SLA, including an offline/reconnect case.
- Crash recovery never acknowledges before `flushStore()` and never widens the approved site/domain scope.
- Pair deletion clears active DO storage/alarm, and UI copy accurately states backup/PITR and already-delivered-data limitations.
- Packaged two-Mac runs add no recurring Keychain prompts beyond Village's established packaged baseline.
- The owned fixture passes 20 consecutive transfers/reconnects; any LinkedIn test is separately owner-approved and no worse than the established local-browser challenge baseline.

**No-go** if any plaintext reaches Cloudflare, exact cookie deletion cannot be represented, domain scope can widen, replay/fork handling is ambiguous, pairing can silently replace a device key, packaged prompt behavior regresses, or reliable LinkedIn use requires CDP/debugging, challenge bypass, wholesale profile copying, or automation outside Village's written policy.

## Recommendation

Merge the current Ritual PR independently. Preserve AgentCookie attribution if Village copies code, but prefer a Village-owned TypeScript implementation of the narrow concepts—pairing, signed encrypted envelopes, monotonic revisions, and acknowledgements—around Electron's native Session API. Start with the owned fixture and one site-scoped cookie payload. Do not ship R2, Queues, Access, mTLS, Local Storage, multi-device fan-out, or LinkedIn automation in the first slice.
