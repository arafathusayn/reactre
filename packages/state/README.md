# @reactre/state: a state machine library that LLMs write correctly

Status: a package in `packages/state/`, not yet published. The plans it was built from are in [`plans/state/`](../../plans/state).

Two layers check a machine, and neither repeats the other:

- **The type checker** (`bun check`) checks everything a type can express. That covers targets, exact data (through spreads and variables too), payloads, JSON-only contracts, and the whole graph.
- **A compiler**, run by the bundler through an [unplugin](https://unplugin.unjs.io) plugin, checks only what types can't see: pure transitions, casts and suppressions that hide a broken contract, and data whose runtime keys could differ from its type's. A test fails if any compiler rule is also a type error.

The compiler then replaces the machine with a plain table, so the shipped runtime is only the actor: **726 bytes gzipped** for a whole app with a machine (esbuild).

It has every feature of XState v6 beta except its CLI and visual editor. Each feature beyond the core is an opt-in, listed in setup's `use`. The list:

- nested, parallel and history states;
- final output, choice, route, eventless and reentering transitions, wildcards, tags;
- `entry`/`exit` and `enq` effects, emitted events, named actions and guards, named delays, timeouts;
- child machines and actor logic, spawning, systems, inspection;
- Standard Schema validation, persistence with migrations, durable execution;
- definitions as JSON, SCXML, graph paths, model-based testing, React.

A machine that doesn't use a feature ships none of its bytes, and using one without its opt-in is a type error naming the import. A codemod converts XState v4, v5 and v6 machines, and what the Stately visual editor exports.

Measured against ten TypeScript state machine libraries, XState v6 beta among them ([`compare/`](compare/README.md)), it is the fastest in every case each library has (an actor's send 1.6× the next library's and 199× XState v6's; a pure transition 4.8× `xstate/fsm`'s; creating an actor 1.8× the next), ships the fewest bytes for every app (1.4–1.6× fewer than the next, 28–40× fewer than XState v6), and catches 516 distinct mistakes AI agents make, each pinned by a test, before the program runs ([`compare/MISTAKES.md`](compare/MISTAKES.md)). Made in every library's port of the same apps, it catches all 254 cases (of 256) it can express before the program runs (100%), against 17–35% for the others; of the 84 cases every library can express, 84, where the next catches 25. That report also lists where the others win.

How the features were built is in [`SPEC.md`](../../plans/state/SPEC.md) (v2: one contract, four parallel agents), [`PARITY.md`](../../plans/state/PARITY.md) (v3: every feature opt-in, and parity with XState v6) and [`V4.md`](../../plans/state/V4.md) (v4: speed, safety and the rivals). Where each file lives is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## The goal

The reader of this library's API is a model writing code. It writes from memory of other libraries (mostly XState v4 and v5), and its only feedback is `bun check` and `bun test`. So the library is good when:

1. a correct machine looks like the first thing a model would write,
2. each usual mistake is a type error, and
3. the error says what to change, in words a model can act on without opening the library's source.

XState v6 starts from the same observation ([its beta post](https://stately.ai/blog/2026-11-05-xstate-v6-beta)): models know statecharts but write old syntax. Its answers are transition functions, `enq` for effects, schemas instead of `types: {} as`, typestates, docs shipped in the package, and a CLI. Ours goes further on types: the type checker reads the machine's graph, and every state has its own data.

## The API, whole

```ts
import { createActor, setup, types } from "@reactre/state";

// 1. The shape: each state's data and each event's payload. Data is JSON by type.
const fetcher = setup({
  version: 1,
  input: types<{ url: string }>(),
  states: {
    idle: types<{ url: string }>(),
    loading: types<{ url: string; attempt: number }>(),
    loaded: types<{ url: string; body: string }>(),
    failed: types<{ url: string; attempt: number; error: string }>(),
    gaveUp: types<{ url: string }>(),
  },
  events: { fetch: types<{}>(), retry: types<{}>(), cancel: types<{}>() },
  internal: { received: types<{ body: string }>() }, // only tasks produce these
});

// 2. The behaviour, checked against the shape.
const machine = fetcher.machine({
  start: ({ input, to }) => to("idle", { url: input.url }),
  states: {
    idle: { on: { fetch: ({ data, to }) => to("loading", { url: data.url, attempt: 1 }) } },
    loading: {
      task: {
        run: async ({ data, signal }) => {
          const res = await fetch(data.url, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`); // a 404 or 500 page is a failure: error decides
          return { type: "received", body: await res.text() };
        },
        error: ({ data, error, to }) => to("failed", { ...data, error: String(error) }),
      },
      on: {
        received: ({ data, event, to }) => to("loaded", { url: data.url, body: event.body }),
        cancel: ({ data, to }) => to("idle", { url: data.url }),
      },
      after: { "10s": ({ data, to }) => to("failed", { ...data, error: "timed out" }) },
    },
    failed: {
      on: {
        retry: ({ data, to }) =>
          data.attempt < 3 ? to("loading", { url: data.url, attempt: data.attempt + 1 }) : to("gaveUp", { url: data.url }),
      },
    },
    loaded: { final: true },
    gaveUp: { final: true },
  },
});

