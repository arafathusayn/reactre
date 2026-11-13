# Actor dispatch and core propagation

The retained optimization avoids the discarded `splice` array when an effect or
keyed-row observer removes the last subscriber. Other removals still use the
native stable-order splice. Both observer types share the removal implementation.
Reader-counted signals track the corresponding `pop` operation, preserving lazy
memo disposal and `unobserved` callbacks. Existing gzip budgets are unchanged.

This is a workload-specific allocation improvement, **not an actor-dispatch or
application-wide speedup**. The actor runtime, generated machine transitions,
snapshot ownership, task cancellation and notification rounds are unchanged.

The accompanying selector fix makes delivery use the supplied comparator, as
cached reads already did. Previously delivery used `!==`, incorrectly repeating
`NaN`, suppressing signed-zero changes, and ignoring a custom comparison that
reports an identical value as changed. This correctness fix has a measured cost
in selector-only cases. No public API was added; the existing composition and
its ownership/equality semantics are documented in
[state/signals.md](../../../packages/state/signals.md).

## Reproduction and attribution

Baseline: `63542a92765fbd401e37ce3b99fe47f429e2cd0f`, freshly fetched main.
Candidate runtime and fixtures: `481da6b` (its parent `64ee20d` contains the
fixtures and comparator fix). Only documentation was uncommitted during the
final timings. Source fixtures, full revisions, bundle hashes, raw results and
environment are embedded in [propagation.json](propagation.json).

```sh
bun apps/profiling/propagation-compare.ts 63542a9 /tmp/propagation.json --rounds=8
bun apps/profiling/propagation-compare.ts 63542a9 /tmp/control.json --control --rounds=8
bun apps/profiling/propagation-compare.ts 63542a9 /tmp/profile.json --profile --rounds=2
bun apps/profiling/ab.ts --base 63542a9 --entry reactre --rounds 4 --batch 5
```

Run these sequentially, without competing test/build jobs. The comparison builds
the same fixture against each side's packages and compiler, with strict complete
program analysis and the production state compiler. The core compiler selects
and strips the production core source. Inputs and events are prepared before
the dispatch timer. The generated production machine is a flat, typed payload
replacement machine; every send enters its fresh snapshot. There is no JSON
codec, automatic equality bypass, ingress copy or deep freeze in this fixture.

Environment: Bun 1.4.4, Chrome 157.0.8103.78, Apple M5 Pro, macOS Darwin 27.2.0;
headless, 1280×800, CPU throttle 1, cross-origin isolated clock. Eight paired
iterations alternate base/head order in fresh pages. Each micro case warms three
times with 10,000 inputs, then measures 50,000; DOM cases warm three times with
20 inputs, then measure 200 updates over 200 rows. Setup, dispatch/update,
mounting and disposal have separate clocks. Mount/disposal timings are single
fixture observations and are too short for speed claims.

The layers are raw unobserved signal writes; compiled actor dispatch without
subscribers; actor dispatch to 16 subscribers; a whole-snapshot signal bridge
feeding 16 effects; that bridge feeding 16 core memos; 16 selected-value
subscriptions; 16 selected scalar signal bridges; and one whole-payload selection
feeding 16 effects. The shared DOM fixture compares signals, whole-snapshot
bridges, memos and selected scalar bridges with identical compiled markup.
It checks final text, keyed node identity, disposal and post-disposal updates.

Cases include unrelated revision changes with an unchanged selected scalar;
fresh structurally equal payload objects; changed scalar fields; a synchronous
burst enclosed in core `batch`; and reentrant sends from a subscriber. The raw
signal reentrant control performs an explicit second write; it has no actor
event-ordering contract. The reentrant scenario is measured in the micro layer,
with separate regression coverage for selection consistency and ownership.

## Paired results

The table includes regressions, neutral results and the relevant absolute A/A
gap. Faster-pair counts are descriptive, not confidence intervals. The
[control](propagation-control.json) compiled byte-identical bundles on both sides.
Small cases have sizable noise; in particular the raw-actor case varies enough
that its apparent improvement must not be attributed to an unchanged runtime.

