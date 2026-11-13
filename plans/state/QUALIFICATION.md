# @reactre/state: qualification record

## Fresh committed-archive CI complete (2026-11-11 17:40 +06)

`git archive 2c5fc89` in `/tmp/reactre-state-archive-2c5fc89-20261111` completed every actual CI command exit 0. Log `/tmp/reactre-state-archive-2c5fc89-ci.log`: frozen install, format, archive root type 645 and strict 248, all package builds/packs before ordinary root tests, **4066 pass / 0 fail, 170 files, 100.00% functions / lines**, all ten plugin-dist checks and all four packed consumer declarations. Chrome matches **131/131 compat and 131/131 compat+compiler**, and its core subset **100/131** with expected exclusions. These surpass the earlier red archive Chrome attempts. No production core/compat changes were made to get that gate.

The final Headless UI repair uses `await frames(2)`, matching its nested-rAF clearing schedule. The intermediate `until(!data-changing)` repair in `a3623a3` failed its full archive: its initial predicate can test the old checked=false node before the first runtime render. Focused and full results not agreeing prevented counting a premature pass. `2c5fc89`'s full local run gave 131/131 for both main modes, then the new full archive confirmed it. `192c110`/`a3623a3` were not qualified; this is local CI evidence, not pushed, published, benchmarked or release-ready output.

## Archive CI reaches Chrome; transient sampling repair (2026-11-11 17:30 +06)

The first actual archive of local `192c110` ran all ordinary gates through packed declarations successfully: root types 645 (discovered archive files) and strict 248, builds/packs, **4066 tests / 0 fail / 100% functions and lines**, plugin dist and all four declaration variants. Its complete Chrome compatibility was **130/131** twice; the plus-core subset **99/131** with its documented intentional exclusions rather than a new failure. React caught Headless UI's `data-changing` on run one, compat caught it on run two, proving a sampling race rather than metadata that only one side can settle. The two-frame update is not bounded by six timer turns. The intermediate scenario used an `until()` attribute predicate whose focused run was **4/4 in each mode** and static checks clean, but its full archive still failed: the old DOM can satisfy it before the first update. That attempt is red, and the corrected explicit frame wait and its passing final chain are recorded above.

## Ordinary coverage and emitted-bundle isolation (2026-11-11 17:05 +06)

- Current ordinary parent gate: **`bun test --coverage` exited 0, 4066 pass / 0 fail across 170 files, 100.00% functions / 100.00% lines** (`/tmp/reactre-state-root-coverage-rerun.log`). Types 681 + strict 248 and formatting are clean. A separate full LCOV run also passed 4066 / 0; it is supporting evidence, not a threshold substitute. An earlier same-scope ordinary run was red: 4065 pass / 1 fail despite 100.00%. This qualification does not erase that result and still requires its committed-archive verification.
- That red failure was provide's `sla=0`, `soon=0` test after one 5ms wait. It requires two distinct zero-delay callbacks before its `done` assertion, which can observe `late` under a starved loop. `t1w` traced that machine to feature `l` timers, never the changed ordinary `a`/quick lifecycle, and reproduced the failure with an independently queued 6ms blocker. Its isolated 71-test timer run passed. Parent adds a second 0ms turn after the 5ms one, without changing the expected behavior or runtime.
- `data:*` was **not** a working text-coverage filter; that earlier interim claim is withdrawn. The ordinary report first showed rounded 100.00% with a generated compiler-app partial file, then **4066 pass / 0 fail but 98.43% functions / 99.67% lines** because all installed/source bundler `.mjs` outputs were imported into the parent. Excluding legitimate package source would be invalid. Instead, production inline and written bundles consistently execute in a separate Bun; the asserted behavior is of those exact produced bytes. The focused bundler/nested/React tests pass 40/40, and the final cleanup plus provide tests pass 28/28. Nested/React inspect the emitted machine's `d` hook; the interactive child uses the ordinary runtime core, not a fabricated `@reactre/state/dev` actor or a caller-mode echo.
- The scope retains 1.0 thresholds and all package sources, including compiler/plugin/codemod. `apps/**` and `scripts/**` are application/build tooling, not package library sources; this does not claim Chrome helper coverage in the apps. Test/dist/generated differential and temp-bundle boundaries stay named, not broad package-prefix exclusions.
- No follow-up commit exists yet. A coherent local checkpoint followed by a fresh `git archive` and complete exact CI is still outstanding; no push/publication/readiness or performance result.

## Settled-tree verification and source coverage repair (2026-11-11 15:12 +06)

