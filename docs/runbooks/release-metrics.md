# Alpha release metrics

Village does not infer release readiness from green unit tests alone. Before a
release build, an owner records bounded measurements from the exact source
commit and supported packaged macOS environment. The verifier accepts numbers
and closed enums only; do not add names, email addresses, URLs, page content,
account identifiers, credentials, cookies, screenshots, or free-form notes.

## Prepare evidence

1. Copy `docs/release/release-metrics.template.json` to the ignored path
   `release/evidence/release-metrics.json`.
2. Set `sourceCommit` to the output of `git rev-parse HEAD`, `appVersion` to the
   desktop package version, `recordedAt` to a current UTC ISO instant, and the
   architecture of the packaged test Mac. Run the release from that same
   architecture and a clean worktree; tracked or untracked source changes fail
   the gate because they are not covered by the recorded commit. Evidence must
   be no more than 24 hours old and may be at most 5 minutes ahead of the
   release Mac's clock.
3. Measure at least three fresh-owner setup ceremonies from first launch until
   the same local Site Session is retained after restart. Record milliseconds;
   the median must be below ten minutes.
4. Run takeover, reconnect, and restart recovery at least once each. Every
   attempt must converge to one controller and one terminal or waiting Job,
   with zero duplicate continuations. Record every convergence latency rather
   than applying an unrecorded average.
5. Record the number of seeded leakage-corpus cases and the prohibited-match
   count. Any match fails the release.
6. Record the configured control heartbeat, the explicit UI propagation
   budget, and measured offline and challenge attention latency. Each measured
   latency must be no greater than their sum.
7. Disconnect and replay the observer at least once. Each attempt must rebuild
   the same Job state, and the inspected replay payload must contain zero
   sensitive matches.

The fixture, recovery, observer, profile, credential, and clean-install
packaged verifiers provide the underlying proof runs. The evidence file is the
small release projection of those owner-inspected results; it is not permission
to weaken or skip any verifier.

## Verify and archive

Run the metrics gate directly:

```sh
VILLAGE_RELEASE_METRICS_PATH="$PWD/release/evidence/release-metrics.json" \
  pnpm release:metrics
```

Both release validation and release packaging invoke the same gate before
signing. Keep the environment variable set while running:

```sh
VILLAGE_RELEASE_METRICS_PATH="$PWD/release/evidence/release-metrics.json" \
  pnpm release:validate
```

The verifier rejects missing evidence, unknown fields, unsupported platforms,
stale or future-dated measurements, stale source commits or app versions,
insufficient samples, partial recovery, duplicate continuation, leakage,
attention latency beyond the declared bound, and replay disagreement. Archive
the accepted evidence beside the signed package, notarization, SBOM, update
manifest, and packaged-verifier output.