// 3. Run it.
const actor = createActor(machine, { input: { url: "/api" } });
actor.send({ type: "fetch" }); // { ok: true, snapshot } | { ok: false, reason, snapshot }
const s = actor.snapshot();
if (s.state === "loaded") s.data.body; // narrowed: only "loaded" has a body
```

That is the core, and all of it: `setup`, `types`, `machine`, `to`, `keep`, `null` (decline), `on`, `task`, `after`, `final`, `createActor`, `restoreActor`, `transition`, `initial`. `keep(state, data)` stays in the state a handler runs in with new data, and leaves its task and timers running: where a state has a task or timer, `to` to itself is a type error that asks for `keep` or reenter's `reenter` (which restarts them). In a component, `useActor(machine)` from `@reactre/state/signals` gives the snapshot as a signal and stops the actor with the component. The core needs no opt-in. It already covers what XState's `xstate/fsm` does (pure transitions, an interpreter), plus tasks and timers.

### Opt-ins

Every other feature is opt-in, in setup's `use`: the feature itself, imported by name from its entry.

- A machine that doesn't use a feature ships none of its bytes.
- Using one without its opt-in is a type error that names both lines to add, for example `state "edit.draft" is nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`.
- A feature that needs another says so the same way: `parallel needs nested: …`.

The cost columns are measured gzipped bytes with esbuild, from the latest full size suite. [`test/sizes.test.ts`](test/sizes.test.ts) pins each budget.

- **Listed, unused:** what listing the feature on the door app costs.
- **App that uses it:** a whole app with that feature in use, table and app code included (the door app alone is 728).
- **Open budget work:** job is 1119 above its pin of 1060, and persist's 3304 is above its pin of 3275. These are current red gates, not an agreed budget increase; behavior and fixture weakening are not ways to close them.

| Opt-in (`@reactre/state/<name>`)  | What it adds                                                                            | XState v6 counterpart          | Listed, unused | App that uses it          |
| --------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------ | -------------- | ------------------------- |
| `nested`                          | dotted state names, parents with handlers, tasks, timers and children, and bubbling     | compound states                | 0              | 1855 (with history)       |
| `parallel` (needs nested)         | parallel nodes with a step per region, a node's done, and parallel nodes inside regions | parallel states                | 0              | 1876                      |
| `history` (needs nested)          | `back(parent, fallback)` (deep or with a child step)                                    | history states                 | 0              | with nested               |
| `output`                          | `Output<typeof machine>` and a parent's done                                            | output, onDone                 | 0              | 1479                      |
| `choice`                          | `choice: ({ data, to }) => to(...)` on a leaf                                           | choice states                  | 0              | 1110                      |
| `route`                           | typed routes reached from anywhere                                                      | route states, xstate.route     | 0              | 822                       |
| `always`                          | eventless transitions with the S50 loop guard                                           | always                         | 0              | 1041                      |
| `reenter`                         | `reenter(state, data)`, restarting its work                                             | reenter: true                  | 0              | 1462                      |
| `wildcards`                       | `"*"` and `"pointer.*"`, typed as the events each matches                               | wildcard transitions           | 0              | 960                       |
| `tags`                            | tags, meta and description; hasTag, getMeta, getStateNodes                              | tags, meta, description        | 0              | 1246                      |
| `effects`                         | entry, exit and enq handlers, recorded for after the move                               | entry, exit, enqueueActions    | 0              | 3133                      |
| `emit` (needs effects)            | `enq.emit` and `on(actor, type, listener)`                                              | emitted events, actor.on       | 0              | 3224                      |
| `provide`                         | named actions and guards; `provide(machine, ...)`                                       | provide                        | 0              | 3137                      |
| `delays`                          | named delays, including ISO durations and data functions                                | named delays                   | 0              | 1317                      |
| `timeout`                         | `timeout` and `onTimeout`                                                               | timeout, onTimeout             | 0              | 1264                      |
| `children`                        | child input, completion, errors, updates and `child`                                    | invoke                         | 0              | 2077                      |
| `logic` (with children)           | async, callback, observable, step, listener and subscription actors                     | actor logic creators           | 0              | 2860                      |
| `spawn` (needs effects, children) | `enq.spawn`, stop, subscriptions and persisted spawned children                         | spawn, listen, subscribeTo     | 0              | 4954                      |
| `system`                          | `createSystem` and `system.get`                                                         | systems                        | 0              | 2350                      |
| `inspect`                         | `createActor(machine, { inspect, logger })`                                             | inspect, logger                | 566            | 1214                      |
| `validate`                        | Standard Schemas checked at every boundary                                              | Standard Schema, validation    | 0              | 2231                      |
| `persist`                         | snapshots, timer deadlines, migrations and processEvent                                 | persisted snapshots, migration | 467            | 3304 (pin 3275)           |
| `durable`                         | tasks, timers and children journaled by a host                                          | durable execution              | 10             | 2862 (6037 with children) |

Three cost bytes when listed and unused:

- `inspect`: listing it routes every step through its hooks.
- `persist`: a machine that lists it gets the general lifecycle, which saves timers' deadlines.
- `durable`: its marker.

Whole entries, imported by the app, cost nothing until imported:

- `@reactre/state/serialize`: `machineToJSON`, `machineFromJSON`, diagnostics.
- `/scxml`: to and from SCXML.
- `/graph`: shortest and simple paths, adjacency, `toDirectedGraph`.
- `/test`: model-based testing.
- `/react`: `useActor`, `useActorRef` and `useSelector`, with React as an optional peer. The actor starts when the component mounts, in an effect, and stops when it unmounts: a render alone starts nothing (on the server, or a render React throws away). `/react/dev` is the same hooks with development warnings, and a development build imports it in place of `/react` (see [Development builds](#development-builds)).
- `/utils`: `matches`, `matchesState`, `mapState`, `can`, `getNextTransitions`, `isUnhandled`, `assertEvent`, `select`, `waitFor`, `toPromise`, `SimulatedClock`, and the tags helpers, each also at `/utils/<name>`.

Not here: XState's CLI and its visual editor. Vue, Svelte and Solid adapters are out of scope too.

### Nested states, history, parallel states, children and schemas

```ts
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const editor = setup({
  use: [nested, history],
  states: {
    idle: types<{}>(),
    "edit.draft": types<{ text: string }>(), // a dotted name: "edit" is its parent
    "edit.review": types<{ text: string; by: string }>(),
    away: types<{}>(),
  },
  events: { open: types<{}>(), submit: types<{ by: string }>(), cancel: types<{}>(), leave: types<{}>(), resume: types<{}>() },
});

editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    // A parent: optional. Its handlers, task, timers and children apply to every leaf under it; its
    // handler's { state, data } is the union of its leaves, so `state === "edit.review"` narrows data.
    edit: { on: { cancel: ({ to }) => to("idle"), leave: ({ to }) => to("away") } },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": { on: { cancel: ({ data, to }) => (data.by === "boss" ? null : to("edit.draft", { text: data.text })) } },
    // back: the leaf "edit" held when it was last left, with its data; or the fallback.
    away: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })) } },
  },
});
```

- **Bubbling.** An event goes to the leaf, then its parents, innermost first. `null` passes it on; the first step decides. A move to the same leaf stays: its task, timers and children keep running. A parent over both leaves stays too. In a leaf with a task or timer, its own handler says so with `keep(leaf, data)`, or restarts them with `reenter(leaf, data)`: a plain `to` to itself is a type error.
- **History** is deep by default: the last leaf, whole, kept in the snapshot's `history` (JSON, restored with it).
  - Shallow history, `back("edit", fallback, { child: to(...) })`, re-enters the parent's last direct child. A leaf child comes back whole.
  - A parent child comes back through the step given for it. Its leaves need data, and a parent has none, so the step says which leaf to enter and with what (XState's child `initial`).
- **Parallel nodes** are declared in setup (`use: [nested, parallel], parallel: ["player"]`), since the snapshot's type depends on them.
  - Inside one, the snapshot is `{ state: "player", data: { playback: { state, data }, volume: { state, data } } }`.
  - Enter one with a step per region, `to("player", { playback: to(...), volume: to(...) })`. A region's leaf with `final: true` ends the region, and the node's `done: ({ data, to }) => ...` runs when all have.
  - A parallel node may sit inside another's region.
- **Children** are named in setup (`use: [children], children: { upload: uploadMachine }`) and run by a node while it is active: `children: { upload: { input, done, error, update, on } }`, or `each` for a keyed collection.
  - `done`'s `output` is the union of the child's final `{ state, data }`. `child(actor, "upload")` from `@reactre/state/children` reaches one.
  - With `logic`, a child may be actor logic instead of a machine. Its `on` handles the events it sends back.
  - They're declared in setup, not in the node, because a type can't read one property of an object literal to type a sibling (`machine` to type `done`'s `output`) inside an inferred config: see below.
- **Standard Schemas** (zod, valibot, arktype, or one by hand) may replace `types<T>()` anywhere in setup, with `use: [validate]`.
  - Handlers get the schema's output, `send` takes its input, and the JSON checks read the output.
  - The runtime validates sent events (`reason: "invalid"`), task results (S6, to the task's `error`), input (S5), restored data (S7), and the data each transition makes (S23). That includes transitions decided outside a step: a timer's, a task's `error`, a child's report.
- `isIn(snapshot, "edit")` narrows a snapshot to the leaves under a parent.

### Effects

Transitions stay pure: what a handler enqueues is recorded as data during the transition, returned on the result's `fx` (so `transition()` gives it unrun), and run after the move.

```ts
import { effects } from "@reactre/state/effects";

