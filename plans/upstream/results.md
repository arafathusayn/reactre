# Herdsman upstream audit

Reactre baseline: `8bae29b9fce00ab1e192f906e15191c6057550d7`.
Herdsman reference: `746020adc19a1367e885cdd9ba9beacf3c4de135`, read only in
`/Users/arafat/.codex/worktrees/reactre-state-migration/herdsman`.
The local `web/reactre.ts` adapter, compiler regression fixtures, shared benchmark
view and profiling/build edits were uncommitted when inspected. They are separate
evidence, not attributed to the committed reference. Reactre's main checkout and
its unrelated JFB changes were left alone.

| Task                     | Outcome                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolver integration     | [PR #2](https://github.com/arafathusayn/reactre/pull/2) exposes analysis host overrides, diagnostics and opt-in strict analysis through the compiler's Bun plugin. Resolved, external and unresolved modules remain distinct. Custom resolution restores imported static-data facts.         |
| SDK data contracts       | [PR #3](https://github.com/arafathusayn/reactre/pull/3) accepts nested optional properties and string records while preserving required workflow fields. An opt-in checked `immutableData` copy/freeze boundary avoids the string round trip for plain JSON data.                            |
| Mounting/cleanup         | [PR #4](https://github.com/arafathusayn/reactre/pull/4) compiles proven-static, complete untagged template strings as text holes. Dynamic expressions retain their slots and resource ownership. No core cleanup semantics change.                                                           |
| Further performance work | Three paired iterations measure payload boundary and static-text improvements. Existing bulk list clearing was retained. Removing static JSX owners did not establish a repeatable gain; remaining DOM cloning/insertion and GC costs do not justify additional speculative runtime changes. |
| Lifecycle workflows      | [Runnable examples and regressions](../../packages/state/examples/README.md) cover cancellation, reentry, late non-cancellable results, retry, view disposal/remount and cached-controller ownership using existing APIs.                                                                    |

Each PR is independently based on the baseline. The compiler and state PRs include
API/migration documentation; the performance PR includes raw timings, separate CPU
profiles, identical-fixture comparisons, environment/revisions and the JFB regression
run. No benchmark result is a framework ranking or an application latency guarantee.

## Supported before these changes

HTML entries already participate in compilation. Incomplete whole-program analysis
was a loss of optimization facts, not disabled TSX compilation. Core already clears
an owned list container in bulk. State already supports arrays and nested plain
objects, aborts state-owned tasks, rejects stale task completions and provides
`useActor` owner cleanup. The lifecycle work documents and tests those mechanisms
instead of adding competing abstractions.

## Deliberately outside the upstream changes

Map/Set, bigint and custom errors still require explicit plain-data normalization.
Functions, DOM nodes, promises, class instances and transport handles are runtime
resources, not state payloads. Unknown input requires a schema before the immutable
boundary. JSON serialization does not preserve object identity or freezing; restored
payloads must reapply the boundary where runtime freezing is required.

Herdsman's transport adapters, ANSI reconciliation, domain statecharts, cache keys,
retention, authorization invalidation and stale-data UX remain downstream. Cancellation
cannot undo an external side effect; request idempotency remains application policy.
The cache example has explicit eviction/shutdown disposal, not an automatic cache.

The state boundary benchmark measures copy/projection time and retained heap after
GC, not total allocations or actor dispatch. The mounting benchmark measures
synchronous script work, not layout/paint. Small overlapping differences in other
workloads are treated as noise. The JFB bundles are byte-identical across that
comparison, so no JFB speedup is claimed.

PR readiness is checked against each latest head, CI, mergeability, repository rules
and actionable feedback. No PR is merged by this task.
