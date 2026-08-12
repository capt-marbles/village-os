# U0 human-run notes — 2026-08-12

This is a sanitized operator evidence log. It contains no credentials, codes,
cookies, tokens, screenshots, page content, or account identity.

## Run 1 — packaged Electron, no debugger

- Standard password route: reached
- Password entry: direct typing worked
- Native paste: unavailable because the spike's custom application menu had
  replaced Electron's standard Edit menu
- 2FA route: reached; classified `human-2fa`
- Authentication completion: not yet confirmed
- Challenge bypass attempts: 0
- Autonomous LinkedIn actions: 0
- LinkedIn debugger/CDP attachments: 0
- Credential or cookie logging events: 0

Corrective action: restore Electron's native `editMenu` so a user can paste into
the focused destination field without exposing clipboard content to Village.
Repackage and repeat the human route before recording authentication success.

## Run 2 — corrected packaged Electron, no debugger

- Native paste: restored
- Password plus mobile 2FA: completed by the human operator
- Authentication completion: confirmed by the human operator
- Normal restart 1 of 3: session retained
- macOS Keychain prompts during restart 1: 2; operator entered the local macOS
  password directly into the OS-owned prompts
- Policy exceptions: 0
- Challenge bypass attempts: 0
- Autonomous LinkedIn actions: 0
- LinkedIn debugger/CDP attachments: 0
- Credential or cookie logging events: 0

Keychain prompt recurrence remains under observation because repeated OS prompts
would be material setup friction even if session retention succeeds.

- Normal restart 2 of 3: session retained
- macOS Keychain prompts during restart 2: 1; operator chose `Always Allow` in
  the OS-owned prompt
- Normal restart 3 of 3: session retained
- macOS Keychain prompts during restart 3: 0
- Restart retention result: 100% (3 of 3)
- Keychain ceremony result: stabilized after the operator chose `Always Allow`

Packaged Electron result: password plus mobile 2FA and session persistence are
technically viable under the unchanged human-only policy. Normal Chrome baseline
evidence and product-owner approval remain pending.