const door = setup({
  use: [effects],
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
  internal: { ring: types<{ n: number }>() },
});

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      entry: ({ enq }) => enq.log("closed"),
      on: {
        push: ({ event, enq, to }) => {
          enq.sendTo(audit, { type: "opened", by: event.by });
          enq.raise({ type: "ring", n: 1 }, { delay: 1000, id: "bell" });
          return to("open", { by: event.by });
        },
      },
    },
    open: { exit: ({ enq }) => enq.cancel("bell"), on: { close: ({ to }) => to("closed"), ring: ({ data, to }) => to("open", data) } },
  },
});
```

### Where the shape differs from XState, and why

Each capability is there; a few take a different shape, to keep data per state, JSON data and pure transitions:

- **No `assign`.** A transition's data is the target state's data, `to(state, data)`. `entry` and `exit` only enqueue effects; they can't write data.
- **Output** is the final leaf's data, not a separate `output` function.
- **A choice state** is a leaf the machine never rests in: its `choice` must return a step.
- **Route** targets a node by name (`{ type: "route", to: "checkout" }`), not by id.
- **Reenter** is a move, `reenter(state, data)`, not a flag on a transition object.
- **Spawned children** are reached by name and key (`child(actor, "worker", "a")`), not by a ref held in context. What they report comes back as the machine's own events, named in the effect (`enq.subscribeTo("worker", { key, done: "finished" })`), so it persists.
- **No `extend` or `createStateConfig`.** A machine is a shape and its behaviour, each written in one place.
- **ISO 8601 durations** have no years or months: their length depends on the calendar.

### Persisting, durable hosts, and the codemod

```ts
import { migrations, persist } from "@reactre/state/persist";
import { durable } from "@reactre/state/durable";

// Each is the opt-in and the function: setup({ use: [persist], ... }), setup({ use: [durable], ... }).
// Without it, persist(actor) and durable(machine, host) are type errors naming the import.
// A persisted setup keeps shape: "<hash>" beside its version, the hash of the version and contracts,
// which the build computes and checks: change the states or events without a new version, and the
// build fails with the next version's hash, and the migration to add.

// Save and restore an actor, timers and children included.
const saved = persist(actor); // JSON: the snapshot, plus each running node's part (`run`)
const again = restoreActor(machine, saved, { now: Date.now });

// A snapshot from an older version: each step is typed from that version's states to the machine's.
// `migrate` checks the stored JSON (S20), and refuses a version nothing migrates (S21) or a newer one (S22).
const migrate = migrations(machine).from<1, { waiting: { text: string } }>(({ data, to }) =>
  to("waiting", { note: data.text }),
);
const fromV1 = restoreActor(machine, migrate(JSON.parse(stored)));

// Run on a host that journals (a workflow engine, a Durable Object, a queue worker).
const run = durable(machine, {
  now: () => host.now(),
  step: (id, fn) => host.step(id, fn), // runs fn once per id; a replay returns the recorded result
  schedule: (id, at) => host.schedule(id, at), // a durable timer; the host calls run.fire(id) at `at`
  cancel: (id) => host.cancel(id),
  save: (snapshot) => host.save(snapshot), // after every transition
});
await run.start(input); // or run.resume(saved)
await run.send({ type: "approve" });
```

- **A shape changed is a new version.** A snapshot saved at version 2 restores only into version 2's states and data, so a persisted setup keeps the hash of its version and contracts, `shape: "<hash>"`, and the build checks it (see [the compiler](#the-compiler-only-what-types-cant-check-and-a-table-at-runtime)). Change a state's data and keep the version, and the build fails with the fix: `version: 3`, a migration `.from<2, …>`, and version 3's hash.
- **Timers survive a restore.** A timer's deadline is absolute (`now() + ms` at entry), and `persist` saves the pending ones. A restored actor waits only what is left, and an overdue timer fires at once. A fired timer doesn't fire again after a restore. A task restarts, as before: only a durable host journals it.
- **Durable runs.** Tasks go through `host.step`, and timers become absolute deadlines through `host.schedule`. Ids are deterministic (`charging#2/task`, `charging#2/after/60000`: the node, its entry count, the kind, a timer's being its delay), so a process that dies and resumes from its last save asks the host for the same ids, and no side effect runs twice. Leaving a node cancels its timers and drops its task's late result. Delays's and timeout's timers run there too (`after/PT1M` as `after/60000`, a named delay as `after/<name>`, one from the data as `after/fn`). Effects don't: an effect isn't journaled, so a machine that records one throws S12; do the work in a task.
- **Children on a durable host** run inside the durable run, journaled under the parent's ids: a child machine's tasks and timers are the host's steps and schedules, and a logic child's whole run is one step (a resume returns its recorded end). The child code ships only when the machine has children (`durable/children`).
  - Not journaled: a logic child's values in between (an observable's), so its `update` doesn't run on a durable host, and a logic restarted after a resume may send its events again.
