# Roadmap

What is left before reactre and reactre-compat are ready for real use, in rough order. Each item says what done looks like.

## Goals

| Entry            | What it is                                       | Target in the [jfb replica](../apps/jfb)                                            |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `reactre`        | Declarative TSX over signals. Not React's API.   | Top 3 among the official keyed top 5                                                |
| `reactre-compat` | React's API: an unmodified React app runs on it. | Ahead of at least one official top-5 entry, in the field of the top 5 and both ours |

## 1. Place both entries properly

Run the seven-entry field to stable pools: at least 5 interleaved runs and at least 4 official-layout runs, each with a different `--shift`.

```sh
cd apps/jfb
E=re,thane,vanillajs-lite,vanillajs,doohtml-dp,reactre,reactre-compat
for s in 0 1 2 3 4; do bun run.ts --entries $E --batch 3 --shift $s > int-$s.log; done
for s in 0 3 1 4; do bun run.ts --entries $E --shift $s > off-$s.log; done
bun pool.ts int-*.log
bun pool.ts off-*.log
```

Keep the machine otherwise idle, and rerun any run that overlapped other work.

**Done when** both pools put reactre in the top 3 and reactre-compat ahead of at least one official entry, with the logs committed so the numbers can be checked.

## 2. Close reactre-compat's gap

Where reactre-compat loses is script time in the measured click, for two reasons:

- **React's semantics.** Selecting a row re-renders the list's parent and compares every memoized row, and events go through synthetic events and the update queue.
- **V8 tiering.** Functions that run once per update reach V8's compile thresholds during the measured click.

Not yet tried:

- **Slimmer fibers.** A row fiber carries about 22 fields, several of them unused by rows (`rx`, `tx`, `hc`, `x`). Moving cold fields into a side object would cut per-row memory on create, replace, append and clear.
- **No per-row state on DOM elements.** Rows carry two symbol expandos (`FIBER`, `OWN`). For the hand-written @reactre/dom app, an expando slowed native clearing by 5–7% (`apps/profiling/native-clear.ts`). Measure reactre-compat with and without them first: event dispatch walks `FIBER`, and placement uses `OWN`.
- **Fewer distinct functions on the update path**, so less code tiers up during the click: for example `flushSoon` with `runMicro`, and `rerender` into `flushWork`.

Already measured and rejected: building component elements through `jsx()`, a fragment in `place()`, `insertBefore` instead of `moveBefore`, turning off the inert template document, and skipping the per-event mark.

**Done when** item 1's pools show reactre-compat ahead of at least one official entry, `ab.ts` proves each kept change, and the compatibility check still passes 36 of 36 with classes.

## 3. reactre's correctness gaps

These don't affect the benchmark app, but would affect a real app.

- **Ownership and disposal.** An effect created in a component or in a slot's content is never disposed. When a slot replaces its content (`{cond() ? <A /> : <B />}`), the old content's effects stay subscribed and write to detached nodes. Needed: an owner tree, where each effect or slot run owns the effects created in it and disposes them before it re-runs, plus `onCleanup`.
- **Rows can hold only host elements.** A component, a nested `<For>` or a JSX expression in a row is a compile error today. A row-level slot needs the ownership above.
- **Selector.** It records one key per row, so a row that reads two selectors, or one selector with two keys, keeps only the last. An observer outside a row is removed only when its key changes, so one that stops reading a key re-runs once more than needed.
- **Batching.** Collecting pending effects is quadratic in a long batch, and nothing guards against an effect that writes what it reads.
- **Compiler coverage.** Not handled yet: fragments and spread props (compile errors today), `style` objects, `ref`, SVG (templates are parsed as HTML), `checked` and `value` as properties, events that don't bubble (`focus`, `blur`) inside rows, and `key` on a host element outside `<For>`. A hole that reads a plain mutable variable is written once, by design; document it.
- **Handlers outside lists** are bound once. A handler expression that reads a signal doesn't update.

**Done when** each has a test, and `ab.ts` shows the benchmark numbers unchanged.

## 4. reactre-compat's known bugs

- **Spread props in a compiled list row.** @reactre/compat/compiler's free-name scan treats a name after `...` as a property access, so `rows.map((r) => <li {...extra}>{r}</li>)` hoists a loop that is never passed `extra`. It throws a ReferenceError, or reads the wrong binding.
- **`componentWillMount` next to `getSnapshotBeforeUpdate`.** On mount, the class runtime checks the class's static `getSnapshotBeforeUpdate` instead of the instance's method, so a class that defines it still gets `componentWillMount`, which React skips.

**Done when** each has a failing test first, then a fix, with the compatibility check still at 36 of 36 with classes.

## 5. reactre's remaining speed

- **Update.** Updating a row computes the old item's hole values and re-runs the row's reactive holes. Either keep the last values for item holes (measure the memory), or skip the reactive re-run when its expressions don't read the item, which needs the compiler to know what each expression reads.
- **Create.** A row object has seven fields. Measure whether moving `obs` and `sel` into a side table, for rows that never need them, moves create or clear.

## 6. Packages

- **Type declarations.** The packages give types through their TypeScript sources. Emit `.d.ts` files instead, so a consumer's own compiler settings never type-check reactre's sources.
- **JSX types.** Give editors the types of reactre's intrinsic elements and `<For>`, so TSX written for reactre type-checks.
- **Other bundlers.** @reactre/compiler and @reactre/compat/compiler are Bun plugins. Plugins for Vite and esbuild would bring TSX to other build setups.
