# @reactre/state v2: the spec the parallel work follows

Written 2026-11-10. Seven features, built at once by four agents in one checkout. This file is their shared design. The runtime contract between them is code: [`src/internal.ts`](../../packages/state/src/internal.ts). Read both before you change anything.

The features:

- nested states;
- parallel states;
- history;
- child actors;
- durable execution;
- timers that survive a restore;
- runtime payload validation;
- a codemod from XState to @reactre/state.

## Rules every agent follows

- **Bun and TypeScript only.** No `.js` files, no Node, npm, npx or tsc. Type-check with `bun check -p plans/state/tsconfig.json` and `bun check -p plans/state/test/tsconfig.json`. Test with `bun test plans/state/test/<file>`.
- **Edit files with the Write and Edit tools only.** Never sed, echo, heredocs or scripts. Never `rm -rf`: it is blocked. Put scratch files in your scratchpad, or under a gitignored `out/` folder.
- **No new dependencies, and no new tools or runtimes.** Write a Standard Schema object by hand in tests; the spec is designed to be copied. Don't touch `bun.lock` or the root `package.json`.
- **No commits, no pushes, no branches.** Leave everything uncommitted.
- **Own only your files** (listed per agent below). Other agents are editing theirs in the same checkout at the same time.
  - If `bun check` reports errors only in files you don't own, they are someone else's work in progress. Don't fix them; check your own files and re-run later.
  - `src/internal.ts` belongs to the core agent and changes only by adding: a new optional field, or a new type. If you need a change, say so in your final report and work around it meanwhile.
- **Two layers, never overlapping.** Everything a type can express is a type error in `src/index.ts`'s type layer, pinned in `test/mistakes.ts` with `@ts-expect-error` and, for graph problems, with an exact `Equal` on the message.
  - The compiler (`compiler/index.ts`) reports only what types can't see: purity, casts, `!` and suppressions, runtime keys, and what codegen needs written in place.
  - `test/compiler.test.ts`'s audit fails if a compiler case is also a type error.
- **Opt-in costs nothing.** A machine that doesn't use a feature ships none of its bytes.
  - Every feature's runtime is its own module, imported only by compiled code whose machine uses it (or by the app, for `persist`, `durable` and `child`).
  - A missing opt-in throws a `StateError` whose message names what to add.
  - The bars: esbuild, gzipped, the whole app bundle.
    - `test/fixtures/door-app.ts` at 700 bytes or less (it is 743 now, from 689 before the contract).
    - `test/fixtures/job-app.ts` at 1,000 bytes or less (1,445 now, from 940).
  - `test/bundlers.test.ts` prints both sizes.
- **Every message is the fix.** Type errors and runtime errors say what to change, in words a model can act on without reading the library. Runtime errors are `StateError(code, message)`. Codes S0–S4 exist; new ones are listed below.
- **Strictest TypeScript.** `src/`, `compiler/` and `plugin/` are checked with `tsconfig.strict.json`, and tests with the repository's settings. No `any`, and no casts in library code unless a comment says why.

## The authoring API

Everything below is what a model writes. The types check it, and the compiler compiles it.

### Nested states

A leaf's name may have dots. Every proper prefix of a leaf's name is a **parent**. Parents have no data; the data lives in leaves.

```ts
const editor = setup({
  states: {
    idle: types<{}>(),
    "edit.draft": types<{ text: string }>(),
    "edit.review": types<{ text: string; by: string }>(),
    sent: types<{ text: string }>(),
  },
  events: { open: types<{}>(), submit: types<{ by: string }>(), revise: types<{}>(), cancel: types<{}>(), approve: types<{}>() },
});

const machine = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    // A parent: optional. Its handlers, task, timers and children apply to every leaf under it.
    edit: { on: { cancel: ({ to }) => to("idle") } },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": {
      on: {
        revise: ({ data, to }) => to("edit.draft", { text: data.text }),
        approve: ({ data, to }) => to("sent", { text: data.text }),
      },
    },
    sent: { final: true },
  },
});
```

