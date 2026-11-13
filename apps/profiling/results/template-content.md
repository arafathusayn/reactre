# Static template-string children

The compiler can prove that a complete untagged template literal produces text,
including one interpolating imported static data. Such children now use template
text holes when dependency analysis says they are static. Reactive expressions
retain generic slots and their per-run resource ownership. Tagged templates and
larger expressions beginning with a template literal retain their existing behavior.
There is no runtime API or core disposal change.

## Controlled comparison

Commands, run without concurrent local test/profiling jobs:

```sh
bun apps/profiling/mount-compare.ts b272eed /tmp/mount-profile.json --profile
bun apps/profiling/mount-compare.ts b272eed /tmp/mount-compare.json
bun apps/profiling/ab.ts --base b272eed --entry reactre --rounds 3 --batch 5
```

The first two commands use the same 500-row fixture on both sides, 20 warmup
cycles, 100 measured cycles, three iterations alternating base/head order, fresh
pages, 1280×800 viewport, no CPU throttling. The profiles are separate from the
reported timing run. Base packages: `b272eed3299f3f2a7b79fd233a887c9ca0fab7df`
(identical to main `8bae29b`); head: `3e2c370`, clean. Bun 1.4.4,
Chrome 157.0.8103.78, Darwin 27.2.0, Apple M5 Pro. Both builds use the
working tree's identical fixture and dependencies; the profiling app declares
@reactre/core so both analyses resolve the complete application.

Raw per-iteration data, aggregation, environment, revisions and fixture text:
[mount-compare.json](mount-compare.json). Sampled CPU hot functions:
[mount-profile.json](mount-profile.json). The profile's text-switch samples show
createTextNode among the base's hot functions (10.6 ms summed across three
profiles), disappearing from the head's top functions; DOM creation, insertion
and GC remain the largest costs. Sampling totals are diagnostic, not timings.

| Text workload, 100 cycles    | Base median (range), ms | Head median (range), ms | Reduction |
| ---------------------------- | ----------------------- | ----------------------- | --------- |
| Mount and dispose            | 56.1 (54.9–60.6)        | 47.5 (46.7–47.5)        | 15.3%     |
| Switch away and back         | 56.8 (55.0–59.1)        | 46.7 (46.6–49.1)        | 17.8%     |
| Same-key content replacement | 57.2 (55.1–59.1)        | 44.6 (43.3–46.8)        | 22.0%     |
| Signal updates               | 6.1 (6.0–6.3)           | 6.1 (6.0–6.2)           | no gain   |

The time ranges for the three improved cases do not overlap. Plain and nested
resource workloads vary by less than 4% in median, with overlapping ranges;
these small differences are preliminary/noise, not speed claims. Three iterations
are insufficient for a general latency guarantee. The measurement covers synchronous
script work, not layout/paint or real application navigation.

The repository's six JFB cases report no proven regression. Its one marginal
update-window improvement is noise: both generated JFB bundles are **byte-identical**,
SHA-256 `a0e8fd70627600508c2e3a68fe7300d57aab6a759c9d6495069577ffb340df5d`.
See [template-jfb-ab.txt](template-jfb-ab.txt) for the full bootstrap summary.
This is a regression check, not evidence that the unchanged JFB app got faster.

## Investigated and left unchanged

- Core already clears an owned list container in bulk, then disposes rows.
- Removing owners around static JSX conditionals showed no repeatable gain in
  the first profile/comparison. Broader owner removal can change cleanup ordering,
  so that candidate was discarded.
- Reactive string expressions may create resources during evaluation. Replacing
  their slots with ordinary text bindings loses per-run cleanup; a regression
  explicitly verifies that they retain their slots.
- Skipping subtree cleanup based on DOM attachment would risk detached mounts,
  retained node references and cleanup error ordering. The measured benefit here
  comes from avoiding unnecessary text nodes/slots, without changing disposal.
- DOM cloning/insertion and GC remain bottlenecks. Further runtime changes would
  need stronger evidence than these noisy small differences, so none were added.

The motivating Herdsman reference is `746020adc19a1367e885cdd9ba9beacf3c4de135`;
its local resolver/profile/view modifications were uncommitted when inspected.
These are upstream synthetic regressions inspired by those findings, not copied
application benchmark rankings. Application-specific ANSI node reconciliation,
cache policy and view restructuring stay downstream.