| Fixture / workload                |   Base median (range), ms | Candidate median (range), ms | Median reduction | Faster pairs | A/A median gap |
| --------------------------------- | ------------------------: | ---------------------------: | ---------------: | -----------: | -------------: |
| micro: memo, changed              |    88.343 (85.505–96.965) |       76.825 (70.760–81.420) |            13.0% |          8/8 |           2.0% |
| micro: selected-bridge, changed   |    82.675 (77.160–86.760) |       67.933 (63.370–72.810) |            17.8% |          8/8 |           2.7% |
| micro: memo, reentrant            | 134.428 (126.410–139.325) |    122.360 (114.785–125.175) |             9.0% |          8/8 |           2.3% |
| micro: selected-bridge, reentrant |    93.340 (86.550–97.635) |       81.693 (75.055–84.670) |            12.5% |          8/8 |           2.9% |
| micro: bridge, changed            |    42.877 (40.700–47.695) |       45.517 (40.720–47.985) |            -6.2% |          1/8 |           3.2% |
| micro: selection, unchanged       |       7.162 (6.065–8.120) |          8.518 (6.985–9.705) |           -18.9% |          0/8 |          10.3% |
| dom: selected-bridge, changed     |    14.663 (13.045–17.395) |       14.517 (12.810–17.265) |             1.0% |          4/8 |           5.0% |
| dom: memo, changed                |    18.825 (16.245–20.865) |       17.355 (15.505–20.065) |             7.8% |          5/8 |           7.3% |
| dom: bridge, changed              |    15.788 (13.325–17.005) |       15.365 (13.890–17.285) |             2.7% |          5/8 |           3.0% |

The changed-value memo and selected-bridge microbenchmark ranges do not overlap,
and all eight pairs improve. Their reentrant cases improve in all eight pairs
too. Conversely, the whole-snapshot bridge regresses around 6% in this run, and
selector-only unchanged values regress around 19%. These costs are retained in
the report; this is not a recommendation to replace every bridge with a selector.
The DOM ranges overlap and their median differences are comparable to control
noise. **No integrated DOM speedup is established.**

The raw notification/recomputation counts explain the composition tradeoff.
For 50,000 unrelated updates and 16 consumers, both memo and selected-scalar
paths compute 800,000 selections, but unchanged selections publish zero core
writes. Selecting the fresh whole payload publishes 50,000 updates even when
its fields are equal. In a batched changed-value burst, the whole-snapshot bridge
runs just 16 downstream computations while selector subscriptions still inspect
each transition. These existing semantics, rather than skipped transitions,
explain why selection helps one workload and loses in another.

## Allocation, GC and retained memory

[Separate profiles](propagation-profile.json.gz) contain CPU self-time samples,
GC samples and Chrome sampling-heap-profiler trees/results. A subsequent separate
[CPU capture](propagation-cpu.json.gz) also preserves every full `cpuProfile` object
and an explicit `gcSampleUs` total, rather than only the hottest functions. Export
a profile object as `.cpuprofile` to inspect it in Chrome DevTools. Uncompress with
`gzip -dc`. Sampling includes collected objects, uses a 16,384-byte interval and
covers the whole fixture call (input preparation, setup, work and disposal).
These are sampled allocation estimates, not exact allocated-byte counts; none
of the profiled timings is used in the timing table.

In two profile pairs, changed-value micro memos estimate 285.3 → 201.9 MB allocated
and selected bridges 244.5 → 164.1 MB. The corresponding DOM cases estimate
23.6 → 18.6 MB and 22.0 → 18.9 MB. The whole-snapshot bridge does not improve
allocation (115.1 → 117.7 MB in the micro case). The profiles locate work in
subscription removal, reactive execution and GC; DOM creation/removal/insertion
remains substantial in the integrated fixture.

