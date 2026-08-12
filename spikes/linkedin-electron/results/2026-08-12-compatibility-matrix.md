# LinkedIn / Electron compatibility matrix — 2026-08-12

Status: **PARTIAL — Normal Chrome baseline and approval pending**

## Machine-validated summary

Representative runs: 1
Minimum restart attempts per route/account: 3
Restart retention percent: 100
Normal Chrome challenge rate percent: pending
Packaged Electron challenge rate percent: 0
Normal Chrome failure rate percent: pending
Packaged Electron failure rate percent: 0
Policy exceptions: 0
LinkedIn debugger attachments: 0
Autonomous LinkedIn actions: 0
Credential or cookie logging events: 0
Packaged artifact verified: yes
Password plus 2FA human completion: yes
Federated redirects or popups: not encountered
Passkey route: not encountered
Environment: macOS 26.5.2 (25F84), arm64, Electron 43.4.0, same local network as the operator's normal browser
Local IP observation: packaged Electron used the operator's local network; comparative Chrome baseline pending
Terms-review status: unresolved; internal technical test only

## Electron observations

- Human password entry and mobile 2FA completed successfully.
- Native paste initially failed because the app menu omitted the standard Edit
  role; the role was restored and the corrected package succeeded.
- The first corrected restart showed two macOS Keychain prompts. The second
  showed one, where the operator chose `Always Allow`. The third showed none.
- The dedicated session persisted across all three normal restarts.
- No LinkedIn automation, debugger attachment, credential logging, cookie
  inspection, challenge bypass, or policy exception occurred.

## Normal Chrome comparison

Pending human baseline on the same representative account and network.

Conclusion: pending
Approved by: pending
Approval date: pending
