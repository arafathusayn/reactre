# @reactre/state: architecture

How the code is laid out, what each file owns, and how to add a feature end to end. The README says what the library is; this says where things go.

## Two layers, never overlapping

- **The type checker** checks everything a type can express: names, data, the graph, a feature used without its opt-in.
- **The compiler** checks only what types can't see: purity, casts, data's keys at runtime, and what its code generation needs written in place.

`test/compiler.test.ts` enforces the split. It writes every compiler case (the core's, and each feature's from `test/features/<feature>/compiler.ts`) to disk, runs `bun check` on them, and fails if any case is also a type error. A mistake the type checker reports belongs in a `mistakes.ts`, never in the compiler.

## Opt-in features

A feature is a value imported by name from its entry and listed in setup's `use`:

```ts
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const editor = setup({ use: [nested, history], states: { idle: types<{}>(), "edit.draft": types<{ text: string }>() }, events: {} });
```

- **Types.** Each value has the type `Feature<"name">` (a phantom brand), so `Uses<D>` reads the names in `use`. With a feature off, its keys, options and arguments are type errors that name the fix, `add <f> to setup's use (import { <f> } from "@reactre/state/<f>")` (`OptIn<F>` in `src/features.ts`). An app function that needs an opt-in takes `NeedsOptIn<D, F, What>`: off, that is a required key named `<What> needs <f>: <OptIn>`. A feature that needs another (`parallel` and `history` need `nested`) says `<f> needs <g>: <OptIn<g>>`. A string in `use` is a problem naming the import.
- **The compiler.** It keeps the feature's import, drops `use`, and writes the table fields the feature emits, read from the value (`g: nested.g`). It reports a `use` that isn't an array written in place, or an entry that isn't an imported feature's name: the types can't see either.
- **At runtime.** An app function that types can't protect from untyped code (`persist`, `durable`) checks the table's marker, `u: { <f>: 1 }`, and throws StateError S11 naming the import.
- **Code only some machines need.** What a feature needs only beside another feature or a kind of handler lives in a module of its own, which the compiler imports for that machine alone (`Emitted.imports`, deciding with `MachineContext.uses`): durable's children hooks (`dk`, with children), spawn's restore and delays's saved deadlines (with persist), validate's check of a step decided outside a step (a timer's, a task's `error`, a child's report: `Kind.outside` and `FeatureMachine.outside`).
- **Cost.** A feature listed but unused costs 0 bytes (`test/sizes.test.ts` pins it), except `persist` (the general lifecycle) and `durable` (its marker).

## Files and what each owns

### The runtime (`src/`)

| File                                            | Owns                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                      | The core: `setup`, `types`, `machine`'s types, `createActor`, `restoreActor`, `transition`, `initial`, `StateError`, the step (`__step`, `__flat`), `__snap`, the actor loop (`__run`), and the core's type-level checks. It composes the features' types through `features.ts`. |
| `internal.ts`                                   | The compiled table's contract (`__Compiled`), the step and lifecycle contracts, runners, and the effect registry's types. Additive: a feature adds its fields here (or by module augmentation, below).                                                                           |
| `features.ts`                                   | The type registry: every feature's type parts, composed (`FeatureState`, `FeatureKeys`, `FeatureArgs`, `FeatureProblems`, `FeatureShapeProblems`, `OffKeyProblem`, …), plus `Feature`, `Uses`, `OptIn`, `NeedsOptIn`. Its header lists the parts.                                |
| `tasks.ts`                                      | Tasks and timers: `__lean` / `__leanQuick` (the whole lifecycle of a flat machine with tasks or timers) and `__tasks` / `__tasksQuick` (the runner for the general lifecycle). Quick variants are for short ordinary literal delays.                                             |
| `run.ts`                                        | The general lifecycle, `__run(runners, dispatch?)`: the active nodes a move exits, enters and keeps, runners started and stopped per node, and effects dispatched after a move.                                                                                                  |
| `dev.ts`                                        | Development builds: frozen data.                                                                                                                                                                                                                                                 |
| `signals.ts`                                    | `useActor` for `@reactre/core` (`@reactre/state/signals`). The only file that imports `@reactre/core`.                                                                                                                                                                           |
| `features/<f>/index.ts`                         | The feature's value (its runtime hooks) and its app functions.                                                                                                                                                                                                                   |
| `features/<f>/types.ts`                         | The feature's type parts for the registry (the list is in `features.ts`'s header).                                                                                                                                                                                               |
| `entries/{serialize,scxml,graph,test,react}.ts` | Whole entries (`@reactre/state/<entry>`): definitions as JSON, SCXML, paths through the graph, model-based tests, and React's `useActor`/`useSelector`.                                                                                                                          |
| `entries/react-dev.ts`                          | `@reactre/state/react/dev`: the React entry's hooks with a development warning each (M313–M316), the actor's behaviour unchanged. A development build imports it in place of `/react`; production ships none of it.                                                              |
| `utils/<helper>.ts`, `utils/index.ts`           | One helper per file, each at `@reactre/state/utils/<helper>`; `index.ts` re-exports them all.                                                                                                                                                                                    |

