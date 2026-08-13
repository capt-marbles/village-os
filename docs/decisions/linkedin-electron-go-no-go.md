# LinkedIn / Electron U0 go/no-go decision

Decision: **GO — approved for continued internal implementation.**

Runtime decision: **Electron is the settled macOS-first v1 desktop runtime.**
Tauri is not an active v1 alternative. Village prioritizes one visible Chromium
session, persistent profiles, `WebContentsView` composition, and bounded CDP
control over binary size. Runtime-neutral control-plane and browser-host
contracts remain deliberate seams; revisiting the shell after v1 does not alter
the current implementation direction.

The numerical thresholds and blank comparison matrix are predeclared in `spikes/linkedin-electron/results/template.md`. A human operator must run the opt-in matrix without automation, credential/cookie logging, challenge bypass, terms acceptance on behalf of another person, or debugger/CDP attachment to LinkedIn.

Technical scope is an internal, model-free, disposable compatibility package. It does not validate delegated product value and must not be distributed.

Terms review is unresolved and requires a written review of then-current LinkedIn terms before any distribution. Technical success cannot change that status.

Technical conclusion: GO recommended for continued internal implementation. A
human password plus mobile-2FA sign-in succeeded, the session persisted across
three of three normal restarts, the final restart required no Keychain prompt,
and normal Chrome on the same representative account/network showed no challenge
or failure. The packaged Electron result was therefore no worse than Chrome in
the observed comparison.

This is not evidence that all LinkedIn accounts, routes, networks, or future
site changes are compatible. It does not authorize distribution or automated
LinkedIn activity.

Final conclusion: go

Approved by: Andrew Walker, product owner

Approval date: 2026-08-12

## Human-run procedure

1. From `spikes/linkedin-electron`, run `npm ci`, `npm test`, and `npm run package:dir`.
2. Verify `dist/mac-arm64/Village LinkedIn Compatibility Spike.app` with `codesign --verify --deep --strict` and launch that packaged app. Do not use `npm start` as matrix evidence.
3. Run the predeclared matrix with representative consenting alpha accounts and networks. Enter credentials only by direct human input. Stop for terms, consent, security warnings, unknown challenges, or any requested policy exception.
4. Quit the entire app normally and relaunch the same packaged artifact three times for each representative route/account. Record whether the dedicated profile retained the session; do not inspect or export cookies.
5. Run the owned fixture separately with `npm run fixture`, then launch the packaged app with `VILLAGE_OWNED_FIXTURE_URL=http://127.0.0.1:4173/auth` only to assess the planned CDP adapter. Never set that variable to LinkedIn or a non-loopback host.
6. Copy the completed template to a dated results file, choose `go`, `revise`, or `no-go`, add product-owner approval/date, and run `node scripts/run-matrix.mjs <dated-result.md>`. Only an approved, threshold-meeting `go` completes U0.
