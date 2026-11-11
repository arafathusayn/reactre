# @reactre/state vs the TypeScript state machine libraries

Measured on 2026-11-10, Bun 1.4.4, macOS arm64, against XState v6 beta (`xstate@6.0.0-beta.1`, with `xstate/fsm`) and v5, @escapace/fsm 6.1.1, typescript-fsm 1.6.0, jssm 5.164.1, yay-machine 1.5.0, @doeixd/machine 1.6.0, @xstate/store 4.3.0, robot3 1.4.0 and @stateforward/hsm 2.0.0. @zag-js/core isn't measured: it only defines machines, and the code that runs one is in its framework packages. Every library runs its production build, ours included ([`production.ts`](production.ts)). Every number comes from a script in this folder; rerun them to check:

```bash
bun --conditions=development packages/state/compare/mistakes.ts
bun packages/state/compare/size.ts
bun packages/state/compare/bench.ts         # alone: nothing else running
bun packages/state/compare/v8-profile.ts time actor   # the same cases in V8 (headless Chrome)
```

## The verdict

- **Fastest in every case each library has.** An actor's send runs at 120.9M ops/s: 1.6× @escapace/fsm, the next, and 199× XState v6. A pure transition runs at 159.8M: 4.8× `xstate/fsm`, the next. Creating, subscribing and stopping an actor runs at 35.5M: 1.8× @doeixd/machine, the next. In V8 (headless Chrome), sends run at about 60M, pure transitions at 220M, and creating an actor at 62M.
- **The fewest bytes for every app.** The door is 726 gzipped, against robot3's 1,163, the next. The job, with a task and a timer, is 1,058 against yay-machine's 1,498. The door without an actor is 483 against `xstate/fsm`'s 692. XState v6 ships 28–40× more.
- **Every mistake caught before the program runs:** 516 distinct mistakes AI agents make, each pinned by a test as a type error or a build error whose message is the fix ([`MISTAKES.md`](MISTAKES.md)). They come from two rounds of research: Stately's docs, XState's issues and discussions, the other libraries' issue trackers, StackOverflow, papers and tool teams' reports on LLM-written TypeScript, and write-ups of app workflows (typeahead, payments, auth, uploads, persistence). Made in every library's port of the same apps (256 cases), it catches all 254 it can express, 100%. The next is @xstate/store with 35%; XState v6 catches 22%. Of the 84 cases every library can express, it catches 84, and the next catches 25.
- **Every feature of XState v6 beta** except the CLI and the visual editor, each an opt-in that costs nothing unless listed ([the README's table](../README.md#opt-ins)).

Where it doesn't win:

- **Tooling XState has alone:** a visual editor and the `xstate` CLI (inspect, simulate, test). Vue, Svelte and Solid adapters (here: @reactre/core and React only).
- **Different shapes:** no `assign` (each state's data is given by `to`), so `entry` and `exit` can't write data; output is the final leaf's data; spawned children are reached by name and key. The README lists each, with why.
- **Bytes per feature:** a machine that uses many features ships more than the door: 5,320 gzipped for spawn with children and effects, still under a fifth of XState's actor runtime.
- **Maturity:** XState has years of users, docs and an ecosystem. This is new.
- **Not measured: a model writing machines.** See "Threats to validity".

## 1. Mistakes: where each is caught

[`mistakes.ts`](mistakes.ts) makes each mistake in every library's port of the same two apps: the door (`../test/fixtures/door.ts`, and `<library>/door.ts`) and the job, with a task and a timer (`job.ts`). There are 256 cases, each a row of [`MISTAKES.md`](MISTAKES.md), in twelve groups: targets and data, JSON contracts, events and sending, the graph, tasks, timers, pure transitions, persistence, use sites and escape hatches, React and app code, flows and modeling, and habits from older XState. Each library's mistakes are written in its own idioms, as its docs write them ([`mistakes/<library>.ts`](mistakes); the guide for writing them is at the top of [`mistakes/cases.ts`](mistakes/cases.ts)). A case's cell is the first check that reports it:

- **type:** `bun check` reports an error in the case's file.
- **build:** the library's build fails. Only @reactre/state has one: its compiler, which the bundler plugin runs.
- **start:** importing the file and sending the app's events, in the library's development build, throws, rejects, errors the actor, or warns or logs an error that the correct port doesn't.
- **silent:** the program builds and runs, and does the wrong thing.
- **n/a:** the library can't express the mistake (it has no such feature, or what the row calls a mistake is how the library is written). Each says why in one line.

| Library           | Caught before running (type + build) | Of the cases it can express | At start | Silent | n/a |
| ----------------- | ------------------------------------ | --------------------------- | -------- | ------ | --- |
| @reactre/state    | 254 (136 + 118)                      | 254/254, 100%               | 0        | 0      | 2   |
| XState v6 beta    | 53                                   | 53/236, 22%                 | 21       | 162    | 20  |
| XState v5         | 44                                   | 44/221, 20%                 | 4        | 173    | 35  |
| robot3            | 27                                   | 27/126, 21%                 | 8        | 91     | 130 |
| @xstate/store     | 50                                   | 50/143, 35%                 | 1        | 92     | 113 |
| typescript-fsm    | 31                                   | 31/100, 31%                 | 9        | 60     | 156 |
| yay-machine       | 63                                   | 63/227, 28%                 | 4        | 160    | 29  |
| @doeixd/machine   | 44                                   | 44/139, 32%                 | 5        | 90     | 117 |
| @stateforward/hsm | 36                                   | 36/217, 17%                 | 1        | 180    | 39  |
| @escapace/fsm     | 36                                   | 36/130, 28%                 | 5        | 89     | 126 |
| jssm              | 35                                   | 35/131, 27%                 | 1        | 95     | 125 |

A library with fewer features has more n/a, and its share counts only what it can express. So the fairest comparison is the 84 cases every library can express:

| Library           | Caught before running | At start | Silent |
| ----------------- | --------------------- | -------- | ------ |
| @reactre/state    | 84                    | 0        | 0      |
| XState v6 beta    | 23                    | 8        | 53     |
| XState v5         | 19                    | 2        | 63     |
| robot3            | 18                    | 6        | 60     |
| @xstate/store     | 25                    | 1        | 58     |
| typescript-fsm    | 21                    | 7        | 56     |
| yay-machine       | 25                    | 2        | 57     |
| @doeixd/machine   | 23                    | 4        | 57     |
| @stateforward/hsm | 12                    | 1        | 71     |
| @escapace/fsm     | 23                    | 4        | 57     |
| jssm              | 18                    | 1        | 65     |

Every case in every library is in [`results/mistakes.md`](results/mistakes.md), and each check's message in [`results/mistakes.json`](results/mistakes.json). To see one case's messages in every library: `bun --conditions=development packages/state/compare/mistakes.ts --case=M12`.

169 cases are caught before running by @reactre/state alone. By group: 52 in tasks (a `fetch` not given the signal, a catch that resolves to success, a response read without a status check, a promise not awaited, a stub that fakes success), 39 in pure transitions (the clock, randomness, module state, a call to an impure function, a locale-dependent method, `.sort()` with no compare function, `||` for a default), 28 in JSON contracts (a `Date`, `any`, a `Map`, a class instance or a DOM node in data, which a snapshot or a saved state then breaks on), 16 at use sites (casts, `@ts-` comments, a field made optional to quiet an error, a `switch` with a `default`, an async listener, one actor shared by every request), 9 in targets and data, 8 in timers (a negative, zero or misspelled duration, one past setTimeout's limit), 5 in events (a send to a stopped actor, its result dropped, `await` on `send`), 5 in the graph (a task state nothing but its result leaves), 3 in persistence, 3 in React and app code, and 1 in flows.

None of ours is left: every case @reactre/state can express is caught before running, and every case's message names the fix, except where TypeScript's own message is the only one a type can give (a duplicate key, an assignment to a readonly field; the catalog marks each). Our 2 n/a: no event name is reserved (M55), and a snapshot is JSON by type, so nothing live can be left out of it (M265).

The compiler is for what `bun check` can't see, and its table is not an independent second diagnostic pass of every input. Both layers report 14 comparison cases because each mutation breaks two distinct rules, not because those compiler rules should all be deleted. [`../test/compiler.test.ts`](../test/compiler.test.ts) fails if a compiler case is also a type error, or a type case also a compiler problem. In 14 cases here both report, because the case's code breaks two rules, one for each layer: a class instance in data is a type error (data is JSON), and the `new` that makes it in a transition is a build error (M25–M31; M23 and M71 likewise pair a type rule with a transition's rule); a send of a payload the event doesn't take is a type error, and its result dropped while a state doesn't handle it is a build error (M44–M46); and two are the compiler's restrictions on code it compiles (a state's name written as a number, M419, and a task written as a bare function, M614), which the type also refuses. The harness also checks every @reactre/state case against the row of `MISTAKES.md` that pins it, and all match.

The others' strengths show here too. XState's types catch the v4 and v5 habits with messages that name the replacement (`` `guard` was removed from transition objects in v6. Use a transition function… ``), and yay-machine, @xstate/store and @escapace/fsm type a state's data as well as we do in the simple cases (a missing field, a field of the wrong type, data only another state has).

The comparison runs only the two flat app ports, not ecosystem plugins or adapters for features they don't exercise. A missing equivalent primitive is n/a only when the case cannot be expressed; task status, purity, and timing checks use the library's actual transition/task boundary rather than labeling all user code invalid. `M427` is n/a for libraries whose persisted version is a string (XState's `"1.0.0"`), not a claim that other versions are unserializable. `M584` tests the specific overlap from an async subscribe listener; it does not say every library lacks durable writes. `M77` requires handling 4xx/5xx before reading as success, while successful 201/204 statuses remain accepted.

## 2. Bytes shipped

[`size.ts`](size.ts) bundles the same apps for production (minified, one ES module) and runs each bundle. Bytes are of the whole bundle, app code included; each library's port is in its folder here (`robot3/`, `yay/`, …), written the way its docs write one. Gzipped, esbuild (Rolldown's are within a few percent; `size.ts` prints both):

| Door: an actor, plain transitions | gzip   | vs ours | Job: an actor, a task and a timer | gzip   | vs ours | Door: pure transitions | gzip   | vs ours |
| --------------------------------- | ------ | ------- | --------------------------------- | ------ | ------- | ---------------------- | ------ | ------- |
| **@reactre/state**                | 726    | —       | **@reactre/state**                | 1,058  | —       | **@reactre/state**     | 483    | —       |
| robot3                            | 1,163  | 1.6×    | yay-machine                       | 1,498  | 1.4×    | `xstate/fsm`           | 692    | 1.4×    |
| yay-machine                       | 1,334  | 1.8×    | @stateforward/hsm                 | 8,350  | 7.9×    | @doeixd/machine        | 2,540  | 5.3×    |
| typescript-fsm                    | 1,460  | 2.0×    | XState v5                         | 13,513 | 12.8×   | @xstate/store          | 3,178  | 6.6×    |
| @doeixd/machine                   | 2,541  | 3.5×    | XState v6 beta                    | 29,192 | 27.6×   | XState v5              | 13,236 | 27.4×   |
| @xstate/store                     | 3,154  | 4.3×    |                                   |        |         |                        |        |         |
| @escapace/fsm                     | 7,743  | 10.7×   |                                   |        |         |                        |        |         |
| @stateforward/hsm                 | 8,156  | 11.2×   |                                   |        |         |                        |        |         |
| XState v5                         | 13,072 | 18.0×   |                                   |        |         |                        |        |         |
| XState v6 beta                    | 29,101 | 40.1×   |                                   |        |         |                        |        |         |
| jssm                              | 51,030 | 70.3×   |                                   |        |         |                        |        |         |

Only libraries with tasks and timers have a job port, and only those with a pure transition function have a pure one; each port's header says what it can't express.

## 3. Speed

[`bench.ts`](bench.ts) runs the door in each library, each (library, case) in its own process, one after another, nothing else running: the median of 7 rounds after a warm-up, and the median of 3 processes (one process's JIT can settle on a slower plan for its whole life). Each case first checks that push opens the door and close closes it, so no library is timed doing nothing.

| Send through an actor (1 listener) | ops/s  | vs ours | Pure transition, no actor | ops/s  | vs ours | Create, subscribe, stop | ops/s | vs ours |
| ---------------------------------- | ------ | ------- | ------------------------- | ------ | ------- | ----------------------- | ----- | ------- |
| **@reactre/state**                 | 120.9M | —       | **@reactre/state**        | 159.8M | —       | **@reactre/state**      | 35.5M | —       |
| @escapace/fsm                      | 75.2M  | 1.6×    | `xstate/fsm`              | 33.2M  | 4.8×    | @doeixd/machine         | 19.8M | 1.8×    |
| typescript-fsm                     | 42.2M  | 2.9×    | @doeixd/machine           | 32.0M  | 5.0×    | @escapace/fsm           | 14.5M | 2.4×    |
| jssm                               | 26.6M  | 4.6×    | @xstate/store             | 16.5M  | 9.7×    | robot3                  | 10.2M | 3.5×    |
| yay-machine                        | 19.3M  | 6.3×    | XState v5                 | 0.36M  | 446×    | typescript-fsm          | 7.8M  | 4.6×    |
| @doeixd/machine                    | 18.9M  | 6.4×    |                           |        |         | yay-machine             | 7.2M  | 4.9×    |
| @xstate/store                      | 11.9M  | 10.2×   |                           |        |         | @xstate/store           | 3.1M  | 11.4×   |
| robot3                             | 11.5M  | 10.5×   |                           |        |         | @stateforward/hsm       | 2.7M  | 13.1×   |
| @stateforward/hsm                  | 4.6M   | 26.2×   |                           |        |         | jssm                    | 0.73M | 48.6×   |
| XState v5                          | 0.97M  | 125×    |                           |        |         | XState v6 beta          | 0.56M | 63.4×   |
| XState v6 beta                     | 0.61M  | 199×    |                           |        |         | XState v5               | 0.55M | 64.7×   |

Where a library has no subscribe (typescript-fsm, hsm) its one listener is called from each transition's callback or entry, and where it has no stop the create case drops or unsubscribes; `bench.ts` prints these notes beside each row.

What made it fast, each kept only when the benchmark showed it faster in Bun and in V8 (the profiles are `bun --cpu-prof-md` and [`v8-profile.ts`](v8-profile.ts)): the compiled `to()` is the snapshot itself (no tuple, one object fewer a step); states with no data share one frozen empty object; listeners are an array, copied only on unsubscribe; the step calls a hooked or a flat step directly, so the flat one stays monomorphic; there's no listener round without listeners; and an actor's start enters its state without a move. Before this, `bench.ts` timed our development build (data deep-frozen on every step) against the others' production builds.

## 4. What each has that the other doesn't

Both have the same statechart, effect, actor, data and tooling features: everything XState v6 beta offers except its CLI and visual editor has a counterpart here. Each library also has a codemod (XState's from v5, ours from XState and Stately's exports).

| Only @reactre/state                                                                                         | Only XState v6 beta                                                   |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Each state's own data; no shared context to keep consistent                                                 | `assign`, and `entry`/`exit` that write context                       |
| The graph checked by types, hierarchy and children included: unreachable, dead ends, a region with no final | Spawned children held as refs in context                              |
| Exact data through spreads; JSON-only contracts (no `any`, `unknown`, `{}`, `Date`), schemas' output too    | Vue, Svelte and Solid adapters                                        |
| Pure transitions enforced at build time; casts and suppressions refused                                     | A visual editor, the `xstate` CLI (inspect, validate, simulate, test) |
| `send` returns why it didn't move (`unhandled`, `declined`, `unknown`, `invalid`, `inactive`)               | Years of production use, docs and integrations                        |
| Every feature opt-in: one not listed costs 0 bytes, and one used without its opt-in is a type error         |                                                                       |

## Threats to validity

- **One author wrote every side.** The XState ports follow its shipped `docs/agents.md`, `typestates.md` and `fsm.md`; the others follow each library's README and types. Some libraries can't express the door as written (no per-state data, no guards, no subscribe or stop), and each port's header says what it uses instead. A correction to a port that changes a row is welcome: the scripts rerun in seconds.
- **The catalog was written for this library.** Its rows come from XState's docs, issues and discussions and from studies of LLM-written code, but they were chosen while this library was designed to catch them, and that favours it. It marks honestly what no checker catches (39 logic/policy rows) and what this design makes impossible to write (18). The comparison has 256 mutations: ours expresses 254 and every rival library is asked to make each of the others that it can express, or justify n/a. Rows about features the apps don't have (nested, parallel and history states, children, effects) aren't run against the others.
- **Agents wrote the other libraries' mistakes.** Each was asked to write a mistake as that library's docs write the library, and to mark n/a only where the library can't express it, with the reason. A case judged wrong, as too contrived or n/a where it should be silent, is welcome as a correction: `--lib=<library> --case=<id>` reruns it in seconds.
- **Microbenchmarks.** The door is small; a real app's time goes to its own code. The ratios say how much each library adds, not how fast an app is.
- **Not measured: a model writing machines.** The real test of "a library a model gets right" is an eval: the same tasks given to a model with each library's docs, scored on how many machines are correct after the model reads `bun check`'s output. That eval isn't here yet.
