# Selecting actor values in core views

`useActor(machine, options)` owns an actor for the current component/root. Its
snapshot accessor keeps the discriminated `Snapshot` type: store the result of
`snapshot()` in a local before narrowing on `state`. Owner cleanup unsubscribes
the bridge and stops the actor, aborting its work. This API is unchanged.

For a view of an actor owned elsewhere, compose `@reactre/state/utils/select`
with a core signal and owner cleanup. The actor remains the only writable source
of application state:

```ts
import { onCleanup, signal } from "@reactre/core";
import { select } from "@reactre/state/utils/select";

// Inside the observing component/root; cachedActor is owned by a cache.
const selection = select(cachedActor, (snapshot) =>
  snapshot.state === "ready" ? snapshot.data.title : "Loading",
);
const [selected, publish] = signal({ value: selection.get() });
onCleanup(selection.subscribe((value) => publish({ value })));
const title = () => selected().value;
```

The wrapper object matters. Core's basic signal compares with `===`; selection
defaults to `Object.is` and permits a custom comparator. Publishing a wrapper
preserves selection notifications for signed zero and custom comparisons, and
keeps function-valued selections from being interpreted as signal updater
functions. The wrapper is notification plumbing, not independently writable
application state. Keep `publish` private to this subscription.

This view's cleanup removes only its subscription. It does **not** stop the
external actor. A remounted view starts with `selection.get()` from the current
snapshot, including updates while no view was mounted. Cache eviction or
application shutdown must stop the actor explicitly. Independently mounted views
can subscribe and dispose independently. For a component-owned actor, keep using
`useActor`, or register `actor.stop` with that actor's owning root when composing
`createActor` directly.

Selectors and comparators must be pure. A selection caches its value for the
current snapshot, retaining the previous value when the comparison says equal.
Subscriptions receive future changed values; they do not immediately publish the
initial value. A custom comparator controls both cached values and delivery,
including `NaN`, signed zero, and a comparator that always returns false. It can
run during both reads and delivery; do not depend on comparison call counts.

Reentrant sends follow the actor's existing rounds. A selection reads the
actor's **current** snapshot. If an earlier listener sends again, a later
selection can see that newer snapshot rather than an intermediate one. It is
not an event log. Use actor subscriptions when the delivered round snapshot is
the required value. The change does not alter actor ordering or notifications.

## Choosing a bridge

Select narrow values that often remain equal when unrelated fields change.
Selecting a fresh whole payload still reports a change under `Object.is`, even
when its fields are structurally equal. A structural comparator is an explicit
application choice and has its own cost; there is no automatic deep comparison,
copy, or freeze on transitions.

Core `memo` already suppresses downstream work for unchanged derived values,
but it still participates in core invalidation when the complete snapshot
changes. Selection can compare before entering the core reactive graph. In the
paired fixtures this helps unchanged scalar selections, while core batching
can make the whole-snapshot bridge substantially faster for bursts. Measure the
actual update pattern; selector-per-row is not a universal recommendation.

No new public bridge is introduced: the existing composition supplies these
semantics. See the [paired measurements](../../apps/profiling/results/propagation.md)
for controls, negative results, allocation observations and limitations.