- **Targets are leaves.** `to("edit")` is a type error: say which leaf, with its data.
- **Handler arguments.** Every handler gets `{ state, data, event, to, back }`.
  - In a leaf's handler, `state` is that leaf's name.
  - In a parent's handler, `{ state, data }` is the union over the leaves under it. So `if (state === "edit.review") data.by` narrows, even when destructured; build the union of whole argument objects so TS 4.6+ narrows the destructured `state` and `data`.
  - Timers' and tasks' `error` handlers get the same pair, read when they fire.
- **Bubbling.** An event goes to the leaf's handler, then its parents' handlers, innermost first. The first handler found decides.
  - It returns `null`: the event bubbles on to the next parent.
  - No handler in the chain accepts the event: the result is `declined` when one returned `null`, otherwise `unhandled`.
- **Entering and exiting.** A move from leaf A to leaf B exits A and the parents that aren't also B's, innermost first. Then it enters B's new parents and B, outermost first.
  - A move to the same leaf (`to(state, newData)`) stays: its task, timers and children keep running, and their runners get `update`. This is new: before, every move re-entered.
  - Parents under both stay, so a parent's task keeps running while its leaves change.
- **The snapshot is unchanged.** It stays `{ state: leaf, data, version }`. `isIn(snapshot, "edit")` is a type guard that narrows to the leaves under `edit`, exported from `@reactre/state`.
- **New type errors**, each one pinned in `test/mistakes.ts`:
  - A setup state that is also a parent (`"edit"` beside `"edit.draft"`).
  - A machine state key that is neither a leaf nor a parent.
  - A target that is a parent.
  - A parent marked `final`.
  - The graph checks over the hierarchy:
    - a leaf's outs include its parents' outs;
    - reachability is over leaves;
    - an event handled by a parent counts as handled.

### History

`back(parent, fallback)` goes to the leaf (with its data) that `parent` held when it was last left, or to `fallback` (a `to(...)`) if it never was. It is deep history: the last leaf, whole.

```ts
offline: { on: { reconnect: ({ to, back }) => back("player", to("player.stopped")) } },
```

- **Snapshot.** Only a machine that uses `back` keeps `history: { player: { state, data } }` in its snapshot. The compiler lists those parents in `h`, and the step records a tracked parent's leaf whenever the parent is exited.
  - History is part of the snapshot: `transition` keeps it, `restoreActor` restores it, and it is JSON.
- **Types.** `back(P, fb)` returns `Next<LeavesUnder<P> | Target<fb>>`, so the graph checks count every leaf under P as reachable from there. `P` must be a parent: type error otherwise.
- **Shallow history** isn't offered: with data per leaf, re-entering a parent's first leaf would need data from nowhere. Document why.
- **Compiled form:** `({ b: parent, t: fallbackStep })` (see `__Back`); a `to` compiles to the snapshot it makes, `({ state, data, version })` (`__To`).

### Parallel states

A parallel node's regions are its direct children. Declare the parallel nodes in setup, since the snapshot's type depends on them:

```ts
const player = setup({
  parallel: ["on"],
  states: {
    off: types<{}>(),
    "on.playback.stopped": types<{}>(),
    "on.playback.playing": types<{ track: string }>(),
    "on.volume.audible": types<{ level: number }>(),
    "on.volume.muted": types<{ level: number }>(),
  },
  events: { power: types<{}>(), play: types<{ track: string }>(), stop: types<{}>(), mute: types<{}>(), unmute: types<{}>() },
});

player.machine({
  start: ({ to }) => to("off"),
  states: {
    off: { on: { power: ({ to }) => to("on", { playback: to("on.playback.stopped"), volume: to("on.volume.audible", { level: 5 }) }) } },
    on: { on: { power: ({ to }) => to("off") } },
    "on.playback.stopped": { on: { play: ({ event, to }) => to("on.playback.playing", { track: event.track }) } },
    "on.playback.playing": { on: { stop: ({ to }) => to("on.playback.stopped") } },
    "on.volume.audible": { on: { mute: ({ data, to }) => to("on.volume.muted", { level: data.level }) } },
    "on.volume.muted": { on: { unmute: ({ data, to }) => to("on.volume.audible", { level: data.level }) } },
  },
});
```

