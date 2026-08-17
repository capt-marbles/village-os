# Browser trust boundary

Village's macOS alpha keeps the interactive browser and its site state on the owner's Mac. The control plane coordinates durable Jobs; it is not a remote browser and cannot receive the local browser profile.

## Process boundary

The Electron main process owns the `BaseWindow`, the locally bundled application `WebContentsView`, the isolated remote-content `WebContentsView`, profile selection, control transfer, secret mediation, and destructive lifecycle. The application renderer has a narrow typed preload. Remote content has no Node integration, Village IPC, arbitrary navigation authority, or access to the application view.

The LinkedIn Browser Session is human-driven. Village may open the approved sign-in page, visibly transfer control, and classify state conservatively. It does not attach CDP to that partition or automate credentials, CAPTCHA, 2FA, federated identity, passkeys, scraping, messaging, posting, reactions, or connections. External distribution remains blocked pending written terms review.

The owned fixture is the only site where the alpha exercises model-requested browser actions. Commands use a closed semantic grammar. Selectors, arbitrary URLs, JavaScript, raw CDP identifiers, page-authored authority, and renderer-granted approval are outside the contract.

## Data boundary

| Data                                                                   | Authority           | Permitted movement                                                      |
| ---------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| Site profile, cookies, credentials, model-provider credentials         | Local desktop       | Never sent to the renderer, model, or control plane                     |
| Live page pixels, DOM, accessibility text, form values, URL query/hash | Local desktop       | Never serialized across the host boundary                               |
| Observation                                                            | Local policy code   | Only closed, bounded facts and predicate identifiers may leave the host |
| Job event, checkpoint, receipt                                         | Session coordinator | Principal-scoped sanitized records only                                 |
| Diagnostic preview                                                     | Local desktop       | Three primitive fields: component, code, retriable; upload disabled     |

Browser-derived input is hostile even after it becomes a bounded Observation. It cannot approve a secret, widen an origin, alter policy, mint owner authorization, or select an arbitrary destination. Sensitive operations use short-lived, one-use authorization created and consumed by main-process code.

## Alpha limits

- macOS is the only declared alpha platform. Unsupported platforms fail profile-protection checks.
- File permissions and Chromium OS cryptography are part of the posture; backup and indexing exclusion must be verified on the packaged target before release and are not claimed merely from source tests.
- Local diagnostics have no upload transport. Village does not start Electron's native crash collector or ship an alpha support-bundle uploader. The packaged forced-crash proof redirects any native crash artifacts into its disposable, recursively scanned profile boundary. Support may ask the owner to read or copy the bounded preview explicitly.
- The update policy validator is fail-closed, but runtime download/install wiring and a provisioned update service still require packaged release evidence.
- No release is represented as signed or notarized until Apple credentials, certificate identity, notarization output, package signature, fuses, and update metadata are verified on the produced artifacts.
