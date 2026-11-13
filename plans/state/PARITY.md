# @reactre/state v3: every feature opt-in, and parity with XState v6 beta

Written 2026-11-10 11:51 +06.

**Status:** done.

- All 23 features in section 2 are opt-ins with tests on and off, plus every entry and helper.
- Final states take tags, meta and description.
- The codemod converts the Stately exports in section 4.
- Bars:
  - door 671 (≤ 689): met;
  - every feature listed but unused costs 0, except inspect 565, persist 464 and durable 9: met, each with its reason;
  - job 1,002 (≤ 940): not met;
  - send 24.9M–25.7M ops/s (≥ 26M): not met.

**Decided by the user, 2026-11-10 17:05 +06:**

1. **Where it lives:** move it to `packages/state` (built, packed, under CI's 100% coverage).
2. **Size:** the limit is 1.5 KB gzipped (the job app is at 1,002). Spend the room on speed, type safety and compiler-enforced safety, and catch 200+ mistakes AI agents make, found by researching the web properly.
3. **Send speed:** more speed, within the 1.5 KB limit (it is at 24.9M–25.7M ops/s against 26M).
4. **A machine's shape in another file:** keep the one-file rule (S4).
5. **Calls in transitions:** check same-file functions with the same purity rules, and allow imports only from modules marked pure.

The shape differences are in the README's "Where the shape differs from XState". It extends [`SPEC.md`](SPEC.md), whose rules still hold: Bun and TS only, the Write and Edit tools only, no new dependencies, no commits, own only your files, two layers that never overlap, and every message is the fix. Where the two disagree, this file wins.

The user asked for three things:

1. **"make every feature on top of @reactre/state core opt-in."**
2. **"make @reactre/state have all features from xstate v6 beta except the cli and visual editor."**
3. **"codemod will be able to convert stately visual editor exported xstate sc to @reactre/state sc."**

## 1. What "core" is, and how a feature is opted into

**Core** is the original design, and needs no opt-in:

- `setup({ states, events, internal, input, version })` with `types<T>()`;
- `machine({ start, states })`, with flat states;
- `on` handlers returning `to(state, data)` or `null`;
- `task: { run, error }`, `after: { "5s": … }` and `final: true`;
- `createActor`, `restoreActor`, `transition`, `initial`, `StateError`;
- `@reactre/state/signals`'s `useActor` (renamed from `/reactre` on the user's request; its name says which framework it's for, beside `/react`);
- the compiler and the plugins.

Tasks and timers stay core because they were part of it from the start, and their runtime module is already imported only by a machine that has one.

**Every other feature is opt-in, by import and by name, in setup's `use`:**

```ts
import { setup, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const editor = setup({
  use: [nested, history],
  states: { idle: types<{}>(), "edit.draft": types<{ text: string }>() /* … */ },
  events: {
    /* … */
  },
});
```

- **Each feature is a value exported by its own entry**, `@reactre/state/<feature>`. It carries the feature's runtime hooks, so a bundle holds a feature's code only when the app imports it.
- **The compiler** turns `use` into table fields (for example `g: nested.g`). `use` must be an array literal of imported names: that is codegen's need, and the compiler's to check.
- **Using a feature without its opt-in is a type error** that names the import and the `use` entry. For example: `state "edit.draft" is nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`. Types can see `use`, so this is the type layer's job, not the compiler's. Pin each case in that feature's mistakes file.
- **App-level functions that need a machine's opt-in** (such as `persist`, which needs saved deadlines) are typed so that calling them on a machine without it is a type error naming the opt-in.
  - Code the type checker can't see, such as a machine from an untyped JSON definition, throws a `StateError` naming the same import.
- **Each feature costs nothing until opted into.**
  - **Bars** (esbuild, gzipped, whole app): `test/fixtures/door-app.ts` at 689 bytes or less, and `test/fixtures/job-app.ts` at 940 or less. Those are the sizes before any feature existed; both apps use no opt-in.
  - **Speed:** `compare/bench.ts`'s actor send is back to at least 26M ops/s for the door.
  - **Each opt-in** gets its cost in the README (bytes gzipped, on a fixture), and tests with it on (works) and off (the type error, or the throw).
- **The features from v2 become opt-ins too:**
  - `nested`;
  - `parallel` (needs `nested`; a type error says so);
  - `history`;
  - `children`;
  - `validate` (a Standard Schema in setup without it is a type error);
  - `persist` (saved timer deadlines and `persist()`; without it, `tasks.ts` is the lean runner again);
  - `durable` (the machine needs `use: [durable]` so `durable()` accepts it).

## 2. XState v6 beta, feature by feature

Everything the `xstate` package and its entries (`xstate/actors`, `/graph`, `/durable`, `/persist`, `/validation`, `/fsm`) offer has a place here, except the CLI and the visual editor.

- XState's docs are in `node_modules/.bun/xstate@6.0.0-beta.1/node_modules/xstate/docs/`, and its types are in `…/dist/declarations/src/`.
- Read the doc for each feature you own before designing it.
- Keep this library's principles while matching each feature's capability:
  - data per state, JSON data and pure transitions;
  - one way to do each thing;
  - effects as data, run after the transition;
  - types first.

  Matching the capability doesn't mean copying the syntax. When you choose a different shape, say why in the README.

| Area                             | XState v6 feature (doc)                                                                                                                                                                                                                                                                                           | Here, as an opt-in                                                                                                                                                                                                                                                      | Owner (wave 1) |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Statecharts                      | nested, parallel, history: shallow and deep, parallel inside a region (`statecharts.md`, `parallel-states.md`, `history-states.md`)                                                                                                                                                                               | `nested`, `parallel`, `history`: add shallow history (re-enter the parent's last direct child through its fallback leaf's data) and nested parallel                                                                                                                     | statecharts    |
|                                  | final states with `output`, and a parent's `onDone` (`final-states.md`)                                                                                                                                                                                                                                           | `output`                                                                                                                                                                                                                                                                | statecharts    |
|                                  | choice states (`choice-states.md`), route states and `xstate.route` (`route-states.md`), eventless `always`, `reenter`, wildcard events `*` and `a.*` (`transitions.md`), tags, `meta`, `description` (`states.md`)                                                                                               | `choice`, `route`, `always`, `reenter`, `wildcards`, `tags`                                                                                                                                                                                                             | statecharts    |
|                                  | state input (`state-input.md`)                                                                                                                                                                                                                                                                                    | core already: a state's data _is_ its input. Document the mapping.                                                                                                                                                                                                      | statecharts    |
|                                  | snapshot helpers: `matches`, `can`, `hasTag`, `getMeta`, `matchesState`, `mapState`, `getStateNodes`, `getNextTransitions`, `isUnhandled` (`snapshots.md`, `utilities.md`)                                                                                                                                        | functions in `@reactre/state/utils`, each importable alone                                                                                                                                                                                                              | statecharts    |
| Effects                          | `entry`, `exit`, `enq(fn)`, named actions with params, `enq.raise` (with `delay`, `id`), `enq.cancel`, `enq.sendTo`, `enq.log`, `enq.emit`, `enq.effect` (`actions.md`, `data-and-effects.md`, `emitted-events.md`, `internal-events.md`)                                                                         | `effects`: `entry`/`exit` and `enq` in handlers. Effects are recorded as data during the pure transition and run after it. Plus `emit`, with `actor.on(type                                                                                                             | "*")`          | effects |
|                                  | `setup({ actions, guards, delays })`, `provide`, `extend`, `createStateConfig` (`setup-and-provide.md`), named delays, ISO durations, `timeout` + `onTimeout` (`delays.md`, `timeouts.md`)                                                                                                                        | `provide`, `delays`, `timeout`                                                                                                                                                                                                                                          | effects        |
|                                  | `actor.trigger.x()`, `actor.select(fn)`, selectors (`selectors.md`), `waitFor`, `toPromise`, `assertEvent`, `SimulatedClock`, `inspect`, `logger` (`inspection.md`, `testing.md`)                                                                                                                                 | `select`/`waitFor`/`toPromise`/`assertEvent`/`SimulatedClock` in `@reactre/state/utils`; `inspect`, as an opt-in that costs nothing when off                                                                                                                            | actors         |
| Actors                           | invoke one or many, `onDone`, `onError`, `onSnapshot`, invoke `timeout`; logic creators `createAsyncLogic`, `createCallbackLogic`, `createObservableLogic`, `createEventObservableLogic`, `createStepLogic`, `createListenerLogic`, `createSubscriptionLogic`, `createEmptyActor` (`actor-logic.md`, `invoke.md`) | `logic`: each kind usable as a node's child and as a root actor. `children` already runs machines.                                                                                                                                                                      | actors         |
|                                  | `enq.spawn`, `enq.stop`, `enq.listen`, `enq.subscribeTo` (`spawn.md`, `listen-and-subscribe.md`)                                                                                                                                                                                                                  | `spawn`, built on `effects`' effect registry                                                                                                                                                                                                                            | actors         |
|                                  | systems: `registryKey`, `system.get`, `createSystem`, `systemTransition`, `advanceSystemTime` (`systems.md`, `system-transitions.md`)                                                                                                                                                                             | `system`                                                                                                                                                                                                                                                                | actors         |
|                                  | children on a durable host (S9 today)                                                                                                                                                                                                                                                                             | `durable` + `children`                                                                                                                                                                                                                                                  | actors         |
| Data                             | Standard Schema (`typescript.md`), `xstate/validation`                                                                                                                                                                                                                                                            | `validate`: done; make it opt-in                                                                                                                                                                                                                                        | wave 0         |
|                                  | persistence, `getPersistedSnapshot`, `restoreActor` (`persistence.md`), `machineVersions` and `migrateSnapshot` (`persistence.md`), backend workflows (`backend-workflows.md`)                                                                                                                                    | `persist`, plus migrations: typed `from` version to `to` version                                                                                                                                                                                                        | data           |
|                                  | durable execution (`durable-execution.md`)                                                                                                                                                                                                                                                                        | `durable`: done; make it opt-in                                                                                                                                                                                                                                         | wave 0         |
| Definitions as data, and tooling | `machineToJSON`, `machineConfigToJSON`, `machineFromJSON`, serialization diagnostics (`serialization.md`); SCXML (`scxml.md`)                                                                                                                                                                                     | `@reactre/state/serialize` and `@reactre/state/scxml`                                                                                                                                                                                                                   | data           |
|                                  | `xstate/graph`: `getShortestPaths`, `getSimplePaths`, `getPathsFromEvents`, adjacency maps, `toDirectedGraph`; model-based testing (`model-based-testing.md`)                                                                                                                                                     | `@reactre/state/graph` and `@reactre/state/test`                                                                                                                                                                                                                        | data           |
|                                  | `xstate/fsm`                                                                                                                                                                                                                                                                                                      | core is already this; say so                                                                                                                                                                                                                                            | data           |
|                                  | framework adapters (`frameworks.md`: React, Vue, Svelte, Solid)                                                                                                                                                                                                                                                   | `@reactre/state/signals` (for @reactre/core) exists. A React adapter, `@reactre/state/react` (`useActor`, `useSelector`), using React's `useSyncExternalStore` with `react` as an optional peer already in the catalog. Vue, Svelte and Solid are out of scope; say so. | data           |
| Not in scope                     | the `xstate` CLI and the Stately visual editor                                                                                                                                                                                                                                                                    | the user excluded them                                                                                                                                                                                                                                                  |                |

## 3. Waves and who owns what

Several agents work at once in one checkout. **Wave 0** (one agent, the architect) restructures the code so wave 1's agents never edit the same file.

- **Wave 0, the architect.**
  - Builds the opt-in mechanism (section 1), and moves every v2 feature behind it.
  - Splits the type layer and the compiler by feature: `src/features/<f>/{index.ts (the feature value and its runtime), types.ts}`, `compiler/features/<f>.ts`, and `test/features/<f>/{mistakes.ts, *.test.ts}`.
  - Central registries list every feature in section 2 as a stub that wave 1 fills in, so wave 1 agents edit only their own features' files. This includes the type-level union of state keys and problems, the compiler's feature table, the audit test's case list, and `package.json` exports.
  - Sets up the effect registry for `effects` and `spawn` (an effect descriptor `{ type, … }` that a feature registers a runner for).
  - Brings the core back to its bars.
- **Wave 1, in parallel:**
  - **statecharts:** `nested`, `parallel`, `history`, `output`, `choice`, `route`, `always`, `reenter`, `wildcards`, `tags`, and the snapshot helpers in `utils`.
  - **effects:** `effects`, `emit`, `provide`, `delays`, `timeout`.
  - **actors:** `children`, `logic`, `spawn`, `system`, `inspect`, durable children, and `select`, `waitFor`, `toPromise`, `assertEvent` and `SimulatedClock` in `utils`.
  - **data:** `persist` migrations, `serialize`, `scxml`, `graph`, `test`, `react`, and the `fsm` note.
- **The codemod agent** runs alongside both waves (section 4). It owns only `codemod/**`, `test/codemod.test.ts` and `test/codemod/**`.
- **`utils`:** each wave-1 agent writes its own helpers in its own file, `src/utils/<name>.ts`. `src/utils/index.ts` only re-exports, and the architect pre-lists every helper's file.

## 4. The codemod: Stately Studio exports

The codemod already converts hand-written XState v4, v5 and v6. It must also convert what the Stately visual editor exports, and every XState feature now maps to an opt-in, so `use: [...]` lists what the output needs.

What Stately Studio exports:

- **XState v5 TypeScript.** Either `createMachine({ /** @xstate-layout … */ id, initial, context, states, types: {} as { context; events } }, { actions, actors, guards, delays })`, or `setup({ types, actions, actors, guards, delays }).createMachine({ … })`.
  - Implementations are references: `{ type: "name", params }`, `guard: "name"`, `src: "name"`.
  - Implementation bodies are often stubs: `function ({ context, event }) { /* … */ }`, or `fromPromise(async () => {})`.
  - Nodes may carry `description` and `meta`.
- **XState v4 TypeScript.** `createMachine` with `predictableActionArguments`, `tsTypes: {} as import("./x.typegen").Typegen0`, `schema: { context: {} as …, events: {} as … }`, `cond` and `services`.
- **JSON:** the machine config alone.

How each part converts:

- **Never drop anything silently.** The layout comment is dropped, and the report says so.
- **Stubs:** an implementation whose body is a stub becomes a named stub in the output, a function the user fills in. It gets a TODO and a report line. A guard stub's body is `return false`, which keeps the output's behaviour the same as the export's.
- **Types:**
  - Typed exports keep their context and event types.
  - Untyped JSON gets data types inferred from `context`'s literal, and events with no payload.
  - The report lists every type it guessed.
- **Done means** a Stately export fixture of each kind:
  - is converted;
  - type-checks;
  - compiles with `compile()`;
  - replays the same states as XState for an event sequence (v5 with `xstate`, v6 with `xstate6`).

  Write the fixtures in the form Stately produces. Use your best knowledge of its export format, and say in the report which parts of the format you were unsure of.
