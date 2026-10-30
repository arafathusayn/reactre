# Opt-in time slicing for @reactre/compat (item 33)

Status: built (2026-10-30). Time slicing ships as its own package, `@reactre/full-compat`; see "As built" at the end for where the code differs from this plan.

## 1. What React 19.3.1 does

Source: `node_modules/.bun/react-dom@19.3.1+0441d6f8f57aca1e/node_modules/react-dom/cjs/react-dom-client.production.js` (line numbers below) and `scheduler@0.28.0/cjs/scheduler.production.js`.

- **Which renders slice.** `performWorkOnRoot` (12069) slices when the lanes hold no sync or blocking lane (`0 === (lanes & 127)`), none of them expired, and `forceSync` is false. That is transition, deferred-value and retry lanes. Urgent renders (`renderRootSync`) never yield.
- **The unit and the yield.** `workLoopConcurrentByScheduler` (12702) runs `performUnitOfWork` once per fiber while `!shouldYield()`. The scheduler's `shouldYieldToHost` (scheduler 114) yields once `unstable_now() - startTime >= frameInterval`, where `frameInterval = 5` ms and `startTime` is set when the scheduler task starts. `unstable_now` is `performance.now()`, read through the `performance` object captured at load (scheduler 61). The next slice is a new macrotask: `setImmediate` where it exists (Bun, Node), else `MessageChannel`, else `setTimeout(0)` (scheduler 197).
- **Nothing reaches the DOM until the commit.** A yielded render keeps its work-in-progress tree (`workInProgress`, `workInProgressRootRenderLanes`). The DOM, refs and committed state stay as they were, so code that runs between slices (timers, events, microtasks) sees the last commit.
- **Resuming.** `renderRootConcurrent` (12586) calls `prepareFreshStack` (12424) only when the root or the lanes changed (`workInProgressRoot !== root || workInProgressRootRenderLanes !== lanes`). Otherwise it goes on from `workInProgress`.
- **An urgent update interrupts.** `scheduleUpdateOnFiber` (12041) marks the lane and calls `ensureRootIsScheduled`. `scheduleTaskForRootDuringMicrotask` (13483) calls `getNextLanes(root, wipLanes)` (750). That function keeps the work-in-progress lanes unless the new lane is of higher priority (a lower bit). A sync update is higher, so it renders now through `renderRootSync`. Its lanes differ, so `prepareFreshStack` throws the transition's tree away. The transition then renders again from the root in a later task, with every component called again.
- **Another transition does not interrupt.** A new transition gets the next lane in the cycle (`requestTransitionLane`, 13575), which is a higher bit, so `getNextLanes` keeps the lanes in progress. Updates made between slices go to `workInProgressRootInterleavedUpdatedLanes`. They are left for a render after this one commits.
- **Starvation guard.** `computeExpirationTime` (814) gives transition lanes `now + 5000`. Once that time passes, the lane is in `expiredLanes`, `shouldTimeSlice` is false, and the rest renders synchronously.
- **Stores.** After a concurrent render, `isRenderConsistentWithExternalStores` (12346) checks the stores. If one moved, React renders again synchronously. Compat's `attempt(b, check)` already does this check.

## 2. What tests compare with React

All scenarios run through `same()` in `packages/compat/test/concurrent.test.ts`, in both libraries, with:

- **A fake clock.** `performance.now` is replaced by a counter for the test. Each list item's render adds 3 ms, and nothing else moves the clock. Both libraries then yield at the same component, after two items (6 ms ≥ 5 ms). Wall-clock time never decides anything.
- **Observation points.** These are microtasks queued from inside a render. A microtask queued in slice _n_ runs after that slice's task ends and before the next slice. Without slicing, it runs after the commit. So the observation shows exactly whether the render yielded, whatever the macrotask mechanism.

Behaviours compared:

1. **T1 (yield).** A transition that renders 6 items yields. The DOM read at the observation point is the old one, and no layout effect has run yet. The final DOM and the full render/effect log match React's.
2. **T2 (interrupt and restart).** At the first yield, the observation point dispatches a `click` that sets urgent state. The urgent render commits first. The transition then renders again from its first item, and the log matches React's: items 1 and 2 are called again.
3. **T3 (another transition between slices).** It does not restart the one in progress. It renders after that one commits, as its own render.
4. **T4 (Suspense across slices).** An item past the first yield suspends where content shows. The transition waits, and the screen stays. It renders again once the data settles.
5. **T5 (`useSyncExternalStore`).** A store that moves between slices makes the render go again before it commits.
6. **T6 (expiry).** A transition kept from finishing past 5000 fake ms finishes without yielding.
7. **T7 (`getSnapshotBeforeUpdate` and refs).** These read the DOM of the last commit at the snapshot point, after the last slice.
8. **T8 (`<ViewTransition>`).** A sliced render that changes one commits through the view transition, as an unsliced one does.
9. **T9 (off by default).** Without the opt-in, T1's observation point sees the committed new DOM, the current behaviour.

