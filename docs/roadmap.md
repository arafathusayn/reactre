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

Measured again at `1bbf6ea`, the gap has moved. A spot check of compat against doohtml-dp alone (`run.ts --batch 3`, 15 samples) scored 1.010 against 1.009: compat ahead on select (8.5 against 9.5 ms), level on create, replace, swap, create10k and clear (12.5 both), behind on update (17.7 against 17.0) and append (22.3 against 21.9). In `window.ts --kinds`, clear's script is 6.7 ms for compat, 6.5 for reactre and 6.4 for doohtml-dp, so clear is no longer where compat loses. Update's script is 1.5 ms against 0.9 for reactre and 1.1 for doohtml-dp, and in a cold profile (80 clicks) half of compat's is the 100 text writes every entry makes. The rest is spread thin: dispatch about 0.1 ms, patchDelta, patchRow, runFunc and the list loop about 0.07 each. `--no-maglev` leaves update's script where it is (1.5 against 0.9), so it is not tiering. The Maglev compile the trace shows at the click's start runs on a background thread, with 0.06 ms of finalizing on the main one.

Each of these was an A/B against `1bbf6ea` with `--entry reactre-compat`, 8 rounds of 6 unless said, on the 6 default tests plus 06, 07 and 08 where a full change was built, or on the tests a measurement hack can run:

