# LinkedIn sign-in compatibility smoke

This is an opt-in, human-driven compatibility check for an internal Village
alpha. It does not authorize automated LinkedIn activity or external
distribution. Complete a written review of the then-current LinkedIn terms
before distributing the integration.

## Safety boundary

- Use the packaged macOS app and its dedicated Village browser profile.
- Confirm the LinkedIn view has no debugger/CDP attachment. Village must not
  attach one at any point in this smoke.
- All credential, passkey, CAPTCHA, 2FA, consent, security-warning, federated
  identity, and account-selection steps are completed by the owner in the
  visible browser.
- Do not script credentials, repeat login attempts, bypass challenges, scrape,
  message, post, react, connect, or perform any other post-login action.
- Cancel stops future automation but preserves the site session. Forget session
  is a separate destructive lifecycle and requires step-up authorization; that
  lifecycle is completed in U8.

## Preconditions

1. Use a test account you are authorized to access and a normal user network.
2. Record the Village build/commit, macOS version, Electron version, sign-in
   route (password plus 2FA, federated redirect/popup, or passkey), and start
   time. Do not record credentials, codes, cookies, page text, URLs containing
   query/fragment data, or screenshots.
   Federated redirects and popups are classified but blocked as unsupported in
   this alpha until a state-bound redirect policy is implemented.
3. Start with the packaged application closed. If testing a retained session,
   preserve the existing dedicated Village profile.

## Procedure

1. Launch the packaged Village application and open the LinkedIn sign-in Job.
2. Verify the side pane opens `https://www.linkedin.com/login` visibly and
   immediately request owner takeover.
3. Wait until Village acknowledges owner control. If it cannot quiesce, stop and
   record `unknown`; do not continue under uncertain control.
4. Complete sign-in manually. Treat every challenge or identity-provider route
   as owner-only. If the route is unsupported, stop and record `unknown` with
   the route class only.
5. Return control. Village must reconcile before creating a fresh agent lease.
6. Run the local route predicate without debugger attachment:
   - current signed-in route accepted by the owner: `confirmed_by_user`;
   - sign-in route: `not_authenticated`;
   - challenge, stale, unexpected-account, or unknown route: `unknown`.
7. Close the app normally, relaunch it, reopen the same Browser Session, and
   repeat step 6. Do not perform a post-login action merely to test retention.
8. Cancel the Job and verify the retained site session is still present. In a
   separate destructive-lifecycle check, choose forget-session, complete the
   system-owned macOS authorization prompt, confirm deletion, and verify that
   only the scoped Village profile is absent after restart.

## Pass criteria

- The restart result is `confirmed_by_user` under the current route-only
  predicate. Automatic `authenticated` evidence remains disabled until a
  stronger local predicate is implemented.
- No autonomous site input or post-login activity occurred.
- No debugger/CDP attachment occurred for LinkedIn.
- Only the predicate version and safe verification outcome are retained or
  projected; no credentials, account data, raw page content, screenshot, query,
  fragment, cookie, or token appears in records or diagnostics.

Any challenge bypass, repeated automated login, CDP attachment, credential
leakage, misleading automatic-authentication claim, or session loss is a fail.