## 3. Design

### How compat yields without a half-written DOM

Compat writes the DOM while it renders, recursively. It cannot keep a separate work-in-progress tree. It already has what a pause needs, the held render (`Pending`) built for reveals and view transitions:

- `watchRoots` saves the roots' fibers (`sv`, `hv`, `fv`) and records the DOM with a `MutationObserver`.
- `undoWatched(w, redo)` puts the DOM and the fibers back and keeps a redo list.
- `applyPending` (`redoDom`, `restoreFields`, `restoreFibers`) makes the render again.

A sliced attempt works like this:

1. It renders under the watch, as `attempt` does now. Before each component render, it checks the deadline: `performance.now() - sliceStart >= 5`.
2. **At the deadline**, the component is not rendered. It is pushed, with its new element and whether it mounts, onto the slice's to-do list in tree order, and the recursion unwinds. Every later component in this slice is pushed the same way, so the unwinding is quick.
3. **The pause.** The DOM and the fibers are undone into a `Pending`-like record with a redo list, the held user code (`Held`), the `skipped` map, the effect queues and the to-do list. The next slice is posted with `afterPaint`. Between slices, the DOM and fibers are exactly the last commit's.
4. **The next slice.** It redoes the DOM and fibers, watches again, and renders the to-do list from the front. Deferrals made during this slice go to the front, in order, so the order stays depth-first. Then it pauses again or, when the list is empty, finishes through the existing tail of `attempt`: the store check, the reveal throttle, the view-transition plan, commit or wait.
5. **Interrupt.** An urgent update (`transition === null`) while a slice is paused drops the sliced render. The fibers and DOM are already back. The batch's updates go back through `pend`, it is put back at the front of `batches`, and it renders again from the start (React's `prepareFreshStack`). This is the existing transition branch of `dropPending`. A transition update does not drop it. It makes its own batch, which `runLanes` reaches after this one commits.
6. **Expiry.** The batch records when its first slice started. Once 5000 ms have passed, the deadline check is off and the rest renders in one go.
7. **No `MutationObserver` or a root that hydrates.** There is no watch, so it does not slice. It renders whole, as now.

### Where the deadline check goes (the cost question)

The check has to run before each component render, which means in `update()` or `child()` on the render path. This file's own A/B history (top of `compat-remaining.md`) shows that one branch in `runFunc`, `reconcile` or `create` costs 2–4% on the JS framework benchmark. So the check must not be in the default, core or jfb builds. Options considered:

