# Herdsman upstream work

## Evidence and plan

Reactre baseline: `8bae29b9fce00ab1e192f906e15191c6057550d7` (origin/main).
Implementation checkout: `/Users/arafat/.codex/worktrees/0066/reactre`, initially clean.
The main checkout contains unrelated JFB edits and is not used.
Herdsman reference: `746020adc19a1367e885cdd9ba9beacf3c4de135`.
Read-only reference checkout: `/Users/arafat/.codex/worktrees/reactre-state-migration/herdsman`.
The inspected `web/reactre.ts` sourceCompiler adapter, build regression, imported
row fixture, shared benchmark view edits and profile-reactre.ts are **uncommitted**;
they are not attributed to that revision. ADR 0036 and the state adapters explain
string encoding and cached controller lifetimes.

1. Compiler PR: expose the existing host through the Bun plugin, diagnostic callbacks
   and opt-in strict analysis. Test aliases, external and unresolved modules, fallback,
   late modules, and imported static data. Reuse existing runtime selection.
2. State PR: choose a checked plain-data extension after inspecting the type and compiler
   boundaries. Preserve exact workflow contracts, readonly snapshots and JSON round trips.
   Compare its costs to the downstream tagged string encoding.
3. Performance: profile list mount, same-key update, view switch and disposal before
   changing compiler/runtime code. Existing HTML entries, list container bulk clear,
   task cancellation and useActor cleanup are already supported. Keep optimizations only
   with correctness evidence and controlled three-iteration measurements, including
   representative workloads outside the motivating case.
4. Lifecycle PR: focused request/retry/reentry and cached-controller examples, matching
   statecharts and executable regressions using existing actor APIs.
5. Run repository checks, review each diff, publish independently reviewable PRs and
   inspect latest-head CI/reviews/mergeability. Do not merge. Human approvals and other
   external dependencies are reported as blockers, not success.

Application-specific SDK error classes, transport resources, ANSI reconciliation,
cache policy and domain-specific statecharts remain downstream.
