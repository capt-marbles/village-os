# LinkedIn / Electron compatibility matrix

Status: **UNRUN — human execution required**

## Predeclared thresholds

- GO requires 100% dedicated-profile restart retention across at least 3 normal app restarts per representative route/account.
- GO requires 0 policy exceptions, 0 debugger/CDP attachments to LinkedIn, 0 autonomous LinkedIn actions, and 0 credential/cookie logging.
- GO requires packaged Electron challenge incidence and failure rate to be no more than 10 percentage points worse than Normal Chrome on the same representative accounts and networks.
- GO requires password plus 2FA to complete by human input and every encountered federated redirect or popup and passkey route to be either human-operable under the unchanged deny policy or visibly classified unsupported.
- Any threshold miss means REVISE or NO-GO; do not begin U1-U8 without an explicitly approved architecture revision.

## Environment

Record date, macOS version, hardware architecture, Electron version, package artifact/hash/signature, network class, and anonymized account label. Do not record credentials, cookies, tokens, or page content.

## Machine-validated summary

Replace every `pending` value with measured evidence. Rates and counts are bare numbers without `%` symbols.

Representative runs: pending
Minimum restart attempts per route/account: pending
Restart retention percent: pending
Normal Chrome challenge rate percent: pending
Packaged Electron challenge rate percent: pending
Normal Chrome failure rate percent: pending
Packaged Electron failure rate percent: pending
Policy exceptions: pending
LinkedIn debugger attachments: pending
Autonomous LinkedIn actions: pending
Credential or cookie logging events: pending
Packaged artifact verified: pending
Password plus 2FA human completion: pending
Federated redirects or popups: pending
Passkey route: pending
Environment: pending
Local IP observation: pending
Terms-review status: unresolved; internal technical test only

## Manual comparison

| Anonymized run | Normal Chrome | Packaged Electron (no debugger) | Owned fixture CDP (never LinkedIn) | password plus 2FA | federated redirects or popups | passkey | challenge incidence | failure rate | deny-policy compatibility | restart retention | local-IP observation | Notes (no secrets) |
|---|---|---|---|---|---|---|---:|---:|---|---|---|---|
| pending | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending | pending |

## Auth-route classification

Record each encountered route as `standard`, `human-challenge`, `human-2fa`, `human-password-reset`, `human-terms-or-consent`, `unsupported-federated`, `unsupported-passkey`, or `unknown`. Stop on terms, consent, security warnings, unknown challenges, or requests for policy exceptions.

## Terms-review status

Unresolved. Current LinkedIn restrictions require written product-owner/counsel review before any distribution. A technical GO does not authorize distribution or automated activity.

Conclusion: pending

Approved by: pending

Approval date: pending
