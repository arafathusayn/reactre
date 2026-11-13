# Structural payload boundary

Command: `bun apps/profiling/state-data.ts > /tmp/state-data.json`, run alone.
Raw results: [state-data.json](state-data.json). Source revision
`d9a63944c77e01fe76f3f0499f1400f1864c421e`, clean checkout. Bun 1.4.4,
macOS Darwin 27.2.0, Apple M5 Pro. Three paired iterations with alternating order,
100 warmups per workload, identical payloads on both paths. Small payloads run
2,000 copies per iteration; large payloads run 100.

The baseline reproduces the plain-JSON subset of Herdsman's tagged
pack/stringify/parse/unpack/deep-freeze projection at
`746020adc19a1367e885cdd9ba9beacf3c4de135`. It retains both the encoded actor string
and decoded projection. The structural path retains one validated, deeply frozen
copy. Both include a small wrapper, and both reject unsupported data in this case.
The baseline's broader Map/Set/bigint/error support is deliberately outside this
comparison, because the new API does not implement those representations.

| Entries | Encoded median (range), ms/copy | Structural median (range), ms/copy | Reduction |
| ------- | ------------------------------- | ---------------------------------- | --------- |
| 10      | 0.004744 (0.004721–0.005265)    | 0.003028 (0.002974–0.003351)       | 36.2%     |
| 500     | 0.258747 (0.251554–0.259174)    | 0.155737 (0.152896–0.156552)       | 39.8%     |

Median retained heap for 50 live results: 137,314 → 94,048 bytes for the small
case, and 7,560,218 → 5,099,648 bytes for the large case. These are observations
of retained heap after forced GC, **not total allocated bytes**. The structural
path avoids the wire tree, JSON string and decode tree, but still allocates a copy,
property descriptors and traversal maps. No claim of zero allocation is made.

The three iterations have non-overlapping time ranges. These results support a
meaningful boundary-cost reduction on this environment, not a latency guarantee,
a statistical confidence interval or a framework ranking. Transitions that retain
a payload are unchanged; the benchmark isolates acceptance/projection rather than
pretending actor dispatch is responsible for the difference. Application update
rates, payload sharing and schema validation will affect end-to-end savings.

Validation: 4,072 tests pass with 100% line/function source coverage; format,
normal/strict types, package build and packed-consumer checks pass. No actor runtime
or compiler purity mechanism was changed. Input/event data still has an exact
required outer contract. Existing arrays, nested objects, useActor ownership and
stale task-result rejection remain the existing mechanisms.