- **The codemod.** `bun packages/state/codemod/index.ts <files…> [--write]` rewrites XState v4, v5 and v6 machines, and what the Stately visual editor exports. It prints what it converted and what it couldn't, with lines, and the output's `use` lists exactly the opt-ins it needs.
  - **What converts:**
    - targets in every form, guards (named ones inlined, or setup's `guards` when impure), `assign`, nesting, parallel, history, `after`, `final`;
    - `invoke` of a promise (a task), a machine or a callback (a child);
    - `entry` and `exit`; named actions (setup's `actions`, with `provide`); `raise`, `sendTo`, `log`, `cancel`, `emit` and `enqueueActions`;
    - `spawnChild` and `stopChild`, `always`, a compound `onDone`, computed delays and v6 `timeout`;
    - tags, meta and description, `reenter`, and `*` handlers.
  - **Stately exports:**
    - XState v5 TypeScript, from `createMachine` with implementations or from `setup(...).createMachine`, with references (`{ type, params }`, `guard: "name"`, `src: "name"`) and stub bodies;
    - XState v4 TypeScript, with typegen, `schema` and `cond`;
    - the JSON config alone.

    The layout comment is dropped and reported. A stub becomes a named stub with a TODO, a guard stub returning `false`, so behaviour stays the same. Types are kept when the export has them and inferred from `context` when it doesn't, and the report lists every guess.

  - **Context per state:** shared context becomes per-state data, each state keeping only the fields it reads, receives or carries on, when that can be proven. Otherwise it keeps the whole context, with a TODO to narrow it.
  - **What it can't convert** stays as a `// TODO(@reactre/state): …` at the spot, never dropped silently. These have no counterpart here:
    - `stateIn`, a transition's `meta`, `sendParent`, `forwardTo`, `xstate.*` events;
    - `assign` in `entry`, `exit` or `enqueueActions`;
    - a final state's own `output`;
    - an entry effect or a delay that reads the event;
    - observable and transition logic, an invoke's own `timeout`.
  - **Mirrored states** (siblings with the same data and handlers, their names differing by a flag: `approved_by_manager`, `approved_by_director`) stay as XState had them, so the machine replays the same and the app's reads of their names hold. The compiler's fix, one state with the flag in its data, is a TODO right above the first, which the compiler takes: the output builds until they are merged.
  - **Its tests:** each fixture's output passes `bun check` and the compiler, and replays the same states as the XState original (v5 with `xstate`, v6 with `xstate6`). There are 85 tests over v4, v5 and v6 sources and five Stately exports.

## The design, and the mistake each part removes

| Decision                                                                | The mistake it turns into a type error, or removes                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One way to transition: a function returning `to(state, data)` or `null` | XState's string targets, `{ target, guard, actions }` objects, `assign`, `cond`. All type errors.                                                                                                                                                                                                                                                                                                       |
| `null` declines, not `undefined`                                        | Since TS 5.1, a function whose return type includes `undefined` may end with no `return`. A forgotten `return` would decline every event silently.                                                                                                                                                                                                                                                      |
| The shape comes first (`setup`), behaviour second                       | Misspelled targets, missing or extra data fields (also through a spread or a variable), data for a state that takes none, payload fields an event doesn't carry.                                                                                                                                                                                                                                        |
| Each state has its own data; there is no shared context                 | Reading a field that only another state has, or optional-field checks (`context.result?.x`). The snapshot is a discriminated union on `state`.                                                                                                                                                                                                                                                          |
| Data is deep-readonly, and frozen in development builds                 | Editing data in place instead of building the next state's data.                                                                                                                                                                                                                                                                                                                                        |
| The type checker reads the graph                                        | A state nothing goes to, a non-final state nothing leaves, a task whose result its state doesn't handle, an event no state handles, an internal event no task produces or that arrives where it's handled.                                                                                                                                                                                              |
| Unknown keys are listed, with hints; an opt-in's key names its import   | `invoke`, `context`, `initial`, `id`, `type: "final"`, a misspelled event, a state the shape lacks, a timer like `"5 sec"`; `entry`, `exit` or `always` without their opt-in.                                                                                                                                                                                                                           |
| A task's `error` is required                                            | Async work with no failure path.                                                                                                                                                                                                                                                                                                                                                                        |
| A task's signal aborts on exit, and a late result is dropped            | The stale-response race (a slow fetch landing in a state that's moved on). A move to the same state doesn't exit it, so there a typeahead's old result would land on the new query: `to` to itself, in a state with a task or timer, is a type error that asks for `reenter` (restart with the new data) or `keep` with the data it started with (leave it running). The race can't happen by accident. |
| Data, payloads and input are JSON by type                               | A `Date`, `Map`, function or `undefined` field, which would break saving and restoring a snapshot; `any`, `unknown`, `{}`, `object`, index signatures and tuples, which hold more than they say. A payload field named `type`.                                                                                                                                                                          |
| `internal` events                                                       | Sending a task's result from outside. A type error, and refused at runtime too.                                                                                                                                                                                                                                                                                                                         |
| `send` and `transition` return why they didn't move                     | A model can assert `reason: "declined"` in a test instead of guessing from an unchanged snapshot.                                                                                                                                                                                                                                                                                                       |
| `transition` and `initial` are pure                                     | Tests that walk the machine with no timers, promises or DOM.                                                                                                                                                                                                                                                                                                                                            |
| Runtime errors carry a code and the fix                                 | `[@reactre/state S2] the snapshot is of version 1, and the machine is at version 2. Migrate…`                                                                                                                                                                                                                                                                                                           |

## The evidence: every mistake a type error

[`test/mistakes.ts`](test/mistakes.ts) has the core's cases, and each feature's are in [`test/features/<feature>/mistakes.ts`](test/features). Each case is marked `@ts-expect-error` (341 in all), or pinned to its exact wording with `Equal` (92).

- `bun check` fails if any of them stops being an error, and the correct machines in the same files pass.
- Each feature's file starts with its opt-in case: the feature used without it.
- [`test/explain.ts`](test/explain.ts) prints what each error says, as a model sees it.

The core's and the first features' cases:

| #     | Mistake                                                                 | What `bun check` says                                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `to("opne", …)`                                                         | `"opne"` is not assignable to `NodeName<{ … closed … open … locked }>`                                                                                                                                                                                   |
| 2     | `to("locked", {})`                                                      | Property `code` is missing                                                                                                                                                                                                                               |
| 3     | `to("closed", {})` (takes no data)                                      | Expected 1 arguments, but got 2                                                                                                                                                                                                                          |
| 4     | `to("open", { by, at: 1 })`                                             | `at` does not exist in type `{ readonly by: string }`                                                                                                                                                                                                    |
| 5     | `on: { psuh: … }`                                                       | its handler's `to` is implicitly any (on that line), and at use: `state "closed" handles "psuh", which is not an event in the shape: check the name, or add it to setup's events`                                                                        |
| 6     | `event.name`                                                            | Property `name` does not exist on `{ readonly type: "push"; readonly by: string }`                                                                                                                                                                       |
| 7     | `data.code` in `closed`                                                 | Property `code` does not exist on type `{}`                                                                                                                                                                                                              |
| 8     | `data.by = ""`                                                          | Cannot assign to `by` because it is a read-only property                                                                                                                                                                                                 |
| 9     | block body without `return`                                             | `=> void` is not assignable to `Handler<…>`                                                                                                                                                                                                              |
| 10–11 | `push: "open"`, `{ target, guard, actions }`                            | `string` / `target` is not assignable to `Handler<…>`                                                                                                                                                                                                    |
| 12    | a state left out                                                        | Property `locked` is missing                                                                                                                                                                                                                             |
| 13    | `entry`, `invoke`, `always`, `context`, `initial`, `id`, an extra state | `MachineError<'state "closed" has "entry": add effects to setup's use (import { effects } from "@reactre/state/effects")' \| 'state "open" has "invoke", which states don't take: use task: { run, error }' \| …>`                                       |
| 14    | `after: { "5 sec": … }`                                                 | `state "open" has a timer "5 sec": write a number and a unit, "500ms", "5s", "2m" or "1h"`                                                                                                                                                               |
| 15    | `{ final: true, on: … }`                                                | `state "locked" is final and has "on": a final state takes no events, tasks or timers. Remove it, or drop final`                                                                                                                                         |
| 16    | a state nothing goes to                                                 | `state "locked" is unreachable: no transition goes to it. Add one, or remove the state`                                                                                                                                                                  |
| 17    | a state nothing leaves                                                  | `state "locked" is a dead end: no transition leaves it. Add one, or mark it { final: true }`                                                                                                                                                             |
| 18    | a task's event not in `on`                                              | `state "saving" ignores its task's event "stored": add a handler for it to the state's "on"`                                                                                                                                                             |
| 19    | `task` without `error`                                                  | Property `error` is missing                                                                                                                                                                                                                              |
| 20    | a task resolving to an undeclared event                                 | `{ type: "done" }` is not assignable to the events' union                                                                                                                                                                                                |
| 21–22 | `send({ type: "kick" })`, `send({ type: "push" })`                      | `"kick"` is not assignable to `"close" \| "lock" \| "push" \| "unlock"`; Property `by` is missing                                                                                                                                                        |
| 23    | `snapshot.data.by` before narrowing                                     | `by` does not exist on `{ readonly by: string } \| { readonly code: string } \| {}`                                                                                                                                                                      |
| 24    | `snapshot.state === "opened"`                                           | the types `"closed" \| "locked" \| "open"` and `"opened"` have no overlap                                                                                                                                                                                |
| 25    | sending an internal event                                               | `"stored"` is not assignable to `"retry" \| "save"`                                                                                                                                                                                                      |
| 26–27 | `Date` or a function in data, a `type` field                            | `not JSON: state "idle".at (a Date: store an ISO string or a number)`                                                                                                                                                                                    |
| 28    | no `input`                                                              | Expected 2 arguments, but got 1                                                                                                                                                                                                                          |
| 29–31 | `any`, `unknown` or an index signature in data or a payload             | `not JSON: state "idle".x (any: write the type)`, `(unknown: write the type)`, `(an index signature: list the fields)`                                                                                                                                   |
| 32    | `to("locked", { ...data, code })`, `to("open", someObject)`             | `Property '"state \"locked\" has no field by: list only its fields"' is missing`: `to` infers the data's whole type and holds it to the state's keys                                                                                                     |
| 33    | an event no state handles                                               | `event "kick" is declared but no state handles it: handle it, or remove it from setup's events`                                                                                                                                                          |
| 34    | an internal event no task produces                                      | `internal event "lost" is never produced by a task: produce it, or remove it`                                                                                                                                                                            |
| 35    | an internal event handled where it never arrives                        | `state "idle" handles internal event "stored", which its own task doesn't produce: only the current state's task's events arrive`                                                                                                                        |
| 36–38 | a field typed `{}`, `object`, or a tuple                                | `not JSON: state "idle".meta ({} or object: it accepts a string, an array or a function. Write its fields)`; `(a tuple: use an array, or an object with named fields)`                                                                                   |
| 39    | `setup({ …, verison: 2 })`                                              | `setup has no option "verison": it takes use, states, events, internal, input and version, and what a feature in use adds (parallel, children)`                                                                                                          |
| 40    | a state that is also a parent (`edit` beside `edit.draft`)              | `state "edit" is also a parent of other states, and a parent has no data: rename it, or move its data into the leaves under it`                                                                                                                          |
| 41    | `to("edit")`, a parent                                                  | `"edit"` is not assignable to `"\"edit\" is a parent: go to one of its leaves, with its data"`                                                                                                                                                           |
| 42–43 | a parent's `data.by` before narrowing, or `{ ...data }` into a leaf     | `by` does not exist on `{ text } \| { text, by }`; `state "sent" has no field by: list only its fields`                                                                                                                                                  |
| 44    | `back("idle", …)`, a leaf                                               | `"idle" is a leaf: back goes to the leaf a parent held when it was last left. Go to this one with to("idle", ...)`                                                                                                                                       |
| 45–46 | a key neither leaf nor parent; a parent marked final                    | `state "edt" is not in the shape…`; `state "edit" is a parent, and only leaves are final: mark the leaves it ends in { final: true }`                                                                                                                    |
| 47    | `to("on", { playback })`, a region missing                              | Property `volume` is missing                                                                                                                                                                                                                             |
| 48    | `back("on.playback", …)`, a region                                      | `back can't go to "on.playback", inside parallel node "on": go back to "on", which keeps all its regions`                                                                                                                                                |
| 49    | a region's leaf targeted from outside                                   | `state "off" goes to "on.playback.stopped", inside parallel node "on": enter "on" with to("on", { [region]: to(leaf, data), ... }), a step for each region`                                                                                              |
| 50–51 | `done` with a region that never ends; regions that all end, no `done`   | `parallel node "on" has done, but its region "volume" has no final state…`; `parallel node "on" ends when every region is in a final state, and has no done…`                                                                                            |
| 52    | a parallel node without regions, or a leaf right under one              | `parallel node "x" has no states under it…`, `state "on.y" is directly under a parallel node…`                                                                                                                                                           |
| 53–55 | a child setup lacks, without its input, or whose end nobody handles     | `state "uploading" runs "uplod", which is not in setup's children…`, `…without its input: add input…`, `…which can end, and has no done for it: add done…`                                                                                               |
| 56–57 | a schema whose output is a `Date`; a payload that isn't its input       | `not JSON: state "idle".at (a Date…)`; `number` is not assignable to `string`                                                                                                                                                                            |
| 58    | a dotted state without `nested` in `use`                                | `state "edit.draft" is nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`                                                                                                                                               |
| 59    | setup's `parallel` without `parallel`; `parallel` without `nested`      | `setup has "parallel": add parallel to setup's use (…)`; `parallel needs nested: add nested to setup's use (…)`                                                                                                                                          |
| 60    | `back(…)` without `history`; `history` without `nested`                 | `"edit"` is not assignable to `"back needs history: add history to setup's use (import { history } from \"@reactre/state/history\")"`; `history needs nested: …`                                                                                         |
| 61    | setup's `children` without `children` in `use`                          | `setup has "children": add children to setup's use (import { children } from "@reactre/state/children")`                                                                                                                                                 |
| 62    | a Standard Schema without `validate` in `use`                           | `state "editing" is a Standard Schema: add validate to setup's use (import { validate } from "@reactre/state/validate")`                                                                                                                                 |
| 63–64 | `persist(actor)`, `durable(machine, host)` without their opt-in         | Property `"persist(actor) needs persist: add persist to setup's use (import { persist } from \"@reactre/state/persist\")"` is missing; the same for durable                                                                                              |
| 65    | `use: ["nested"]`, a name                                               | `use lists "nested", a name: list the feature itself, import { nested } from "@reactre/state/nested", then use: [nested]`                                                                                                                                |
| 66    | `to("loading", { q })` from `loading`, which has a task or timer        | `state "loading" goes to itself with to(...), and its task keeps running with the data it started with: write reenter("loading", ...) to restart it with the new data (…), or keep("loading", data), with the data it started with, to leave it running` |
| 67    | `createActor(machine as any)`; `restoreActor(m, JSON.parse(text))`      | `The 'this' context of type 'void' is not assignable to method's 'this' of type '"the machine is typed any, …"'`; `'"the snapshot is typed any (JSON.parse returns any), …: read it with migrations(machine) …"'`                                        |
| 68    | a task's event carrying `await res.json()`                              | `state "loading"'s task resolves to "received" with user typed any: check what you parse (res.json() and JSON.parse return any), and build the event from the checked value`                                                                             |
| 69    | `import { assign } from "@reactre/state"`, then `assign({ n: 1 })`      | `… parameter of type '"assign is XState's: there is no context to assign to. Return the next state with its data, to(state, { ...data, field })"'` (and `and`, `raise`, `createMachine`, `interpret`, `invoke`, …)                                       |
| 70    | `after: { 5000: … }`; a DOM node in data                                | `state "saving" has a timer 5000, a bare number: write it with its unit, "5000ms"`; `not JSON: state "idle".el (an object with methods: …)`                                                                                                              |

The whole suite is 1,166 tests (the latest run: 1,164 pass and the two size-pin failures documented above), covering every line and function of the package's sources (CI's `bun test --coverage` fails below 100%): the runtime, each feature (on and off), the compiler, the bundlers, the sizes and the codemod. [`test/actor.test.ts`](test/actor.test.ts) covers the core's runtime on machines compiled the way a build compiles them: 16 tests. They cover the pure walk, refusal reasons, frozen data in development, task results, abort on exit with the late result dropped, task errors, timers firing and being cancelled, stop, listeners that send, internal events refused at runtime, restoring a snapshot (and its task running again), version and state refusals, `setup` and `types` throwing when the plugin is missing, and `useActor` stopping with its owner.