- **Entering.** `to(P, { region: to(leafInRegion, data), ... })` enters a parallel node, with one step per region, all regions required. It is the only way in: targeting a region's leaf from outside P is a type error that names this form.
- **Snapshot.** Inside P, the snapshot is `{ state: "on", data: { playback: { state, data }, volume: { state, data } }, version }`. `Snapshot<D>` has a variant per parallel node, with each region's union of `{ state, data }`, so `s.state === "on"` narrows `s.data.playback`.
- **Moving.** Inside P, `to(leaf)` for a leaf in one of P's regions moves that region only; the other regions stay.
- **Events.** An event goes to each region's chain (leaf, then its parents up to the region), in region order. Each region that accepts moves.
  - If a region's step leaves P, it wins, and the rest are dropped.
  - If no region accepts, the event goes on to P and P's parents.
  - The result is `ok` if any region moved.
- **Finals.** `final: true` on a region's leaf ends the region, not the actor. When every region is in a final leaf, P's `done: ({ data, to }) => to(...)` decides where to go; `data` is the regions.
  - It is a type error when every region can end but P has no `done`.
  - It is also a type error when P has a `done` but some region can't end.
- **Not supported** (a type error naming the alternative): a parallel node inside another's region, and `back` to a parallel node's region. `back` to a parallel node itself keeps all its regions.
- **Compiled form:** `p: { on: ["playback", "volume"] }`, `n: { on: done }`. Each region step is compiled as a normal step inside the regions' record.

### Child actors

A node runs child actors while it is active. Each child is a compiled machine.

```ts
uploading: {
  children: {
    upload: {
      machine: uploadMachine,
      input: ({ data }) => ({ file: data.file }),
      done: ({ data, output, to }) => (output.state === "sent" ? to("uploaded", { url: output.data.url }) : to("failed", { reason: output.data.reason })),
      update: ({ data, child, to }) => to("uploading", { ...data, progress: child.state }),
    },
  },
},
```

- **Lifetime.** A child starts when its node is entered and stops when its node exits.
- **Handlers.** `done` runs when the child reaches a final state; `output` is the union of the child's final `{ state, data }`. `update` runs on each of the child's transitions and returns `to(...)` or `null`. Both are pure, and the compiler checks them like `on`.
- **Keyed collections.** `each: ({ data }) => data.files.map((f) => ({ key: f.id, input: { file: f } }))` replaces `input`. It is reconciled on entry and on every stay in the node: new keys start, and keys that are gone stop. `done` and `update` then also get `key`.
- **From outside.** `child(actor, "upload")` and `child(actor, "uploads", key)` from `@reactre/state/actors` return the child's typed `Actor`, or `undefined` when its node isn't active.
- **Persisting.** `persist(actor)` saves each child's persisted snapshot under the node's `run.c`, and restoring restores the children instead of starting them fresh.
- **Graph checks.**
  - `done` and `update` targets count as outs.
  - A child machine that can reach a final state with no `done` is a type error.
  - So is a `done` for a child that has no final state.
- **Compiled form:** `c: { [node]: { [name]: { m, i, d, u, k } } }`, with the runner `__actors` in `r`.

### Durable execution

`@reactre/state/durable` runs a machine on a host that journals: a workflow engine, a Durable Object, a queue worker. Its process can die and resume anywhere, with no side effect run twice.

```ts
import { durable } from "@reactre/state/durable";

const run = durable(machine, {
  now: () => host.now(),
  step: (id, fn) => host.step(id, fn), // run fn once per id; on replay, return the recorded result
  schedule: (id, at) => host.schedule(id, at), // a durable timer: the host calls run.fire(id) at `at`
  cancel: (id) => host.cancel(id),
  save: (snapshot) => host.save(snapshot), // after every transition
});
await run.start(input); // or: await run.resume(savedSnapshot)
await run.send({ type: "approve" }); // Result, like actor.send
await run.fire(timerId);
```

