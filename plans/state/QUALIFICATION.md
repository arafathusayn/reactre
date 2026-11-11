# @reactre/state: qualification record

## Current frozen-tree target (2026-11-11 13:16 +06)

All four hc workers have stopped their bounded edits and are idle. This record supersedes intermediate
sizes and test totals in the dated checkpoints of `NEXT.md`. It is not a release-readiness claim.

### Independently observed

- Root `bun check`: 0 errors in 675 files, after the erased React production fixture was given its
  exact source `DoorMachine` type. Root `bun check -p tsconfig.strict.json`: 0 errors in 248 files.
  Package source config also measured 0 errors in 138 files before the installed-job fixture; root
  checks cover that fixture too.
- Full root `bun test --coverage`, log `/private/tmp/reactre-state-root-coverage-20261111.log`:
  **4049 pass / 3 fail, 4052 tests across 170 files**. Failures were job 1119 > 1060, persist
  3319 > 3275, and `packages/core/test/solid/effects.test.ts`'s `createTrackedEffect` warning
  assertion (5 unexpected calls). That core assertion passes alone and as its whole file (52 pass,
  0 fail), but this is not resolved or attributed to state: it is a root suite-order/isolation
  failure. Three unchanged-plugin class-stack failures were reproduced separately three times
  before this root run; they did not reproduce in the root run. No assertion weakened.
- The checked-in `coverage/lcov.info` predates the final new tests, but inspection after an optional
  coverage run found zero `DA:<line>,0` and zero zero-hit functions. The actual plain root command
  above passed its 100% function/line threshold. Repeat from the clean qualification tree, with
  lcov explicitly generated there, before calling coverage final.
- Persistent compaction landed by `t1w`: array-based migration steps, compact same-string kind
  diagnostics, shorter S11/S20/S21 remediation text retaining the path and fix, and fold of `kind`
  into `json`, which reuses the object prototype already looked up. It reached **3304 > 3275**.
  Its exact S20 paths / unknown values / class labels / shape validation must remain intact.
- Durable landed equivalent node-diff work and shorter diagnostic wording. **2862 <= 2865**, and with
  children **6037 <= 6095**. Seven durable files: **49 pass / 0 fail**, including installed-subprocess
  crash/resume and child replay. A later combined sizes command measured standalone 2856. Either is
  inside the unchanged budget; use the final full size suite as the frozen-tree record.
- `t1t` rejected the proposed lean-task guard removal with a direct stale-result probe: removing it
  applies the old result after a new state is entered when that state handles its type. No shared
  `src/index.ts` or `src/tasks.ts` reduction landed. Equivalent source reshapes measured only 2–3
  gzipped bytes and were not justified. Job remains **1119 > 1060**. No budget or fixture workaround.
- React production regression: same app compiled dev and prod, production React, real emitted code
  executed. Production has none of M313–M316, `console.warn`, `isFrozen`, S29 round/dead-child text;
  dev carries the applicable text. Exact source `DoorMachine` type preserves the `push` payload at
  the erased import boundary; now root-type clean.
- State package `bun run build` succeeded, and `bun pm pack --dry-run` included the new `children/saved`
  dist plus its declaration, alongside all other packed entries. Package is still private: packing is
  qualification, not publication.
- New installed esbuild job fixture builds from the packed package and dist runtime, with no
  `reactre-source` condition. The first run passed (one esbuild integration test, all five
  assertions), before root typing caught errors in its source fixture. Empty data arguments removed,
  retry/reset events added and event set completed; rerun follows. Use only this later result as
  final proof. The fixture must assert `working -> done({id:"job-1"})`, cancellation of the timer,
  and inactive status after done.

### Remaining blockers and cleanup (do not conceal)

- Job +59 gzip bytes and persist +29 gzip bytes under their existing pins. No safe bounded deletion
  remains in the scoped files; do not claim all size gates pass or silently raise pins.
- Full package suite and exact size table still need one frozen-tree run. Current root total above
  predates the compaction from 3319 to 3304 and the React / installed-job test corrections.
- Root format: tracked campaign sources and qualification files formatted. `bun fmt --check` still
  warns on explicitly generated `.fuzz-out/`, `packages/state/.artifacts/` and codemod output. Those
  are worker-owned generated scratch, not source or release files; copy only sources needed by tests
  into clean parity rather than excluding valid sources merely to manufacture coverage. Review and
  remove scratch only when no worker still needs it. The repository has no `.js` source: ephemeral
  emitted JavaScript in temporary test/build folders is the deliberate exception.
- All-package builds / packs / declarations, `scripts/consumer.ts`, plugin dist verification, and
  React compatibility qualification still need to run on the settled tree. `packages/*/dist` is
  generated. Existing integration tests can install from a state pack with `--offline`; global
  consumer resolves the tools pinned by the script.
- A raw `git archive` of this worktree does not include the still-untracked state package. It cannot
  be called committed-archive CI parity. Until a coherent qualified local commit is permitted, use an
  explicit rsync of all non-generated sources, including untracked codemod test inputs, excluding
  `.git`, dependency and dist folders, generated coverage, `.fuzz-out`, and inspected scratch. If
  later committing, use a fresh committed archive plus `bun install --frozen-lockfile`.
- No benchmark while any implementation is open. Final production speed comparison requires a quiet,
  isolated, like-for-like profiled run; old README speed numbers are historical, not proof of current
  results.
- No commit, push, publication or release-readiness claim. Publication requires a separate explicit
  decision even after qualification. M329 remains a product question, not an invented API.
