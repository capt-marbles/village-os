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
