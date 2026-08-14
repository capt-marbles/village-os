# Delegated fixture workflow proof

This runbook verifies Village's internal-only delegated setup surface. It does not enable fixture code in the release application and it never runs the genuine ChatGPT proof in CI.

## Deterministic CI evidence

Use Node 24.15 and pnpm 10.33:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @village/test-auth-site build
pnpm --filter @village/desktop package:mac:e2e
pnpm verify:delegated-workflow
pnpm verify:delegated-workflow:recovery
pnpm verify:delegated-workflow:abrupt-recovery
```

The final command launches the packaged internal application, clicks the visible `Start demo setup` control in the immutable local renderer, drives the dedicated fixture `WebContentsView`, and requires:

- the four logical steps to reach a durably receipted terminal state;
- exactly one local finalization effect;
- the fixture browser surface to be the active `https://fixture.village.test/setup` view;
- valid packaged fuses and an ad-hoc macOS signature.

The recovery command launches two separate packaged desktop processes against
one private profile. The first deliberately stops after the non-idempotent
finalization effect but before its receipt is accepted. It must persist
`RECONCILIATION_REQUIRED` with one finalization. The second must reconcile that
same effect to `RECEIPTED_SUCCESS` without applying finalization again. This is
the packaged cross-process recovery gate; the in-process interruption tests do
not substitute for it.

The abrupt-recovery command covers the narrower crash window before effect
observation is journaled. Its first packaged process exits intentionally with
code 86 after the fixture confirms finalization; the local journal must still
end at `DISPATCHED`. A second packaged process then reconciles from the live
fixture predicate and the persisted outstanding action. Success requires one
finalization and a terminal `RECEIPTED_SUCCESS` checkpoint.

The normal test suite separately injects takeover/hand-back, cancellation, desktop/provider recreation, coordinator eviction semantics, lost receipt, observer replay, Human Gates, hostile page text, and forged LinkedIn destinations. Passing those tests is deterministic integration evidence; it is not the genuine model milestone.

## Genuine ChatGPT packaged gate

Run only on the owner's Mac with an existing managed ChatGPT account session:

```sh
pnpm --filter @village/test-auth-site build
pnpm --filter @village/desktop package:mac:e2e
node scripts/verify-delegated-workflow.mjs --genuine
```

The result must report `CHATGPT_ACCOUNT`, `RECEIPTED_SUCCESS`, one finalization effect, and a visible fixture surface. Authentication failure, timeout, a Human Gate, or a second finalization blocks the milestone.

This command is intentionally absent from pull-request, label, fork, and repository-secret-triggered CI.

## Fresh-owner acceptance journey

Launch the same internal package without a report argument:

```sh
open apps/desktop/dist/mac-arm64/Village.app
```

The owner should be able to:

1. Recognize `Ready for delegated setup` and start without developer tools.
2. See the dedicated Village demo setup browser, current logical step, controller, action phase, last actor, and durable timestamp.
3. Take control, edit the local fields, and return control explicitly.
4. See a valid owner edit attributed to `OWNER`, followed by a fresh automation lease.
5. Supervise from the separate web observer and cancel future automation.
6. Distinguish terminal success from an owner-only Human Gate.

Record the exact package commit, macOS version, whether Keychain prompted, and the observed terminal state. Repeated Keychain prompts on ad-hoc rebuilds are a known packaging limitation; the release UX gate requires a stable Developer ID–signed build. Do not disable cookie encryption to hide the prompts.

## Evidence boundary

- `pnpm check` and the deterministic packaged run are reproducible CI evidence.
- `--genuine` proves bounded ChatGPT selection against the packaged internal modules.
- The fresh-owner journey proves legibility and control transfer.
- None of these alone substitutes for the other two.