- Parent serial root run: **4065 pass / 0 fail, 170 files**; job **1053/1060**, persist **3273/3275**, durable **2795/2865**, durable+children **6001/6095**, editor **1811**. This root behavior-size run predates only source-scope and documentation cleanup, and mutex-serial package reruns are required for any changed product assertion.
- **All existing size pins were retained.** The compiler chooses ordinary short literal timers without `__wait`; its value >2^31−1 (including 600h), restored deadlines, persistent task runner and computed delays retain the safe scheduler. Long timers, cancellation, stale task results and the actual installed job still execute their tests.
- Persist's separate prior failure remains rejected: `kept["__proto__"] = ...` mutates a normal object's prototype. Current safe `Object.fromEntries` preserves that key as own data, and its malformed-history S20 regression passed in root. Its version/shape and sparse/inherited JSON traversal boundaries were left intact. No persist API/type relaxation or production diagnostic machinery.
- `t1v` read-only lifecycle review: no independently reproducible stale completion after exit/stop, including persist's guarded `deliver`. It ran a throwaway real-Chrome detached-cancel probe, not repository test evidence. `t1t` hit worker model-routing 400 and made no change. No new worker needed launching.
- Namespace static metadata and same-name exported values are fixed by following the defining binding instead of re-resolving an identifier into a false cycle. Namespace feature opt-in remains separate from static value resolution. Computed/static member reads retain their literal expression and reject prototype/invalid keys; parser-unproducible nested key fallbacks are narrowed to the proven Literal case. String-named export resolution remains consciously unsupported.
- `ShapeContext.string` was unused and removed. Focused compiler behavior was **680 pass / 0 fail after resolver cleanup**, with its full compiler type-error audit; parent final type checks and ordinary coverage are independently rerun.
- Coverage corrections: root text and LCOV initially included generated fuzz, test-created temporary bundles and data URLs as sources. The root filters now name these non-source boundary cases, plus apps and build-tooling `scripts/`, but never package sources, compiler, plugin or codemod. Report-only LCOV mode exits nonzero on scoped runs without a printed threshold failure; the plain root **`bun test --coverage`** decides the 1.0 gates. Its first completed ordinary run was **92.63% functions / 97.68% lines**, even with all 4065 tests passing, and adding `scripts/**` did not change those totals. Its LCOV merges show no uncovered package-source lines. Direct diagnostics on Bun 1.4.4 found that `^data:` and `data:` affect only its LCOV writer here; **`data:*` also does not exclude them from its text report**. The generated inline bundle now runs in a separate Bun, so that ineffective filter is unnecessary. See the later 17:05 entry for the passing ordinary gate; a new local commit and **its fresh archive** must still run the entire CI chain.

## Committed-archive result (2026-11-11 13:31 +06)

`git archive 9f6070b` was extracted to `/tmp/reactre-state-archive-20261111`; it contains the state sources, fixtures and tests. Frozen install and formatting passed, with root types 0 errors / 641 files and strict types 0 / 248. The root check covers only discovered root files; it is not the worktree's generated-file count.

## Qualification corrections and bounded campaign follow-up (2026-11-11 13:48 +06)

- The exact CI build / pack / plugin-dist / consumer steps on the built archive all exit 0, as do its five installed-package files: **15 pass, 0 fail, 73 assertions**. `bun run compat` passes 131/131 `compat` and `compat+compiler` scenarios (the intentionally narrower core subset remains documented). These are independent observations of ordinary parent Bash, not worker-only claims.
- The CI ordering repair moves the existing build-and-pack step before coverage tests, with the underlying assertion and package behavior unchanged. It needs a final new committed-archive run after the remaining lanes settle.
- Root warning isolation is fixed: `react-dev.test.ts` leaked its `console.warn` spy; Bun returns the same spy when another file calls `spyOn(console,"warn")`, retaining the old calls. An after-each restore now protects the next file. Exact core-plus-React test pair is **61 pass, 0 fail**. This is test-only and preserves warnings as required behavior.
- The `3304 -> 3273` candidate was **not accepted**: its history `for-in` writer turned own `__proto__` data into a prototype. Restoring own-data semantics and adding its real-JSON regression now measures **3280**, still 5 above the unchanged 3275 pin. The S11 remediation and shape/version/path distinctions remain. Independently, persist+size 75 pass / 2 fail / 77 (the two size pins, not behavior).
- **Correcting an earlier coverage claim:** a full root run printed **79.80% functions / 98.42% lines**, not 100%. The lcov includes `scripts/`, apps and intentionally generated `.fuzz-out` cases; those generated cases must not be confused with valid uncovered package sources. The archive package lcov does have genuine compiler zero-hit lines (index 13, values 10) being exercised with real supported/failure-boundary fixtures, not invented calls. The focused root lcov was restored to the committed whole-repo evidence; the controller's focused commands showed threshold enforcement is not an observed green gate under this environment. Do not claim a 100% gate passes without a verified complete run and clean source-only lcov.
- New bounded work: `t1v` is implementing compiler short-fixed-delay wait specialization, preserving dynamic/restored-delay safety and the cancellation contract, with a threshold fallback only if independent measurement warrants it. `t1w` has the small genuine compiler coverage fixtures. No pins or fixtures weakened, no additional agents, no performance work, and no release claim.

## Earlier frozen-tree observations (2026-11-11 13:16 +06)

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