- **Ids are deterministic:** node name, entry count, and kind. The entry counter is part of the durable snapshot, so a replay after a crash asks the host for the same ids.
- **Tasks** run through `host.step`. **Timers** are absolute deadlines through `host.schedule`. **Leaving a node** cancels its timers, and its task's late result is dropped.
- **It reuses the pure core** (`__step`, `__snap`, `run.ts`'s `__nodes` and `__changes`, the compiled `t` and `a`). It does not use the in-process tasks runner.
- **Child actors on a durable host** are out of scope for now: `durable` throws `StateError("S9", …)` naming that for a machine with `c`.

### Timers that survive a restore

- **Saving.** `persist(actor)` from `@reactre/state/persist` returns the snapshot plus `run`, what each running node saved. The tasks runner saves each pending timer's absolute deadline (`now() + ms` at entry).
- **Restoring.** `restoreActor(machine, persisted, { now })` schedules the remaining time, `max(0, deadline - now())`. An overdue timer fires right away.
- **No `run` part** (a plain snapshot): the timers start fresh, as now.
- **A task** restarts on restore, as now.
- **The clock:** `createActor(machine, { now })` and `restoreActor(..., { now })`, so tests use a fake clock.

### Runtime payload validation

- **Where schemas go.** Any value in setup's `states`, `events`, `internal` or `input` may be a [Standard Schema](https://standardschema.dev) v1 object (zod, valibot, arktype…) instead of `types<T>()`.
  - Types: the payload or data type is the schema's output. `send` takes the schema's input.
  - The JSON checks apply to the output.
- **What is validated, and when:**
  - Sent events and internal events (a task's result): reason `"invalid"` with `issues`. An invalid internal event goes to the task's `error` handler as `StateError("S6", …)`.
  - `createActor` input: throws `S5`, listing the issues.
  - `restoreActor`'s data, against the state's schema: throws `S7`.
- **Synchronous schemas only.** One that returns a Promise throws `S8`, naming the fix.
- **Compiled form.** The compiler keeps each schema's expression, as written, in `s` (a type can't hold a runtime value). It also sets `x: __validate` and `y: __validated(...)` from `@reactre/state/validate`, only when some schema is present.
  - A machine with schemas and a hierarchy gets `y: __validated(__nested)`.
  - With schemas only, `y: __validated()` wraps the flat step.

### The codemod

`bun plans/state/codemod/index.ts <files…> [--write]` rewrites XState v5 and v6 machines (`createMachine`, `setup(...).createMachine`) as @reactre/state.

- **Output.** It writes the result next to the source as `<name>.state.ts` (or in place with `--write`). For each file it prints a report of what it converted and what it couldn't, with line numbers and the fix.
- **Never silent.** Whatever it can't convert stays in the output as a `// TODO(@reactre/state): …` comment at that spot, and in the report.
- **What maps to what:**

| XState                                                                | @reactre/state                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context` (shared)                                                    | Each leaf's data is the context type: `types<Context>()` from `types: { context: {} as T }`, `schemas.context` or the literal's inferred fields. The report says to narrow per state. |
| `states` nesting, `initial`                                           | dotted leaves; `to(parent.initial...)` resolved to the initial leaf                                                                                                                   |
| `type: "parallel"`                                                    | `parallel: [...]` and `to(P, { region: ... })`                                                                                                                                        |
| `type: "history"`                                                     | `back(parent, to(defaultTarget))`                                                                                                                                                     |
| `type: "final"`                                                       | `final: true`                                                                                                                                                                         |
| `on` string, object, function (v6), `guard`/`cond`, `actions: assign` | a function returning `to(...)` or `null`; guards become conditions; `assign` becomes the next data                                                                                    |
| `after` (numbers, `"5s"`, ISO durations)                              | `after: { "5s": ... }`                                                                                                                                                                |
| `invoke` of `fromPromise` / `createAsyncLogic`                        | `task: { run, error }`, with `onDone` becoming an internal event                                                                                                                      |
| `invoke` of a machine                                                 | `children`                                                                                                                                                                            |
| `entry`, `exit`, `always`, `enq` effects, `spawn`, `sendTo`           | TODO comments with the closest form                                                                                                                                                   |

- **Done means:** the output passes `bun check` and the compiler, and replays the same state sequence as the XState original (run with `xstate6` from the dev dependencies) for every fixture.

## The compiled table and the runtime contract

See `src/internal.ts`; it is the source of truth.

- **Core.** `src/index.ts` holds the flat step, the snapshot and the actor.
- **Hooks.** Everything else is a hook the compiler puts in the table:
  - `g`, `y` (the hierarchy, from `src/nested.ts`);
  - `r` (`__run([...runners])`, from `src/run.ts`, with `__tasks` and `__actors`);
  - `x`, `s`, `y` (validation, from `src/validate.ts`).

Compiled code imports these names, and the compiler emits exactly these:

| Import                                                              | When                                 |
| ------------------------------------------------------------------- | ------------------------------------ |
| `import { __run } from "@reactre/state/run"`                        | a task, a timer or a child           |
| `import { __tasks } from "@reactre/state/tasks"`                    | a task or a timer                    |
| `import { __actors } from "@reactre/state/actors"`                  | a child                              |
| `import { __nested } from "@reactre/state/nested"`                  | a parent, a parallel node, or `back` |
| `import { __validate, __validated } from "@reactre/state/validate"` | a schema                             |

`__nested` is `{ g: __Graph, y: __StepHook }` (or two exports, the core agent's choice, as long as the compiler and the module agree).

The app imports these:

- `persist` from `@reactre/state/persist`;
- `child` from `@reactre/state/actors`;
- `durable` from `@reactre/state/durable`.

New `StateError` codes:

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| S5   | invalid input                                       |
| S6   | invalid internal event, given to the task's `error` |
| S7   | invalid restored data                               |
| S8   | async schema                                        |
| S9   | children on a durable host                          |
| S10+ | free; say which you took in your report             |

## Who owns what

| Agent       | Owns (writes)                                                                                                                                                                                                                                                                                                                                             | Reads only                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **core**    | `src/index.ts`, `src/internal.ts` (additive), `src/nested.ts`, `src/run.ts`, `src/signals.ts` (was `src/reactre.ts`), `src/dev.ts`, `compiler/index.ts`, `plugin/*`, `test/mistakes.ts`, `test/explain.ts`, `test/compiler.test.ts`, `test/actor.test.ts`, `test/bundlers.test.ts`, new `test/nested.test.ts`, `test/fixtures/*` except those named below | everything                                        |
| **runtime** | `src/tasks.ts`, `src/persist.ts`, `src/durable.ts`, `test/tasks.test.ts`, `test/persist.test.ts`, `test/durable.test.ts`                                                                                                                                                                                                                                  | `src/internal.ts`, `src/index.ts`, `src/run.ts`   |
| **actors**  | `src/actors.ts`, `src/validate.ts`, `test/actors.test.ts`, `test/validate.test.ts`, `test/fixtures/standard-schema.ts`                                                                                                                                                                                                                                    | `src/internal.ts`, `src/index.ts`, `src/run.ts`   |
| **codemod** | `codemod/**`, `test/codemod.test.ts`, `test/codemod/**`                                                                                                                                                                                                                                                                                                   | everything; `compare/xstate/*` as XState examples |

- **Agents without the compiler.** The runtime and actors agents test their modules against compiled tables written by hand (typed `__Compiled`), run through `__run` or `createActor` from `src/index.ts`. They don't wait for the compiler.
- **The core agent wires it all up.** It writes the types and the compiler output for every feature (children, schemas, `back`, parallel), so the modules plug in when they land.
- **The codemod agent** targets the API in this file. Its flat cases can be checked end to end now; the nested, parallel, history and children cases check once the core lands. Write those tests now, and say in the report which ones wait on the core.
- **`package.json` exports** already list every new module: `./run`, `./nested`, `./actors`, `./validate`, `./persist`, `./durable`, `./codemod`. A module that doesn't exist yet fails only when imported.