## The compiler: only what types can't check, and a table at runtime

The type checker sees types, not code. A model can still write a handler that reads the clock, a cast that hides a wrong field, a `@ts-expect-error` over a broken contract, or data built by a helper that carries keys its type doesn't list. The compiler reads the source (with [oxc-parser](https://oxc.rs), before types are stripped) and fails the build on these. It reports every problem in the file at once, each with its line, column, the code and a caret:

```
@reactre/state: 1 problem

test/fixtures/broken.ts:14:51: Date reads the clock: put the time in the event (`{ type: "tick", now: Date.now() }` where you send it)
      off: { on: { flip: ({ to }) => to("on", { at: Date.now() }) } },
                                                    ^
```

It never repeats the type checker. A misspelled target, an `entry` key, `any` in a contract or an unreachable state is a type error, and the compiler compiles past it. [`test/compiler.test.ts`](test/compiler.test.ts) holds it to that: it writes every compiler case to disk, runs `bun check` on them, and fails if any is also a type error. What the compiler checks:

- **Pure transitions.** `start`, `on`, `after` and a task's `error` read only their arguments, module constants, imports and pure globals. That rules out `Date`, `Math.random`, a module-level `let`, other globals (`console`, `fetch`), `new`, `import.meta` and `import()`, and any write outside the handler's own locals: an assignment, `delete`, or a mutating method (`push`, `set`, `Object.assign` onto an existing object). A task's `run` is the effect, so it may do anything.
- **Calls in transitions.** A function a transition calls is held to the same rules. One declared in the file is checked where it is, and so is every function it calls, in the file (once each, so a cycle ends). One imported is allowed only from a module marked pure, and a module value's method (`bus.send(...)`) never: the compiler can't see what they do. A step of `migrations(machine).from(...)` is a transition too. Of @reactre/state's own functions, the pure ones are allowed (`isIn`, `transition`, `initial`, `can`, `matchesState` and the other utils that only compute).
- **Nothing hides a broken contract.** No cast (`as const` and `satisfies` are fine) or non-null `!` in a transition, and no `@ts-` suppression in a file with machines. In any file the build compiles, none on a line that calls a function taking a machine, an actor or a snapshot (`createActor`, `useActor`, `transition`, `initial`, `restoreActor`, `persist`, `migrations` and the like), no `@ts-nocheck` in a file that calls one, and no cast or `!` on a snapshot's data (`(s.data as any).body`): narrow it by its state.
- **Machines are made once, where their shape is.** `shape.machine({...})` at module level (inside a function, a component makes one per render), and only in the shape's file: `door.machine(...)` on a shape imported from another file fails the build where the import shows it, as well as at runtime (S4). `createActor` in a component (a function whose body renders JSX) is refused for `useActor`. A machine in a `.js` file, or under a tsconfig.json whose `strict` is false, has no type layer, and is refused.
- **A task's `run` ends with its state, and its failures reach `error`.** A `fetch` given the signal (`fetch(url, { signal })`); no AbortController of its own (the timeout is `after`); a `setInterval`, a `WebSocket` or `EventSource`, or an `addEventListener` only with a cleanup when the signal aborts; no `catch` (or `.catch`) that resolves to an event, no `forEach(async`, no `throw` of a string or plain object; no cast or `!` in the event it resolves to; no hook (`useQuery(...)`). And no response body read (`.json()`, `.text()`, `.blob()`, `.arrayBuffer()`, `.formData()`) without a look at its status before it: a 404 or 500 page would be the task's result. The response is followed by its name (`const res = await fetch(...)`, `.then((res) => ...)`), and `(await fetch(...)).json()` has none to check, so it is refused too. A look is `res.ok` or `res.status` (or either destructured), or the response passed whole to a function the compiler can see look at it: one in the file (or in `run`), or exported from a relative import, which the compiler reads for this as it reads a module's pure mark. A package's function can't be seen, so it isn't a look: check `res.ok` in `run`.
- **Effects and conditions.** No `.send(...)` from inside an effect (record `enq.sendTo` or `enq.raise`, so the step returns it as data); no effect recorded before a handler that may still return null (a declined step drops it); no array as a condition (`split(...)`, `filter(...)`, `Object.keys(...)`: always truthy); no module-level object or array as a value in data (every actor would share it); and no handler written the same on every leaf under a parent, three or more: it goes on the parent. `enq.cancel(id)` cancels something: its id is one a raise or send of the same machine gives (`enq.raise(event, { delay, id })`), which is a call in a handler's body and no type, so the id is a string written in place, and so are the options and id of every raise and send in a machine that cancels. An `after` timer has no id: it stops when its state exits.
- **A state isn't written twice.** Sibling states with the same data and the same handlers, whose names differ by a flag, are one state with the flag in its data: `approved_by_manager` and `approved_by_director` are `approved` with `{ by: "manager" | "director" }`, and `processing_priority_insured` and `processing_standard_uninsured` are `processing` with `{ kind: "priority" | "standard", insured: boolean }`. It fires only where that holds: names of as many words that share a stem (besides a connector like `by`), the same contract, and the same code (whitespace and comments left out), the names of states in it differing only by those words (`to("paid_by_manager")` in one, `to("paid_by_director")` in the other). A choice's targets `vip`, `review` and `standard` share no stem, and stay three states however alike their code is. A machine the codemod converted keeps XState's states, with the fix as a `// TODO(@reactre/state): …` right above the first, and that note (the message itself, written there) is taken: any other comment isn't.
- **A saved snapshot fits its machine.** A setup whose `use` lists `persist` or `durable` keeps `shape: "<hash>"`, which the build computes from the version and the contracts written in setup (`states`, `events`, `internal`, `input`: names and type text, with formatting and comments left out). A missing hash fails the build with the hash to add. A hash that no longer matches means the contracts or the version changed: if the contracts changed, the fix is the next version, a migration from the last, and the new hash; if only the version changed, the new hash. Both hashes are in the message. Any other machine may keep a `shape` too, and it gets the same check. A name a contract uses (`types<Order>()`, `types<typeof ORDER>()`, a schema held in a const) is followed to its declaration, in the file or in a relative import, so a change inside `Order` changes the hash too; a literal's members are sorted first, so reordering them changes nothing. A type from a package counts by its name alone: a change inside it needs the version bumped by hand.
- **Data's keys at runtime are its type's keys.** A type says a value has at least its keys. A helper's result, or another object spread in, can carry more, and a snapshot would save them. So data is an object literal or the handler's `data`, and it spreads only `data`.
- **What it compiles is written in place.** `const shape = setup({...})` and `shape.machine({...})` in one file; object literals for `states`, `on`, `task` and `after`; handlers written as functions that destructure their argument; `to("state", ...)` and `keep("state", ...)` called directly with the state's name (`keep` compiles as `to` does: the type checker is what tells them apart); the version as a number. A shape is used only for `.machine`.