### The compiler (`compiler/`)

| File              | Owns                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`        | The core compiler: parsing, setup and `use`, `start`, `on`, `task`, `after`, `final`, purity, casts, data's keys, the table's core fields, and the composition of the features' output (fields, the step hooks in table order, the lifecycle, markers).                                                                                    |
| `feature.ts`      | The feature compiler API: `FeatureCompiler` (options, keys, moves, values, handler kinds, `shape`), `FeatureMachine` (`key`, `move`, `to`, `value`, `call`, `done`, `outside`, `emit`), `MachineContext.uses`, and `Emitted` (fields, `start`, `step`, runners, `tasks`, `lifecycle`, `marker`, `effects`, `dispatch`, `wrap`, `imports`). |
| `run.ts`          | A task's `run` hygiene: work that outlives the state (a `fetch` without the signal, an interval, socket or listener without cleanup), a `catch` that resolves to success, `forEach(async`, a `throw` of a non-Error, a response read without a status check.                                                                               |
| `modules.ts`      | What the compiler reads beside the file it compiles: a relative import's `"use pure"` mark (for calls in transitions), and its exported shapes (S4).                                                                                                                                                                                       |
| `mirror.ts`       | Mirrored states (M324, M325): sibling states that are one state written twice, the difference in their names instead of their data.                                                                                                                                                                                                        |
| `hash.ts`         | The shape hash (M260): `shape: "<hash>"` in a persisted setup, of its version and contracts; a changed contract with the hash kept fails the build.                                                                                                                                                                                        |
| `syntax.ts`       | Syntax helpers over oxc-parser's ESTree, shared by the core and the rule modules.                                                                                                                                                                                                                                                          |
| `features.ts`     | `FEATURES`: every feature's compiler, in table order (a later feature's step wraps an earlier one's).                                                                                                                                                                                                                                      |
| `features/<f>.ts` | The feature's compiler.                                                                                                                                                                                                                                                                                                                    |

### Tests (`test/`)

| File                                                                                                                           | Owns                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources.ts`                                                                                                                   | The correct machines as source text (DOOR, JOB, EDITOR, PLAYER, PAGE, FORM), `change`, `withUse`, and the `Case` type.                         |
| `compiler.test.ts`                                                                                                             | Compiler output, the core's compiler cases, the `use` cases, every feature's cases, and the audit ("no compiler case is also a type error").   |
| `mistakes.ts`                                                                                                                  | The core's mistakes, each a `@ts-expect-error`, with exact wording pinned by `Equal`.                                                          |
| `explain.ts`                                                                                                                   | Prints what `bun check` says for every mistake, the features' included.                                                                        |
| `sizes.test.ts`, `fixtures/sizes/*.ts`                                                                                         | The bars, and each opt-in's cost (listed and used).                                                                                            |
| `bundlers.test.ts`                                                                                                             | The door and job apps through Vite, esbuild, Rolldown and Bun.                                                                                 |
| `actor.test.ts`, `nested.test.ts`, `tasks.test.ts`, `persist.test.ts`, `durable.test.ts`, `actors.test.ts`, `validate.test.ts` | The runtime, on compiled fixtures and hand-written tables.                                                                                     |
| `features/<f>/mistakes.ts`                                                                                                     | The feature's mistakes, its opt-in case first.                                                                                                 |
| `features/<f>/<f>.test.ts`                                                                                                     | The feature's tests, starting with `optIn` (`features/opt-in.ts`): `use: [f]` compiles, keeps the import, and adds what it adds.               |
| `features/<f>/compiler.ts`                                                                                                     | The feature's compiler cases (`cases: Case[]`). `features/compiler.ts` already imports every one: adding a case edits only the feature's file. |

## Contracts

### The table (`__Compiled`, `src/internal.ts`)

| Field                             | Owner                          | Meaning                                                                                      |
| --------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `v`, `e`, `i`, `o`, `f`, `t`, `a` | core                           | version, sendable events, start, handlers by node, final leaves, tasks, timers               |
| `r`                               | core                           | the lifecycle: `__lean` or `__run([...runners], dispatch?)`; none for a machine without work |
| `y`                               | features                       | the step hook; features in table order wrap the one before (`validate.v(nested.y)`)          |
| `u`                               | features                       | markers that app functions check (`persist`, `durable`)                                      |
| `d`                               | dev                            | freezes data                                                                                 |
| `g`, `p`, `n`, `h`                | nested, parallel, history      | node graph; regions; a parallel node's `done`; parents `back` goes to                        |
| `c`                               | children                       | a node's children                                                                            |
| `lg`                              | logic                          | actor logic's kind or id (a table built at runtime)                                          |
| `id`                              | inspect                        | the actor's id in inspection                                                                 |
| `sp`                              | spawn                          | the machines `enq.spawn` starts, by name                                                     |
| `dk`                              | durable (with children)        | the hooks that journal a durable run's children (@reactre/state/durable/children)            |
| `s`, `x`, `z`                     | validate                       | schemas; validate; check restored data (and `i` wrapped by `validate.i`)                     |
| `od`                              | output                         | a parent's `done`, when a leaf under it is final                                             |
| `ch`, `ro`, `al`, `re`            | choice, route, always, reenter | a choice leaf's decision; a routable node's handler; eventless transitions; re-entered nodes |
| `k`                               | tags                           | each node's tags, meta and description                                                       |
| `b`                               | effects                        | each node's `entry` and `exit`                                                               |
| `j`                               | provide                        | setup's named actions                                                                        |
| `l`, `w`                          | delays, timeout                | timers resolved at entry; setup's named delays                                               |

A new feature adds its own fields. Free one-letter fields: `m q`. Two ways to add one: edit `__Compiled` (the coordinator merges), or augment it from the feature's `types.ts`, which needs no shared edit:

```ts
declare module "../../internal.ts" {
  interface __Compiled {
    /** Tags by leaf (@reactre/state/tags). */
    readonly k?: { readonly [leaf: string]: readonly string[] | undefined };
  }
}
```

### The step and the lifecycle

- `__Step`, what a handler returns: a `to` compiles to the snapshot itself, `({ state, data, version })` (`__To`; data-less states share the frozen `__none`), so a flat step allocates only its snapshot and its result. `back` compiles to `({ b, t, s? })` and `reenter` to `({ r: <to> })`. A graph builds a parallel node's regions as `{ state, data }` units, never the region's step. A feature compiler builds a `to` with `HandlerContext.step`.
- `__StepHook = (m, from, event, internal) => __Result`. A feature's hook calls the inner hook it wraps, or `__flat(m, from, event)` at the base.
- `__Lifecycle = (m, move, current, options) => __Live`, with `enter(next, active, result)` after every move and `stop()`. `__Live.works` (the general lifecycle) is what `child` and `persist` read.
- `__Runner = { id, start(m, node, ctx) }`, for the general lifecycle: a node's work, with `save` for `persist`.

### The effect registry (`src/internal.ts`, "The effect registry")

- An effect is data, `__Effect { type, ... }`. A handler records it during a pure transition, and the step returns it on the ok result's `fx`. `transition()` returns effects unrun.
- `enq` reaches a handler only with `effects` in use: the compiler compiles each reference to a destructured `enq` into `<effects import>.enq` (the feature's `values: ["enq"]` and `value()` hook). The effects feature's step hook opens a recording around the inner step and puts what was recorded on `fx`. Its types give `enq` in `Args` when on; off, `enq` must be a type error naming the import (wave 1: `effects/types.ts`'s `Args`, which `features.ts` turns into the fix when off).
- Runners are registered per effect type by the feature that defines the type, as data: each feature value carries a `__EffectRunners` map (`Emitted.effects`), and the effects feature's `Emitted.dispatch` builds one `__Dispatch` from the maps of the features in use (`r: __run(runners, dispatch)`). Nothing registers at import time, so a bundle drops the runners of features not in use. An effect without a runner throws, naming its feature's import.
- `run.ts` calls `dispatch(result.fx, { deliver, go, now, snapshot, live })` after the move. A move that isn't a step (a timer's, a task's `error`, a child's report) is settled through effects's wrap of the lifecycle (`effects.l(__run(...))`) before it reaches the actor, so its entry and exit effects run too.

## Adding a feature, end to end

1. **Types** (`src/features/<f>/types.ts`): fill the parts. `Keys`/`State` for node keys, `Args` for handler arguments, `Options` for setup options, `Problems`/`ShapeProblems` for its checks when on, `OffKeys`/`OffProblems` for what means it's used when off, `Needs` for features it needs. `features.ts` already composes every feature's parts.
2. **Runtime** (`src/features/<f>/index.ts`): the value, `Feature<"<f>">` plus its hooks, as an interface so errors name it. App functions take `NeedsOptIn<D, "<f>", "<call>">` and check `u` (via `marker`) when untyped code can reach them.
3. **Table fields** (`src/internal.ts`, or augmentation): new one-letter fields, documented.
4. **Compiler** (`compiler/features/<f>.ts`): `options`, `keys`, `moves`, `values`, `kinds`, and `shape(ctx).machine(ctx).emit()` returning its fields, step, runners, lifecycle, marker and effect runners. Only checks the types can't make.
5. **Tests**: `test/features/<f>/mistakes.ts` (the opt-in case first, exact wording with `Equal` where it can be), `<f>.test.ts` (`optIn("<f>", adds?)` and runtime tests), `compiler.ts` (its cases).
6. **Sizes**: listed-and-unused must stay 0 in `test/sizes.test.ts` (or say why not, with a budget); add a used-app fixture in `test/fixtures/sizes/<f>.ts` with its budget.
7. **Docs**: the feature's header comment (design decisions), and the README's feature list.

## Size and speed bars

esbuild, minified, gzipped, the whole app (`test/sizes.test.ts`, `test/bundlers.test.ts`):

| What                                                                    | Bar      | Now                                                          |
| ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| door (a plain machine)                                                  | ≤ 1.5 KB | 728 (pinned at 728)                                          |
| job (a flat machine with a task and a timer)                            | ≤ 1.5 KB | 1053 (pinned at 1060)                                        |
| a feature listed but unused                                             | 0        | 0, except inspect 566, persist 467 and durable 10            |
| actor send, the door (`bun packages/state/compare/bench.ts`, run alone) | fastest  | 120.9M ops/s (Bun; next @escapace/fsm 75.2M), about 60M (V8) |
| pure transition, the door                                               | fastest  | 159.8M ops/s (next `xstate/fsm` 33.2M)                       |
| create, subscribe, stop                                                 | fastest  | 35.5M ops/s (next @doeixd/machine 19.8M)                     |

A new standalone speed benchmark has not been qualified after these reductions; the three speed rows above are historical, not evidence about the current tree.

Each used-feature app has its budget pinned in `test/sizes.test.ts`; no budget was relaxed. Persist retains its validation at 3273/3275, including own `__proto__` data. The durable pins pass. Ordinary short literal delays use plain timers; long, restored and computed delays retain the split scheduler.

## Ownership in wave 1

Each agent owns its features' files in all five places: `src/features/<f>/`, `compiler/features/<f>.ts`, `test/features/<f>/`, `test/fixtures/sizes/<f>.ts`, and its rows in `test/sizes.test.ts`'s lists. Shared files (`src/index.ts`, `src/internal.ts`, `src/features.ts`, `compiler/index.ts`, `compiler/feature.ts`, `package.json`, the READMEs) are the coordinator's: ask for a change, or use augmentation.

| Agent       | Features                                                                           | Also                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| statecharts | nested, parallel, history, output, choice, route, always, reenter, wildcards, tags | `src/utils/{matches,matchesState,getStateNodes,hasTag,getMeta,mapState}.ts`, `src/entries/{scxml,graph}.ts`, `test/nested.test.ts` |
| effects     | effects, emit, provide, delays, timeout                                            | the effect registry's implementation in `run.ts`'s dispatch call, `src/utils/{can,getNextTransitions,isUnhandled,assertEvent}.ts`  |
| actors      | children, logic, spawn, system, inspect                                            | `src/utils/{select,toPromise,waitFor}.ts`, `src/entries/react.ts`, `test/actors.test.ts`                                           |
| data        | validate, persist, durable                                                         | `src/tasks.ts`, `src/utils/SimulatedClock.ts`, `src/entries/{serialize,test}.ts`, `test/{tasks,persist,durable,validate}.test.ts`  |
