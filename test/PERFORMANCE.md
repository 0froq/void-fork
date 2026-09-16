# Test-suite performance audit

September 16, 2026. Baseline: [`a6dad2ae`](https://github.com/voidzero-dev/void/commit/a6dad2ae37e8adbfd47ed0874a1c0d187a071bf2).

## Scope and method

The audit covered the complete collected Vitest suite, its fixtures and subprocess lifecycle,
the Node-based CI scripts, package-consumer acceptance tests, and Actions job dependencies.
An AST comparison ignored formatting/comments and found 61 groups of identical test bodies.
Each candidate was checked against its imports, fixture state, inputs, and execution mode.
Matching bodies against different frameworks or databases were retained as separate executions.

The baseline collected 468 files and 9,667 cases: 9,656 passed and 11 opt-in cases skipped locally.

| Project                  | Files | Cases | Purpose                                                                            |
| ------------------------ | ----: | ----: | ---------------------------------------------------------------------------------- |
| SDK unit                 |   275 | 5,252 | Runtime, code generation, deployment and provisioning contracts                    |
| SDK integration          |    43 |   495 | Real builds, dev/preview servers, browsers, meta-frameworks and gated live deploys |
| Platform unit            |   100 | 2,413 | Workers, dispatch, proxy, build orchestration and installation contracts           |
| Platform API integration |    50 | 1,507 | Real database state, HTTP, authorization, migrations and lifecycle operations      |

Local measurements used Node 24.21.0 on a 12-core Apple M4 Pro, with the same workspace and
command: `vp env exec --node 24.21.0 vp run test:all`. They include formatting, lint, all builds,
typechecks and tests. The color-environment fixture repair described below was applied before
both baseline measurements. Failed experimental runs are excluded from the comparison.

## Local results

| Full verification  |  Run 1 |  Run 2 |   Mean |
| ------------------ | -----: | -----: | -----: |
| Baseline           | 104.5s | 100.7s | 102.6s |
| After core changes | 100.9s | 101.8s | 101.3s |

The observed local total is essentially unchanged: about 1.2% lower, within ordinary run-to-run
variation. The changes should not be presented as a substantial local end-to-end speedup.
There are measurable component improvements, while compilation/browser work remains dominant:

- The in-memory project-deletion suite no longer spends about 30 seconds in fifteen fixed
  two-second orphan-sweep waits. Both sweeps and all 20 cases still execute. The focused suite
  completed in 1.43 seconds, including imports and setup.
- A standalone server-shutdown probe exited in 0.35 seconds instead of 5.16 seconds after clearing
  the unused deadline timer. The timeout and force-kill fallback are preserved.
- The Astro fixture eagerly optimizes two first-request server imports, avoiding serial worker
  reloads during readiness. Its existing startup timeout is retained.

## CI baseline and changes

The [green baseline CI run](https://github.com/voidzero-dev/void/actions/runs/35068441364)
was dominated by the Windows 1/2 job:

| Job                     | Total |      Full build | Typecheck | Tests |
| ----------------------- | ----: | --------------: | --------: | ----: |
| Windows integration 1/2 |  666s |            192s |       37s |  304s |
| Windows integration 2/2 |  401s |            117s |         — |  119s |
| Windows unit            |  285s |       9s (core) |         — |  133s |
| Linux integration 1/2   |  109s |             29s |  under 6s |   54s |
| Linux integration 2/2   |   88s |             26s |         — |   41s |
| Linux unit              |   72s | under 6s (core) |         — |   47s |

Two sources of avoidable CI work were identified:

1. Both integration runners built every playground before their selected tests, and many tests
   then rebuilt their own fixtures. A dedicated required build/typecheck job now owns the full
   workspace gate once per OS. Integration runners build the public packages, then their tests
   build only the fixtures they exercise. This adds one parallel job per OS; generated output is
   never transferred between runners.
2. Filename-hash sharding put substantially more work in shard 1/2. The
   [integration estimates](integration-timings.ts) now drive deterministic longest-first packing
   and ordering for sharded runs. The recorded workload is split into approximately 400.4 and
   399.6 worker-seconds. These are scheduling estimates, not promised wall-clock durations.

Membership validation through actual Vitest collection confirms that the two shards cover all
43 discovered integration files exactly once. Tests cover new-file fallback, checkout/path
normalization, discovery order, invalid counts and seeded shuffle. Non-integration sharding
continues to use Vitest's default behavior. The sequencer loads Vitest's Node API lazily so normal
build commands do not import that runtime just to read the configuration.

## Deduplication and coverage

- Fifteen exact duplicate cases were removed after checking that they used the same fixture,
  input, function and assertions. These were repeated positive deployment/schema checks,
  routing checks, and identical authenticated build/proxy requests. Distinct failure cases remain.
- Sixty-nine form cases across four files exercised test-local copies of hook implementations.
  They were replaced with sixteen direct checks of the production form-value equality function.
  Real adapter forms remain covered by the browser matrix.
- Thirteen common client cases and five island cases now have shared definitions. All 210
  adapter integration cases still execute against React, Vue, Svelte and Solid, in dev and preview.
  Framework-specific hydration, HMR, reactivity and event-handler behavior stays in its adapter file.
- The two independent canonical-JSON implementations use one shared contract definition and
  are still both executed.
- A duplicate prerender fixture was corrected: the missing-token case now supplies a project
  ID, distinguishing it from the existing case where both credentials are absent.
- Browser-created records have unique names, so a submission cannot pass by finding a record
  inserted by an earlier HTTP-level test. The hydration contract avoids re-reading markers that
  the readiness helper has already checked atomically.

Before the final fresh-record guard, full validation collected 467 files and 9,612 cases:
9,601 passed and the same 11 opt-in cases skipped. The lower case count reflects the removal
of duplicated/model-only cases, with new direct-function and scheduling/lifecycle checks added.

## Reliability and developer workflow

- HMR playground source snapshots prevent a concurrently cloned fixture from capturing another
  test's temporary source edits. The snapshots include current working-tree source, use installed
  workspace dependencies, and are removed after the run.
- Startup output is drained and retained in bounded diagnostics. This avoids pipe backpressure
  and makes failures distinguishable from an exited or still-compiling server.
- The CLI/API subprocess fixture clears inherited `FORCE_COLOR` before setting `NO_COLOR`.
  Otherwise `vp run test:all` could inject a Node warning into a JSON error response.
- Stale test shortcuts were repaired to select existing projects and file groups.
- Full verification builds the dashboard before running its type-aware lint.

The local project phase barrier was retained after unrestricted startup scheduling failed to
improve total time and exposed readiness problems. Module isolation, Windows browser concurrency
limits, live-test credential gates, production cleanup delays, and real subprocess/lock timing
tests remain enabled. No retries or longer global timeouts were added.

## Validation

- Two successful baseline and two successful post-change full local verification runs.
- All 43 integration files passed in a disposable checkout without generated playground output,
  after building only the public packages: 486 passed, 9 opt-in cases skipped.
- All 210 adapter browser cases passed after centralization and again with unique mutation data.
- Direct sequencing/setup typechecks, repository typechecks, formatting and lint checks passed.
- Real-process regression coverage confirms that shutdown leaves no referenced deadline timer.

Packed npm/pnpm acceptance, dev versus preview execution, Linux/Windows execution, database
integration and live deployment exercise different boundaries. Their matching scenarios were
retained. Existing PGlite schema-template reuse was also retained; sharing mutable databases
across files or disabling module isolation would change the suite's guarantees.