Contract types can come from any file: the type checker reads them, and the compiler doesn't need to.

**Marking a module pure.** A module of the app's own is pure when its first statement is the directive `"use pure";` (comments may come before it, nothing else). A transition may then call its exports, and the compiler holds each of the module's functions to a transition's rules when it compiles that file (the plugin compiles every file with the mark), so the mark can't be wrong in silence. The compiler still compiles one file at a time: to see a relative import's mark, it reads the start of that file. A package can't be marked from the app, so the plugin takes a list, `state({ pure: ["date-fns"] })` (`statePreload({ pure })` for Bun's runtime plugin), which covers the package and its subpaths. An unmarked import called in a transition fails the build with both fixes in the message:

```
scheduleRetry is imported from ./retry.ts, which isn't marked pure, so the compiler can't check what it does: if it only computes from its arguments, put "use pure"; as the first line of ./retry.ts (the compiler then holds its functions to a transition's rules). Or call it in a task's run or an effect (enq)
```

Then it rewrites the machine into a table. The `setup` call and every `types<…>()` are gone, `to("loading", d)` is `["loading", d]`, handlers take `(data, event)`, `"10s"` is `10000`, and the tasks module is imported only when a state has a task or timer. Each feature in `use` keeps its import, and the table reads the feature's hooks from it (`g: nested.g, y: nested.y`); so `use` must be an array written in place, of features listed by the names they're imported with, which is the compiler's check:

```js
export const fetcher = /* @__PURE__ */ ({ v: 1, e: { "fetch": 1, "retry": 1, "cancel": 1 },
  i: (input) => ["idle", { url: input.url }],
  o: { "idle": { "fetch": (data) => ["loading", { url: data.url, attempt: 1 }] }, … },
  f: { "loaded": 1, "gaveUp": 1 },
  t: { "loading": [async (data, signal) => { … }, (data, error) => ["failed", { ...data, error: String(error) }]] },
  a: { "loading": [[10000, (data) => ["failed", { ...data, error: "timed out" }]]] },
  r: __reactreStateLean });
```

### Development builds

A development build adds `d: __reactreStateFreeze` (from `@reactre/state/dev`), so data is frozen and an edit throws; production builds don't import it. `dev` decides which build it is, and it defaults to `NODE_ENV !== "production"` in the bundler plugin (`state({ dev })` overrides it) and to `true` in the Bun runtime preload (`statePreload({ dev })`). A development build does two things:

- Every compiled machine gets `d: __reactreStateFreeze`, so its data is frozen and an edit throws.
- An app's `@reactre/state/react` import is rewritten to `@reactre/state/react/dev`, whose hooks are the plain ones plus a warning, once each, naming the fix. It runs before the compiler, on the import's own string literal found by parsing, so a comment or a string spelling the specifier is left alone, and a file with only React imports and no machine is rewritten too. A production build keeps `/react`: none of the warnings ship.

The warnings, from the React adapter's own traps:

- `useActor(machine, { input })` read once, so a changed input on a later render is ignored and the actor keeps the first (M313).
- A different machine passed on a later render is ignored, and the first is kept (M314).
- `useSelector` with a selector that builds a new object and no `compare` re-renders on every move (M315).
- Strict Mode's second mount replaces the actor, so a send from an effect that runs once (`[]`), meant to start the machine, goes to an actor that is replaced: the actor starts itself on mount, so send from an event handler or an effect that depends on the actor, `[actor]` (M316). The adapter replaces the stopped actor on that second mount; it does not claim that work started by the first actor, a task included, runs exactly once across the restart.

### Adding it to a build

```ts
// vite.config.ts
import state from "@reactre/state/plugin/vite";
export default { plugins: [state()] };
```

The same plugin is at `@reactre/state/plugin/{rollup,rolldown,esbuild,webpack,rspack,bun}`. Rollup, webpack and Rspack need the app's own TypeScript loader after it (the plugin reads TS and leaves TS). `bun test` and `bun run` use a runtime plugin instead, since unplugin's Bun entry only works with `Bun.build`: `preload = ["@reactre/state/plugin/preload"]` in `bunfig.toml`. A Bun runtime plugin that matches a file must load it, so another runtime plugin for the same files (such as @reactre/compiler's) never sees it: then register `statePreload({ filter })` from `@reactre/state/plugin/runtime` in your own preload, with `filter` matching only the folders with machines. Without the plugin, `setup` throws `[@reactre/state S0] this file wasn't compiled. Add the plugin…`, naming the import for Vite.

### Sizes

[`test/bundlers.test.ts`](test/bundlers.test.ts) builds two apps with each bundler, runs them, checks a broken machine fails each build with the compiler's message, and checks what ships: no `setup`, `types`, restore, freeze or compiler code, and the tasks module only in the app that has a task. Gzipped bytes of the whole minified bundle, app code included:

| Bundler  | Door app (plain machine) | Job app (task, timer, internal event) |
| -------- | ------------------------ | ------------------------------------- |
| esbuild  | 728                      | 1119                                  |
| Rolldown | 746                      | 1125                                  |
| Bun      | 740                      | 1130                                  |
| Vite     | 956 (lib mode)           | 1420 (lib mode)                       |

For comparison, the type-layer-only runtime was 1.4 KB gzipped before any app code. The job is under the 1.5 KB app goal but above its current regression pin; see the open budget work above. `restoreActor` (with the S1 and S2 messages) is its own export and costs nothing unless imported.

A flat machine with tasks or timers gets the lean lifecycle (`__lean` in `@reactre/state/tasks`): one active leaf, relative timers, nothing saved.

- The runners' general lifecycle (`@reactre/state/run`, which tracks the nodes a move exits, enters and keeps) ships only when a machine needs it: with `nested`, `children`, `persist`, effects, or a timer resolved at entry.
- Code a feature needs only beside another ships only then: durable's children hooks (with children), spawn's restore and the delays' saved deadlines (with persist), and validate's check of a transition decided outside a step (with a schema and such a handler).
- The limit is 1.5 KB gzipped for an app. The core's bytes since 671/1002 bought speed and safety: the step builds the snapshot in place, one frozen empty data object is shared, listeners are an array, and a listener that throws doesn't stop the others.

What each opt-in costs, listed and used, is in the table under [Opt-ins](#opt-ins). [`test/sizes.test.ts`](test/sizes.test.ts) pins every number there.

## What TypeScript doesn't allow, and what we do instead

These came out of the prototype. They're facts about TS (checked with `bun check`, Bun 1.4.4), not choices:

1. **Graph errors can't land on `machine`'s argument.** Mentioning the config's type parameter anywhere besides the bare parameter makes TypeScript fix it before the handlers' `to` and `data` get their types: an intersection, an F-bounded constraint, a `this` parameter or a rest parameter. A correct machine then fails too. So `machine()` returns `Machine<D>`, or `MachineError<"…the problems…">`, and the error shows where the machine is used (`createActor`, `transition`, `initial`, `useActor`) and on hover. Every machine is used, or tested, somewhere, so the error always shows.
2. **An inferred `const` type parameter gets no excess-property check.** That's why unknown keys are listed as problems with hints (#5, #13–15), not left to TS.
3. **A union keeps the alias it was first built with.** A misspelled target prints `StateName<{ … }>`, not the literal names. The names are visible inside it.
4. **Long errors are truncated** (`… 6 more …`). The shipped agent notes should tell projects to set `"noErrorTruncation": true`.
5. **TypeScript checks extra keys only in an object literal written in place.** A spread or a variable gets none. So `to` infers its data's whole type and compares its keys to the state's with a conditional type. An intersection would collapse to `never` when a key has a literal type, and the error would name nothing.
6. **Types can't see code.** Purity, casts, suppressions, and the keys a value really has at runtime are invisible to the type checker. That is the compiler's half, and only that.
7. **A property can't type its sibling in an inferred config.** In `{ machine: uploadMachine, done: ({ output }) => … }` inside `machine`'s argument, `done` is typed from the config's constraint, which can't name the `machine` beside it (that would mention the config's type parameter, #1). So child machines are named in setup, where the shape's type holds them.
8. **A union keeps its alias through a distributive conditional.** `Spelled<P>` alone would print `ChildProblem<{ … }>` for a problem built by another alias; the problems are put in a template literal first, so the error prints the strings.
9. **`any` is assignable to every parameter type but `never`.** So `createActor(machine as any)` can't fail on its argument, and `never` would name nothing. The use sites read the argument as written (a type parameter inferred through `Given<M>`, which adds nothing unless it is `any`) and give the call a `this` that is the fix for an `any`: a call's `this` is `void`, so the error is the fix.
10. **A call in a handler's body isn't in the config's type.** The type checker sees what a handler returns, not what it calls: which ids `enq.raise(…, { id })` used is the compiler's to check (M102).

## Proposed package shape

Following the repository's rules (Bun and TS only, opt-in costs nothing, a missing opt-in throws naming it):

- `@reactre/state`: `setup`, `types` (types only once compiled), `createActor`, `restoreActor`, `transition`, `initial`. No runtime dependency, and core's bytes don't change: @reactre/core never imports it.
- Imported by compiled code only, when a machine needs them:
  - `@reactre/state/run`: runners' general lifecycle;
  - `/tasks`: tasks and timers, and the lean lifecycle of a flat machine;
  - `/dev`: development builds.
- The features, each the value listed in setup's `use` (its hooks are what the table reads), at `@reactre/state/<feature>`: the 23 in the [Opt-ins](#opt-ins) table, with their app functions (`child`, `on`, `provide`, `persist`, `migrations`, `durable`, `createSystem`, the logic creators). A few have a second module that compiled code imports only beside another feature: `/delays/saved`, `/durable/children`, `/spawn/restore`, `/validate/decided`.
- Imported by the app:
  - `@reactre/state/signals`: `useActor`, the only entry that imports `@reactre/core`;
  - `@reactre/state/react`: `useActor`, `useActorRef` and `useSelector` for React, an optional peer;
  - `@reactre/state/{serialize,scxml,graph,test}`: definitions as data, and tooling;
  - `@reactre/state/utils`: helpers (`matches`, `waitFor`, …), each also at `/utils/<name>`.
- `@reactre/state/compiler`, `@reactre/state/plugin/*` and `@reactre/state/codemod`: build-time only. They depend on `oxc-parser` and `unplugin`, which never reach a bundle.
- `docs/agents.md` shipped in the package: the one-page API above, the mistakes table, the plugin line, and "don't use XState syntax", for a model to read from `node_modules`.

## Runtime errors

Each is a `StateError` whose message starts with `[@reactre/state S<n>]` and ends with the fix. Types catch these cases in typed code; the runtime catches them in untyped code, data from outside, and work that runs later.

| Code                    | When                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0                      | a file wasn't compiled: add the plugin                                                                                                                   |
| S1, S2                  | a snapshot with no such state; a snapshot of another version                                                                                             |
| S4                      | `machine()` on a shape from another file                                                                                                                 |
| S5, S6, S7, S8          | validate: bad input; a task's bad result; bad restored data; an async schema                                                                             |
| S10, S12                | a durable run used before `start` or `resume`; a durable run of a machine that records effects                                                           |
| S11                     | an app function, or `machineFromJSON`, given a machine without the opt-in it needs (names the import)                                                    |
| S20, S21, S22           | persist: stored JSON that isn't a snapshot; a version nothing migrates; a newer version                                                                  |
| S23, S24                | validate: a transition's data its state's schema refuses; a schema that throws                                                                           |
| S25, S26, S27           | serialize: a malformed definition, or code with no evaluator; a feature `machineFromJSON` can't revive; test: the implementation diverged from the model |
| S30, S31                | logic: async logic timed out; a malformed timeout                                                                                                        |
| S32, S33, S34, S35, S36 | system: a taken `registryKey`; actor logic in the pure system; no such actor; time going back; a loop                                                    |
| S37, S38, S39           | `waitFor` timed out, or the actor ended first; `assertEvent` got another type                                                                            |
| S40                     | spawn: a name setup lacks, or a key already running                                                                                                      |
| S50                     | always: eventless transitions that never rest                                                                                                            |
| S60, S61, S62           | effects: an effect with no runner (names the import); raises that never stop; `on()` on a machine that doesn't emit                                      |