- **No per-event mark on the native event when the root has one listener** (the replayed capture of a hydrating root still marks it). A re-measure of the rejected skip, with React's dedupe kept for portals. No test moved: update script +0.1 ms, 95% interval −0.1 to 0.2; select −0.1, −0.2 to 0.1; swap −0.0, −0.3 to 0.2; replace +0.2, −0.0 to 0.3. A first run on update, select and swap alone had update script −0.1, −0.3 to −0.0, which did not reproduce.
- **No `FIBER` on keyed list rows** (item 1, measured as a hack, so only the tests that click no row). The earlier timeout's cause: the jumbotron's buttons are blocks in slots too, so a build that drops `FIBER` from every block in a slot leaves them without handlers and `#run` does nothing. Dropping it only from rows with a string key, script fell by 0.1 ms on create (−0.1 to −0.0) and create10k (−0.1 to −0.0); no duration moved (create −0.1, −0.1 to 0.0; create10k 0.0, −0.3 to 0.6) and clear did not (script −0.1, −0.2 to 0.1; duration +0.2, −0.6 to 0.8). A real build also needs a slower way for events to find a row's fiber and more bytes than the size budget has left, for no duration gain.
- **No `FIBER` and no `OWN` on keyed rows** (a hack: `place()` cannot run without `OWN`). Clear still did not move: script 0.0 ms, −0.3 to 0.2; duration −0.1, −0.7 to 0.5. So per-row state on elements is not what clear costs compat now.
- **No props compare for rows the list loop reported changed.** In `patchDelta`, a row whose element is new where the last one had the same key has props that differ (the loop compared them with that element's), so `patchRow` renders it without `sameProps`, calling `runFunc` directly (not with `defaultProps`, which the loop compares unresolved). No test moved: update script 0.0 ms, −0.1 to 0.2; select −0.1, −0.3 to 0.1; swap −0.2, −0.3 to 0.0. 11 bytes gzipped.
- **The three together, plus a text hole updated inside `runBlock`'s loop instead of through `setChild`.** On the five click tests, 8 rounds of 6: update script −0.2 ms, −0.3 to 0.1, nothing proven. At 12 rounds of 8 on update, select and swap: update script −0.0, −0.1 to 0.1 (duration −0.2, −0.4 to 0.1); select duration −0.3, −0.7 to 0.1; swap −0.2, −0.4 to 0.1. It adds 135 bytes minified and 57 gzipped, past the size budget.
- **Slimmer fibers** (item 3, as a hack: `rx`, `tx` and `hc` left off the class, 3 of its 22 fields, which the benchmark's fibers never write). No test moved: create10k script −0.1 ms, −0.2 to 0.0; replace −0.1, −0.3 to 0.1; clear −0.1, −0.4 to 0.2; create −0.0, −0.0 to 0.0. As with reactre's `obs` field (section 5), 12 bytes of a row's few hundred are too few to see.

So at this resolution, about 0.1 ms of script and 0.2 to 0.5 ms of duration, no single change to the click path is provable. The per-click work left is React's: the parent's render, the list loop over every row, the memo compares, the synthetic event and the update queue, each a few hundredths of a millisecond.

The size budget (`packages/compat/sizes.json`) is 55 bytes minified and 31 gzipped above what main builds to (125,600 and 45,863 for the default entry), so a change has about that much room.

Next, in order:

1. **Rerun the pools.** Clear, the gap the old next steps were written for, is level now (see above), and the spot check puts compat and doohtml-dp within 0.001. The pools say whether compat is ahead.
2. **Fewer distinct functions on the update path**, for example `flushSoon` with `runMicro`, and `rerender` into `flushWork`, if the pools still put compat behind. Its premise, code tiering up during the click, did not hold for update (`--no-maglev` left its script as it was), and each merge saves a call or two per click, so expect little.

No per-row state on DOM elements and slimmer fibers, the old items 1 and 3, are measured above and not kept.

Already measured and rejected: building component elements through `jsx()`, a fragment in `place()`, `insertBefore` instead of `moveBefore`, turning off the inert template document, and skipping the per-event mark.

**Done when** section 1's pools show reactre-compat ahead of at least one official entry, `ab.ts` proves each kept change, and the compatibility check still passes all its scenarios (131) with classes.

## 3. reactre's correctness gaps

These don't affect the benchmark app, but would affect a real app. Each one is fixed and has a test in `packages/core/test`; what is left is the A/B.

- **Ownership and disposal.** Done. Each effect run owns the effects and cleanups it makes and disposes them before it re-runs, so a slot that replaces its content (`{cond() ? <A /> : <B />}`) stops the old content's effects. `onCleanup` registers a cleanup on the current owner (outside one it does nothing); `render` returns a disposer. A disposed slot removes its content, and a `<For>` clears its rows and listeners when its owner goes.
- **Rows can hold more than host elements.** Done. A component, a nested `<For>`, a JSX expression, a property, a `style`, a `ref` or spread props in a row compiles to `__forMount`, a list whose rows own what those parts create. A new item for the row cleans its owner and runs them again, so a nested list is rebuilt then, not reconciled; a row that leaves disposes them. A row of host elements and values still compiles to `__for`, as before.
- **Lists anywhere, rows of any shape.** Done. A `<For>` or `<Repeat>` no longer has to be an element's child with rows of one element: one that is a component's whole view, a fragment's child, the only child of control flow, a boundary or a provider, or whose rows are text, fragments, arrays, components or content that changes, compiles to `@reactre/core/features/for`'s `__each`, its nodes between markers of its own; on the server and in hydrate mode too (`@reactre/core/hydrate/for`). A list of element rows in an element still compiles to `__for`, byte for byte.
- **Selector.** Done. A row that asks a second (selector, key) pair keeps them all, and from then on its list scans with a slower loop; a row's pairs are recorded afresh on each run. A reader outside a row subscribes to a per-key source, so it stops following a key it no longer asks about.
- **Batching.** Done. The queue flags queued observers instead of searching itself, and a flush no longer shifts it, so a batch is linear. An effect notified while it runs (it wrote what it read) runs again after its run, and throws after 100 re-runs in a row. Not guarded: a `<For>` row's reactive hole that writes what it reads.
- **Compiler coverage.** Done: fragments (inlined into the parent's template, or `__frag` outside an element), spread props (`__spread`), `style` objects and strings (`__style`), `ref` (a function or an object with `current`), SVG (a template whose root is an SVG element is parsed inside `<svg>`, and `class` is an attribute there), `value`, `checked` and `selected` as properties, events that don't bubble delegated in the capture phase, and `key` outside `<For>` (a key that calls something rebuilds the element when it changes; a constant key is ignored). The core README says a hole that reads a plain variable is written once.
- **Handlers outside lists.** Done. A handler expression that calls something and is not a function literal is followed (`__on`).

**Done when** `ab.ts` shows the benchmark numbers unchanged. The jfb app compiles to the same code as before, byte for byte. The runtime functions it runs that changed: `notify`, `batch` (and the new `flush`), `Effect.run` and `Effect.stale`, `effect`, `Selector.watch` and `Selector.changed`, `ForList.refresh` and `ForList.selectorChanged`, `__for`, and `ForList.listen`'s setup.

## 4. reactre-compat's known bugs

- **Spread props in a compiled list row: done.** @reactre/compat/compiler's free-name scan treated a name after `...` as a property access, so `rows.map((r) => <li {...extra}>{r}</li>)` hoisted a loop that was never passed `extra`. It threw a ReferenceError, or read the wrong binding. The scan now reads a spread's name as a variable, in props, objects, arrays and call arguments, and an element with a spread child (`{...xs}`) stays a jsx call, since a template cannot count its children.
- **`componentWillMount` next to `getSnapshotBeforeUpdate`: done.** On mount, the class runtime checked the class's static `getSnapshotBeforeUpdate` instead of the instance's method, so a class that defined it still got `componentWillMount`, which React skips. Fixed in `bab4928`; a will-method and its `UNSAFE_` twin now both run, the plain one first, as React calls them.

**Done when** each has a failing test first, then a fix, with the compatibility check still at 36 of 36 with classes. Both pass the unit tests and the browser scenarios "list rows that spread props and children" and "class legacy lifecycles", with every scenario matching React.

## 5. reactre's remaining speed

In the measured clicks, script is a small part of reactre's time: 1.3 of 18 ms for create, 1.0 of 17 for update, 0.4 of 9 for select, 12 of 195 for create10k, 6.3 of 12 for clear (most of it the native removal). The rest is the browser's style, layout and paint. So a change to the runtime's own work moves a click by tenths of a millisecond at most, below what `ab.ts` resolves at 8 rounds of 6. The next gains are in the DOM work a click causes, not in the JavaScript around it.

**Bundle size: done.** The correctness work of section 3 had grown the benchmark app's bundle from 6,871 bytes gzipped (0.0.2) to 7,773. Now each part comes only to an app that uses it (see @reactre/core's [README](../packages/core/README.md#what-an-app-ships)), and the benchmark app is 6,726. Ownership (0.3 KB) comes with `effect`, `memo`, slots, fragments, rows that hold components and `attach`. Rows that read several selector keys (0.16 KB) need `@reactre/core/features/selectors`, which the compiler imports when it sees two calls with arguments in a row. @reactre/core uses @reactre/dom's new `Prototype`, without `Template`'s blocks and marker checks (0.4 KB). What stays in every bundle, because it guards every app and has no hook to hang on: the effect re-run guard (about 0.1 KB), the linear batch queue, the list's record of its listeners and selectors for disposal, and the selector's unsubscribing of keys outside rows (a few dozen bytes together). An A/B against main, 8 rounds of 6 on the 6 default tests, remove, create10k and create-after, proved nothing faster or slower. Two marginal results there (update duration +0.4 ms, [0.0, 1.0], with script equal, and create10k script +0.1 ms, [0.0, 0.1]) did not reproduce at 12 rounds of 8: update +0.5 [−0.1, 1.0], and +0.3 [−0.4, 0.9] with style, layout and paint all equal; create10k script +0.0 [−0.0, 0.1].

Tried, and not kept (each an A/B against the size work, 8 rounds of 6, the same 9 tests; heap is `JSHeapUsedSize` after creating 10,000 rows and a forced GC, median of 5 fresh browsers):

- **Skip a row's reactive re-run when its holes read only the key.** The compiler marked a row whose reactive holes read the row only through the key's path (`isSelected(row.id)` with `key={(row) => row.id}`), and `update` skipped `refresh` for it. No test was faster: update script 0.9 against 1.0 ms, 95% interval −0.1 to 0.2; the duration +0.5 ms, −0.3 to 1.0. The 100 refreshes it skips per click cost too little next to the text writes. 10 bytes.
- **Keep the last values of a row's item holes**, after its reactive values in `dv`, instead of computing the old item's again on update. No test was faster: update script −0.1 ms, −0.2 to 0.0. It costs 8.1 bytes per row (167.4 to 175.5) and 32 bytes of bundle.
- **No `obs` field on rows**: the observer of a row that reads a signal kept in its `dv` array, at index `nd` (only rows with reactive holes can have one), so a row has six fields. No test moved: create10k script −0.0 ms, −0.1 to 0.3; clear +0.3, −0.3 to 0.6. Building `dv` by writing into an empty array, so the observer could go after the values, grew it to V8's 17-slot backing store: 227.6 bytes per row against 167.3. The field itself is 4 of those 167 bytes with pointer compression, about 2%, too little to see in create or clear. `sel` and `sk` stay: every benchmark row asks a selector, so a side table would be looked up on every selection.

## 6. Packages

- **Source maps: done.** Each rewrite that builds a compiled file, @reactre/compiler's, @reactre/compat/compiler's and the plugin's rename of oxc's helpers, puts a mark before every token it copies when a map is asked for; `@reactre/compiler/map` takes the marks out (leaving the code a compile without them prints, byte for byte) and turns them into a v3 map, and the plugin chains oxc's, the rename's and the compiler's maps with @jridgewell/remapping. `packages/plugin/test/sourcemap.test.ts` builds a reactre app and a compat app with Vite (`build.sourcemap`), Rollup, Rolldown, esbuild, webpack and Rspack, runs each bundle on the fake DOM, and maps the stacks of three errors (a component's throw as it renders, a `<For>` row's handler's, a compat row's handler's) to the line and column of their `throw` in the .tsx and .jsx; Vite's dev server serves the compiled module with its map inline. The plugin builds no map when the bundler asks for none. Left: Bun's plugins cannot return a map, so `Bun.build` maps a bundle to the compiled code; that needs Bun to take one from `onLoad`.
- **Fast Refresh: done.** @reactre/compat's development build (`dist/dev`, the `development` export condition) registers with react-refresh through `__REACT_DEVTOOLS_GLOBAL_HOOK__` and implements its `scheduleRefresh`, `setRefreshHandler` and `scheduleRoot`, as react-reconciler's ReactFiberHotReloading does: an edit renders the component again in place with its family's latest code, keeping its state, and a component whose hooks changed, or a class, mounts anew. The production builds strip that code, so they are byte for byte as before. `packages/plugin/test/refresh.test.ts` proves it on Vite's dev server with @vitejs/plugin-react, in headless Chrome: a click, an edit to the text (the count kept, no reload), then an edit to the hook (mounted anew). The docs now set up the plugin. Left: React Refresh integrations for other bundlers (webpack's, Rspack's) speak the same protocol but are untested.