- **(A) A runtime check in core** (`if (slicer !== null && …)`). It is simple, but every build pays 2–4%, which the rules forbid. Rejected.
- **(B) Yield only between the components a transition updated** (the units of `attempt`'s queue). There is no check in the render path; the change is in `attempt`, which only `__installConcurrent` reaches, so the core and jfb builds tree-shake it. But the usual transition (one `setState` above a big list) is one unit and never yields. Low value.
- **(C) A second copy of the render path** inside `core.ts` with the check, reached only through `__installTimeSlicing` and tree-shaken elsewhere. It duplicates thousands of lines, and class components (rendered by `features/classes.ts` through `ClassCore`) would call back into the unsliced copy. Rejected: too much code to keep in sync.
- **(F) The check compiled in only for a separate package, `@reactre/full-compat`. Chosen by the user on 2026-10-30.**
  - `@reactre/compat` stays as it is. `@reactre/full-compat` is compat built with the check compiled in and time slicing installed. It is the home for behaviour that costs speed.
  - **The check.** In the source it is `if (SLICING && slicer !== null && performance.now() >= deadline)`, with `const SLICING = globalThis.__REACTRE_SLICING__ === true`.
  - **Compat's builds.** Every `@reactre/compat` build (`dist/*`, the size build and the jfb build) defines `globalThis.__REACTRE_SLICING__=false`. The minifier then drops both the constant and the branch, so those builds stay byte-identical. This was checked on a scratch module: the output is the function without them. A `let` toggle is not folded, so the flag has to be a constant set at load.
  - **The package.** `packages/full-compat` builds compat's sources with the flag defined `true` and adds `features/timeSlicing.ts` to its entry. Its exports mirror compat's: `.`, `./core`, `./features/*`, `./server*`, `./static` and `./api`. Its `bun` condition points at `src/index.ts`, which sets the flag in a module imported first.
  - **How a user turns it on.** Alias `react` and `react-dom` to `@reactre/full-compat` instead of `@reactre/compat`. With `@reactre/plugin`, the option `compat.package: "@reactre/full-compat"` makes the entry build on that package. It is off unless chosen.
  - **In tests.** The test preload sets the flag. Bun's test runner shares one module cache across files (checked), so the whole suite shares one core, and that core has the check compiled in. The check does nothing while `slicer` is null. The slicing tests install the slicer and remove it afterwards with an internal `__installTimeSlicing(null)`, so coverage stays one run.

Rejected outright:

- **Generators or an explicit work stack for the render.** This rewrites the render loop and adds cost to every build.
- **Rendering into a detached copy of the DOM.** Compat's fibers point at live nodes.

## 4. Files

- `packages/compat/src/core.ts`:
  - the `SLICING` constant;
  - the deadline check in `update()` and `child()`;
  - the slice to-do list, pause and resume around `attempt`;
  - the `dropPending` change for urgent-only drops;
  - `__installTimeSlicing`.
- `packages/compat/src/features/timeSlicing.ts`: a new module that installs the slicer and exports `unstable_setFrameInterval(ms)` (tests, and as `scheduler.unstable_forceFrameRate`).
- `packages/full-compat/`: a new package with its `package.json`, a `src/index.ts` that sets the flag, a build of compat's sources with the flag on, and a README.
- `packages/compat/package.json`: the build defines the flag as `false`, and `features/timeSlicing.ts` joins the build list.
- `packages/plugin/src/*` and `packages/plugin/README.md`: `compat.package`.
- `packages/compat/test/concurrent.test.ts`: T1–T8. `client.test.ts`: T9.
- `packages/compat/test/size.test.ts`: the check that default, core and jfb are unchanged; a budget for `full-compat`.
- `packages/compat/README.md`, the root `README.md`, `plans/compat-remaining.md` row 33.

## 5. Done when

- T1–T9 pass in both libraries and match React.
- Coverage stays at 100%, and `ci-local.sh` passes on the exact commit.
- `dist/core.js`, the full build and the jfb build are byte-identical to `main` (`cmp` in CI).
- The A/B shows the jfb build tied with an A/A control. This is expected, since its bytes are identical.
- Row 33 is closed in `compat-remaining.md`, and both READMEs document the opt-in.

## 6. Critique (Phase 2)

A hostile review of the design above, and what answers each point.

| #   | Attack                                                                                                                                                                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Half-written DOM.** A timer or event between slices sees part of the new DOM.                                                                                                        | Each pause undoes the DOM and fibers before the task ends (step 3), and the redo happens at the start of the next slice, inside one task. Nothing else can run in between. T1 and T2 read the DOM at the pause.                                                                                                                                                                                                                                                               |
| 2   | **Half-written DOM, part 2.** A `MutationObserver` the app owns sees the undo and redo of every slice.                                                                                 | This is true, and it is the same for the held reveal today. It is documented as a difference: the app's observers see changes React never makes. It cannot be avoided without a separate tree.                                                                                                                                                                                                                                                                                |
| 3   | **Undo cost grows with each slice.** Undo and redo each replay every DOM change so far, which is O(slices × changes).                                                                  | New subtrees are built detached and inserted with one `insertBefore`, so the records stay few. The cost is paid only in the opt-in build, and only for transitions that run past 5 ms. A benchmark in the sliced build reports it, without blocking.                                                                                                                                                                                                                          |
| 4   | **Lanes.** A batch that is paused is still in `batches`, so `batchNow` could join it, or `runLanes` could start it twice.                                                              | It is taken out of `batches` while it is sliced, and `laneTask` stays set until it finishes. `runLanes` skips work while a sliced batch is paused, and urgent work flushes first. T3 covers it.                                                                                                                                                                                                                                                                               |
| 5   | **Undo state.** `holding`, `skipped`, `laneRender`, `flushing` and `unwinding` are reset in `attempt`'s `finally`.                                                                     | The pause saves them into the slice record, and the resume sets them again. `flushing` stays false between slices, so urgent work can flush.                                                                                                                                                                                                                                                                                                                                  |
| 6   | **Suspense waits.** A promise thrown in slice 2 has to see boundaries from slice 1.                                                                                                    | `skipped` and `at.bad` survive the pause (point 5). T4 covers it.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | **View transitions.** `plan()` reads `w.records`, but the records are split across slices.                                                                                             | Each slice's records are appended to one list. The undo uses the whole list, then `plan()` gets the merged list. T8 covers it.                                                                                                                                                                                                                                                                                                                                                |
| 8   | **`getSnapshotBeforeUpdate` deferral.** `snapshotLater` is queued on `Held.sn` and must be taken after the last slice.                                                                 | `Held` lives in the slice record, and `takeSnapshots(at)` runs in the tail, after the last slice. T7 covers it.                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **Effects.** Layout and passive queues filled by slice 1 could be flushed by an urgent render that runs between slices.                                                                | They are kept in the record, as `Pending.q` does today, and restored at resume.                                                                                                                                                                                                                                                                                                                                                                                               |
| 10  | **The check leaks into builds.** `SLICING` is not folded, and the branch stays in `dist/core.js` or jfb.                                                                               | A CI step `cmp`s the default, core and jfb outputs against builds made without the change. The size test pins them.                                                                                                                                                                                                                                                                                                                                                           |
| 11  | **Flaky tests.** Real slices take real time, and a 1 ms timer may or may not fire.                                                                                                     | No test relies on time. The fake clock decides where to yield, and the observation points are microtasks queued from inside a render (section 2). Other test files keep `SLICING` off, or run in a separate process.                                                                                                                                                                                                                                                          |
| 12  | **Observable differences: yield points.** React checks before every fiber, compat before every component.                                                                              | Host fibers run no user code, and the clock only moves in user code, so the yields fall at the same component. A component that takes the clock past the deadline still has its host children rendered by compat, but React's are not. No user code can see this before the commit.                                                                                                                                                                                           |
| 13  | **Observable differences: macrotask kind.** React posts slices with `setImmediate` in Bun and Node, `MessageChannel` in browsers. Compat uses `afterPaint`, which is `MessageChannel`. | Ordering against `setImmediate` callbacks could differ in Node and Bun only, never in a browser. It is documented. The tests do not depend on it (point 11).                                                                                                                                                                                                                                                                                                                  |
| 14  | **Observable differences: restart cost.** Compat's restart calls the components again, as React does.                                                                                  | This is a match, not a difference. T2 asserts it.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 15  | **Deferred mounts.** A component deferred at mount has no DOM until its slice. Can `place()` handle a fiber that renders later?                                                        | The resume calls `rerender`'s placing path with `mount = true` (a new `run(f, null, true)` call), then `place(host)` through `STRUCT`, as an update that mounts children does today. It needs a test with a deferred first child, a deferred middle child and a deferred last child.                                                                                                                                                                                          |
| 16  | **Context and `cur`.** A deferred component needs the context values of its parents, which were set during the recursion.                                                              | Compat's `readContext` walks up the fibers, not a stack, so a deferred render reads the same providers. This needs checking for `curHost` and `curNs`: `rerender` already recomputes both from the fiber's parents.                                                                                                                                                                                                                                                           |
| 17  | **Class components.** `features/classes.ts` renders through `ClassCore`.                                                                                                               | The deadline check sits in `update()` and `child()`, which classes reach through the same `reconcile`, so their children are sliced too.                                                                                                                                                                                                                                                                                                                                      |
| 18  | Default build byte-identical only if the default entry is built with the check folded away.                                                                                            | Proven on a scratch module: `bun build --minify --define 'globalThis.__REACTRE_SLICING__=false'` removes the branch and the constant entirely (output `function r(n){return n*2}`); without the define both stay. And Bun's test runner shares one module cache across files (a counter module imported by two test files read 1 then 2), so the slicing tests run as their own `bun test` invocation with the flag set in a preload, in CI and ci-local.sh, coverage merged. |

## Decision

The open point was whether a second build of core is acceptable. The user chose a separate package, `@reactre/full-compat`. Compat's own builds are unchanged, and only the package that slices carries the check.

## As built

- The switch is `slicing.on` in `packages/compat/src/slicing.ts`, which `features/timeSlicing.ts` sets. There is no `unstable_setFrameInterval`: the frame is React's 5 ms.
- The code is compiled in by `globalThis.__REACTRE_SLICING__`, read where it is used: a module-level constant folds only in a one-module build. Compat's builds, the jfb app and the react-compat harness define it `false`; full-compat's build defines it `true`, and its sources set it under Bun.
- Bun's minifier names symbols by use count, dead code included, so compat's builds keep their minified sizes but gzip moves by a few bytes (jfb +2 B, core +31 B, full +26 B). Byte-identical output is not reachable this way. The user accepted this trade-off on 2026-10-30, after the jfb A/B (with an A/A control) came out a tie; the alternative, patching the slicing code into core.ts at build time, was turned down.
- Units of work: a deferred component, a queued fiber, a parent's effects and its class callbacks and refs (`laterShown`), so effects and `getSnapshotBeforeUpdate` keep React's order across slices.
- A render error's retry renders whole, without slicing, as React's synchronous retry does.
- Found while testing: after a transition's render error React renders the whole root again, compat only the component (`plans/compat-remaining.md` row 41).
- `@reactre/plugin` takes `compat.package: "@reactre/full-compat"`.