Raw timing results also record heap use before forced GC and retained-heap deltas
after disposal and forced GC. These measure what remains in the page, not live
actor size or total allocations. Small and negative deltas reflect collection of
prior/JIT bookkeeping too; they do not prove a memory saving. The optimization
reduces transient discarded arrays, without a retained-memory claim.

## Investigations and rejected changes

- [General manual shifting](propagation-rejected-shift.json) avoided splice result
  allocations and improved small fan-out, but regressed the 200-row DOM cases
  about 18–30%. It was reverted. The final implementation shifts through native
  splice except for the last element.
- [Exploratory runs](propagation-exploratory.json.gz) retain the initial A/A,
  shifting-era profiles, first pop candidate and superseded timings. The first
  pop candidate failed lazy/unobserved-reader lifecycle tests. The final candidate
  fixes that contract and shares the removal implementation so existing size
  budgets pass. Only the final candidate is the basis for the table above.
- No actor dispatch rewrite: profiles put the meaningful cost in reactive work,
  allocation and rendering. Raw dispatch is much smaller and noisy. The generated
  flat machine already reuses its transition result as the snapshot; no extra
  snapshot copy needs removal. Historical snapshots and all required actor
  notifications remain untouched.
- No selector API: `select` plus a signal and `onCleanup` already supplies the
  observed benefit. Views unsubscribe from externally owned actors; owner-created
  actors still stop with their owner. Function-valued selections, signed zero,
  independent disposal, remount and reentrant sends have explicit regressions.
- No additional record-lookup text-hole rule: the compiler's current content
  facts do not prove arbitrary imported/indexed values scalar. Records may contain
  nodes, getters, inherited properties or mutable entries. A type annotation or
  initially string-valued object is insufficient proof, and reactive evaluations
  may own resources. Static template strings and bulk list clearing already exist.
  The profiles do not justify broad ownership/disposal changes or weakening this
  conservative behavior. Compiler output and client/server/hydration paths remain
  unchanged by a new scalar rule because no such rule was added.

## Validation and downstream impact

The final runtime passes normal and strict type checks, formatting, all package
builds, **4,095 tests with 100% source line/function coverage**, plugin distribution
checks, packed-consumer type checks and the complete React compatibility run.
Existing byte budgets pass unchanged.
The suite includes generated-machine ordering/guards/tasks, historical snapshots,
cancellation/stale results, same-key updates, delegated events, conditional content,
server rendering and hydration. The new tests cover comparator edge cases,
selected view lifetime and subscriber removal order/reader counting.

The [JFB regression run](propagation-jfb.txt), four alternating rounds with five
samples per side per workload, reports no proven difference for any of its six
workloads (script time and click-window duration). It establishes no new ranking.

The disposable Herdsman copy passes all **41 selected tests** covering its benchmark
fixture, source-build integration and state lifecycles; both `reactre-state` and
`reactre-signals` production benchmark builds pass. The first attempted run caught
the counted-reader cleanup issue, which was fixed upstream and rechecked. The
broader Herdsman web suite also passes **339 tests across 52 files**, and the full
production web build (both HTML entrypoints) succeeds in that same disposable copy.

Herdsman reference: `3bc76cc71710c962202965d3833ef7250eace0a7`. Its real worktree
is read-only. Compatibility is exercised in a disposable archive with the
candidate in `web/vendor/reactre`, using Herdsman's actual source resolver and
machine compiler. Its benchmark already uses typed payloads, so the earlier
`immutableData` JSON-conversion gain is not applicable here. Domain adapters,
cache policy, transport normalization, persistence and row reconciliation stay
downstream. Adoption requires updating its vendored source; no new API migration
is required. Custom comparators should be pure and must not rely on call counts.

No full downstream framework ranking was run or claimed. The recorded 1.112858
state score versus 1.062771 second-place score and 2.795% identical-build gap are
motivation, not a new result. Nothing here demonstrates top-two placement.
