# Roadmap

What is left before reactre and reactre-compat are ready for real use, in rough order. Each item says what done looks like.

## Goals

| Entry            | What it is                                       | Target in the [jfb replica](../apps/jfb)                                            |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `reactre`        | Declarative TSX over signals. Not React's API.   | Top 3 among the official keyed top 5                                                |
| `reactre-compat` | React's API: an unmodified React app runs on it. | Ahead of at least one official top-5 entry, in the field of the top 5 and both ours |

## 1. Place both entries properly

The seven-entry field is measured: 5 interleaved runs (`--batch 3`) and 4 in the official layout, each with a different `--shift`. The logs are in [`apps/jfb/logs`](../apps/jfb/logs):

```sh
cd apps/jfb
bun pool.ts logs/f7a.log logs/f7b.log logs/f7i*.log   # interleaved: 75 samples per test and entry
bun pool.ts logs/f7o*.log                              # official layout: 60 samples per test and entry
```

| Entry          | Interleaved, 5 runs | Official layout, 4 runs | All 9 runs |
| -------------- | ------------------: | ----------------------: | ---------: |
| vanillajs-lite |         1.027 (1st) |             1.011 (1st) |      1.012 |
| reactre        |         1.029 (2nd) |             1.029 (2nd) |      1.025 |
| thane          |               1.033 |                   1.043 |      1.029 |
| re             |               1.035 |                   1.038 |      1.032 |
| doohtml-dp     |               1.051 |             1.058 (6th) |      1.047 |
| reactre-compat |         1.055 (6th) |             1.067 (7th) |      1.057 |
| vanillajs      |         1.071 (7th) |                   1.049 |      1.049 |

- **reactre: done.** It is 2nd in both pools. Run by run it placed 2nd, 2nd, 3rd, 4th and 3rd interleaved, and 4th, 2nd, 1st and 2nd in the official layout.
- **reactre-compat: not done.** It is 6th interleaved, ahead of vanillajs, but 7th in the official layout, 0.009 behind doohtml-dp. Run by run it ranged from 1st to 7th.

These runs measured the runtime as it was first committed here. The compat fixes since (`3076c60`, `a26c208`) are not in them.

After a runtime change, rerun both pools, keeping the machine otherwise idle and rerunning any run that overlapped other work:

```sh
cd apps/jfb
E=re,thane,vanillajs-lite,vanillajs,doohtml-dp,reactre,reactre-compat
for s in 0 1 2 3 4; do bun run.ts --entries $E --batch 3 --shift $s > int-$s.log; done
for s in 0 3 1 4; do bun run.ts --entries $E --shift $s > off-$s.log; done
bun pool.ts int-*.log
bun pool.ts off-*.log
```

A seven-entry run takes about 2 hours.

**Done when** both pools put reactre in the top 3 and reactre-compat ahead of at least one official entry, with the logs committed so the numbers can be checked.

## 2. Close reactre-compat's gap

Where reactre-compat loses is script time in the measured click, for two reasons:

- **React's semantics.** Selecting a row re-renders the list's parent and compares every memoized row, and events go through synthetic events and the update queue.
- **V8 tiering.** Functions that run once per update reach V8's compile thresholds during the measured click.

In the official-layout pool, clear is most of the gap to doohtml-dp:

| Test (weight)  | reactre-compat | doohtml-dp |
| -------------- | -------------: | ---------: |
| clear (0.42)   |           1.13 |       1.04 |
| select (0.19)  |           1.12 |       1.05 |
| swap (0.13)    |           1.09 |       1.01 |
| update (0.56)  |           1.07 |       1.05 |
| replace (0.56) |           1.02 |       1.09 |

Clear alone accounts for about 0.008 of the score. Select, swap and update add more, and replace, where compat is ahead, takes about as much back. Compat's clear script took 44 to 54 ms in the measured window, against about 42 for reactre and doohtml-dp. The native removal (`apps/profiling/native-clear.ts`) took 31.0 ms on compat's rows, 30.3 on reactre's and 27.1 on vanillajs's. So most of compat's extra time is around the removal, not in it.

Tried, and not kept:

- **One pass in `removeAll`**, instead of one loop that counts the list's nodes and another that marks its rows dead. An A/B on clear, 12 rounds of 8 samples, showed no difference: script 41.5 against 41.7 ms, 95% interval −2.4 to 1.8.
- **Maglev.** With `--no-maglev`, compat's clear script fell from 44.3 to 40.2 ms. But `--trace-opt` and `--trace-deopt` showed none of the runtime's functions compiled or deoptimized inside the measured clear, so the effect comes from elsewhere, perhaps code compiled during the warmups. Not a lead yet.

Next, in order:

1. **No per-row state on DOM elements.** Rows carry two symbol expandos, `FIBER` and `OWN`. For the hand-written @reactre/dom app, an expando slowed native clearing by 5–7%. Measure a build without `FIBER` on keyed list rows (keeping `OWN`, which `place()` needs) with `native-clear.ts` and in the clear test. A first attempt, with the variant as a copied jfb entry, timed out waiting for rows on every run, and the cause was not found: run `native-clear.ts` on each entry alone first. If it closes the gap, event dispatch needs another way to find a row's fiber, such as scanning the list as reactre does.
2. **Profile the clear window** against reactre's, event by event, and open the traces in DevTools to see what else runs in compat's click: `bun window.ts reactre-compat,reactre 09_clear1k_x8 20 --events --save`.
3. **Slimmer fibers.** A row fiber carries about 22 fields, several of them unused by rows (`rx`, `tx`, `hc`, `x`). Moving cold fields into a side object would cut per-row memory on create, replace, append and clear.
4. **Fewer distinct functions on the update path**, so less code tiers up during the click: for example `flushSoon` with `runMicro`, and `rerender` into `flushWork`.

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
- **Source maps.** @reactre/plugin returns no source map for a compiled file, because the compilers rewrite text without tracking positions. **Done when** each compiled file maps back to its source through oxc's map and the compilers' own, and a Vite build with `build.sourcemap` maps a runtime error to the right line.
- **Fast Refresh.** @vitejs/plugin-react's Fast Refresh needs a React renderer registered with react-refresh, which @reactre/compat does not do yet, so an edited component keeps its old code on screen. Until then the docs leave the plugin out and Vite reloads the page on save. **Done when** compat registers with react-refresh, an edit re-renders in place keeping state, and a Vite dev-server check proves it.
