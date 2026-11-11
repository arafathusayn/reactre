// The mistakes a model makes writing a machine, each a type error. `bun check` fails if one of
// them stops being an error (an unused @ts-expect-error is an error too). `bun explain.ts` prints
// what each error says, as a model reading `bun check` sees it.

import {
  createActor,
  initial,
  type MachineError,
  setup,
  type ShapeCheck,
  transition,
  type Type,
  types,
} from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const door = setup({
  states: {
    closed: types<{}>(),
    open: types<{ by: string }>(),
    locked: types<{ code: string }>(),
  },
  events: {
    push: types<{ by: string }>(),
    close: types<{}>(),
    lock: types<{ code: string }>(),
    unlock: types<{ code: string }>(),
  },
});

// The correct machine, for the actor and snapshot cases below.
export const good = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ data, event, to }) => (event.code === data.code ? to("closed") : null) } },
  },
});

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        // @ts-expect-error 1. A misspelled target.
        push: ({ event, to }) => to("opne", { by: event.by }),
        // @ts-expect-error 2. A missing field in the target's data.
        lock: ({ to }) => to("locked", {}),
      },
    },
    open: {
      on: {
        // @ts-expect-error 3. Data for a state that takes none.
        close: ({ to }) => to("closed", {}),
      },
    },
    locked: {
      on: {
        // @ts-expect-error 4. A field the target's data doesn't have.
        unlock: ({ data, to }) => to("open", { by: data.code, at: 1 }),
      },
    },
  },
});

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        // @ts-expect-error 6. A field the event doesn't carry.
        push: ({ event, to }) => to("open", { by: event.name }),
        // @ts-expect-error 7. A field of another state's data.
        lock: ({ data, to }) => to("locked", { code: data.code }),
      },
    },
    open: {
      on: {
        close: ({ data, to }) => {
          // @ts-expect-error 8. Editing data in place: it's readonly, build the next state's data.
          data.by = "";
          return to("closed");
        },
      },
    },
    locked: {
      on: {
        // @ts-expect-error 9. Forgetting `return` in a block body.
        unlock: ({ to }) => {
          to("closed");
        },
      },
    },
  },
});

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        // @ts-expect-error 10. XState's string target.
        push: "open",
        // @ts-expect-error 11. XState's transition object with a guard and actions.
        lock: { target: "locked", guard: "valid", actions: "save" },
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});

door.machine({
  start: ({ to }) => to("closed"),
  // @ts-expect-error 12. A state left out.
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

// 5, 13 and the keys of other libraries: a const type parameter gets no excess property check,
// so the machine's type lists them, and using it fails, quoting them.
const extra = door.machine({
  id: "door",
  initial: "closed",
  context: {},
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      entry: () => {},
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        // @ts-expect-error 5. A misspelled event gets no types: its handler's `to` is implicitly any, here.
        psuh: ({ to }) => to("open", { by: "" }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") }, invoke: { src: "x" }, always: [] },
    locked: { on: { unlock: ({ to }) => to("closed") } },
    broken: { type: "final" },
  },
});
expect<
  Equal<
    typeof extra,
    MachineError<
      | '"id" is not a machine option'
      | '"initial" is not a machine option: use start: ({ to }) => to(state, data)'
      | `"context" is not a machine option: each state's data is declared in setup's states, and given by to(state, data)`
      | 'state "broken" is not in the shape: add it to setup\'s states, or remove it'
      | 'state "broken" has "type", which states don\'t take: use final: true'
      | 'state "broken" is a dead end: no transition leaves it. Add one, or mark it { final: true }'
      // wave1-effects: entry and exit are the effects opt-in's keys.
      | `state "closed" has "entry": add effects to setup's use (import { effects } from "@reactre/state/effects")`
      | `state "closed" handles "psuh", which is not an event in the shape: check the name, or add it to setup's events`
      | `state "open" has "invoke", which states don't take: use task: { run, error }`
      // wave1-statecharts: always is an opt-in now.
      | `state "open" has "always": add always to setup's use (import { always } from "@reactre/state/always")`
    >
  >
>();
// @ts-expect-error 5, 13. A misspelled event, a state the shape lacks, and XState's keys.
createActor(extra);

// 14, 15. Both lose their handlers' types (implicitly any, on their own lines), and the machine's
// type names them.
const misshapen = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: {
      on: { close: ({ to }) => to("closed") },
      // @ts-expect-error 14. A duration without a unit the library knows.
      after: { "5 sec": ({ to }) => to("closed") },
    },
    // @ts-expect-error 15. A final state that handles events.
    locked: { final: true, on: { unlock: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof misshapen,
    MachineError<
      | 'state "open" has a timer "5 sec": write a number and a unit, "500ms", "5s", "2m" or "1h"'
      | 'state "locked" is final and has "on": a final state takes no events, tasks or timers. Remove it, or drop final'
    >
  >
>();
// @ts-expect-error 14, 15. Using the machine quotes both.
createActor(misshapen);

// 16-18. The graph: the problems are the machine's type, so using it fails, quoting them.
const unreachable = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }), lock: () => null } },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof unreachable,
    MachineError<'state "locked" is unreachable: no transition goes to it. Add one, or remove the state'>
  >
>();
// @ts-expect-error 16. A state no transition goes to.
createActor(unreachable);

const deadEnd = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed"), unlock: () => null } },
    locked: {},
  },
});
expect<
  Equal<
    typeof deadEnd,
    MachineError<'state "locked" is a dead end: no transition leaves it. Add one, or mark it { final: true }'>
  >
>();
// @ts-expect-error 17. A state that never leaves, and isn't final.
initial(deadEnd, undefined);

const job = setup({
  states: {
    idle: types<{}>(),
    saving: types<{ text: string }>(),
    saved: types<{ id: string }>(),
    failed: types<{ error: string }>(),
  },
  events: { save: types<{ text: string }>(), retry: types<{}>() },
  internal: { stored: types<{ id: string }>() },
});
const ignored = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { retry: ({ to }) => to("idle") },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof ignored,
    MachineError<
      | 'state "saved" is unreachable: no transition goes to it. Add one, or remove the state'
      | 'state "saving" ignores its task\'s event "stored": add a handler for it to the state\'s "on"'
    >
  >
>();
// @ts-expect-error 18. A task's result that its state doesn't handle.
createActor(ignored);

job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      // @ts-expect-error 19. A task without an error handler: every task can fail.
      task: { run: async ({ data }) => ({ type: "stored", id: data.text }) },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});

job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        // @ts-expect-error 20. A task that resolves to an event the shape doesn't declare.
        run: async ({ data }) => ({ type: "done", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});

// The actor and the snapshot.
const actor = createActor(good);
// @ts-expect-error 21. An event the machine doesn't declare.
actor.send({ type: "kick" });
// @ts-expect-error 22. An event without its payload.
actor.send({ type: "push" });
const snapshot = actor.snapshot();
// @ts-expect-error 23. Data read before narrowing on the state.
snapshot.data.by;
if (snapshot.state === "open") snapshot.data.by.toUpperCase();
// @ts-expect-error 24. A state name that doesn't exist, in a comparison.
if (snapshot.state === "opened") snapshot.data;
transition(good, snapshot, { type: "lock", code: "1" });

const jobs = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
// @ts-expect-error 25. Sending a task's internal event from outside.
createActor(jobs).send({ type: "stored", id: "1" });

// The shape.
// @ts-expect-error 26. Data JSON can't hold: a snapshot couldn't be saved and restored.
setup({
  states: { idle: types<{ at: Date; onDone: () => void }>() },
  events: {},
});
// @ts-expect-error 27. A payload field named `type`, which is the event's name.
setup({
  states: { idle: types<{}>() },
  events: { go: types<{ type: string }>() },
});
// @ts-expect-error 29. `any` in data turns every check after it off.
setup({ states: { idle: types<{ x: any }>() }, events: {} });
// @ts-expect-error 30. `unknown` in a payload: the handler would have to cast.
setup({ states: { idle: types<{}>() }, events: { go: types<{ x: unknown }>() } });
// @ts-expect-error 31. An index signature: any key reads as present.
setup({ states: { idle: types<{ [key: string]: string }>() }, events: {} });
// @ts-expect-error 36. A field typed {} accepts a string, an array or a function.
setup({ states: { idle: types<{ meta: {} }>() }, events: {} });
// @ts-expect-error 37. So does `object`.
setup({ states: { idle: types<{ meta: object }>() }, events: {} });
// @ts-expect-error 38. A tuple: positions a model misreads; an array or named fields instead.
setup({ states: { idle: types<{ at: [number, number] }>() }, events: {} });
// @ts-expect-error 39. A misspelled setup option, which an inferred shape doesn't check.
setup({ states: { idle: types<{}>() }, events: {}, verison: 2 });
// Arrays, nested objects, null and literal unions are JSON.
setup({
  states: { idle: types<{ tags: string[]; at: { x: number }[]; note: string | null; kind: "a" | "b" }>() },
  events: {},
});

// 32. Data through a spread, which TypeScript doesn't check for extra keys: `to` does.
const spreads = setup({
  states: { open: types<{ by: string }>(), locked: types<{ code: string }>() },
  events: { lock: types<{ code: string }>(), unlock: types<{}>() },
});
const extraKeys = { code: "1", by: "ann" };
export const spreadMachine = spreads.machine({
  start: ({ to }) => to("open", { by: "ann" }),
  states: {
    open: {
      on: {
        // @ts-expect-error 32. `by` arrives through the spread, and "locked" has no field by.
        lock: ({ data, to }) => to("locked", { ...data, code: "1" }),
      },
    },
    locked: {
      on: {
        // @ts-expect-error 32. So does a variable's extra key.
        unlock: ({ to }) => to("open", extraKeys),
      },
    },
  },
});

// 33–35. The rest of the graph: events nobody handles, internal events nobody produces, and an
// internal event handled where it never arrives.
const jobs2 = setup({
  states: { idle: types<{}>(), saving: types<{}>(), done: types<{}>() },
  events: { save: types<{}>(), kick: types<{}>() },
  internal: { stored: types<{}>(), lost: types<{}>() },
});
const strayMachine = jobs2.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ to }) => to("saving"), stored: ({ to }) => to("done") } },
    saving: {
      task: { run: ({ signal }) => posted(signal, "stored"), error: ({ to }) => to("idle") },
      on: { stored: ({ to }) => to("done"), save: ({ to }) => to("idle") },
    },
    done: { final: true },
  },
});
// @ts-expect-error 33–35. kick is never handled, lost never produced, and idle's stored never arrives.
createActor(strayMachine);
export const strayProblems: Equal<
  typeof strayMachine,
  MachineError<
    | `event "kick" is declared but no state handles it: handle it, or remove it from setup's events`
    | `internal event "lost" is never produced by a task: produce it, or remove it`
    | `state "idle" handles internal event "stored", which its own task doesn't produce: only the current state's task's events arrive`
  >
> = true;

const withInput = setup({
  input: types<{ url: string }>(),
  states: { idle: types<{ url: string }>() },
  events: { go: types<{}>() },
});
const needsInput = withInput.machine({
  start: ({ input, to }) => to("idle", { url: input.url }),
  states: { idle: { on: { go: ({ data, to }) => to("idle", data) } } },
});
// @ts-expect-error 28. An actor without the input `start` needs.
createActor(needsInput);
createActor(needsInput, { input: { url: "/" } });

// @ts-expect-error 65. A feature listed by its name, a string: use takes the imported value.
setup({ use: ["nested"], states: { idle: types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly ["nested"]; states: { idle: Type<{}> }; events: {} }>,
    `use lists "nested", a name: list the feature itself, import { nested } from "@reactre/state/nested", then use: [nested]`
  >
>();

// The catalog's rows (../compare/MISTAKES.md) that the cases above don't pin, by their M#.

// Targets and data in a transition.
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        // @ts-expect-error M7. A field of the wrong type.
        push: ({ event, to }) => to("open", { by: event.by.length }),
        // @ts-expect-error M9. An async transition: a Promise, which a guard would read as true.
        lock: async ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: {
      on: {
        // @ts-expect-error M348. Declining with undefined, XState v6's way: decline with null.
        unlock: ({ event, to }) => (event.code === "" ? undefined : to("closed")),
      },
    },
  },
});
const list = setup({
  states: { list: types<{ items: string[] }>(), picked: types<{ names: { name: string }[]; i: number }>() },
  events: { set: types<{ items: string[] }>(), pick: types<{}>() },
});
list.machine({
  start: ({ to }) => to("list", { items: [] }),
  states: {
    list: {
      on: {
        // @ts-expect-error M11. The sender's array sorted in place: a payload is readonly.
        set: ({ event, to }) => to("list", { items: event.items.sort() }),
        pick: ({ to }) => to("picked", { names: [], i: 0 }),
      },
    },
    picked: {
      on: {
        // @ts-expect-error M14. An index read as present (noUncheckedIndexedAccess): it may be undefined.
        pick: ({ data, to }) => to("picked", { names: [{ name: data.names[data.i].name }], i: 0 }),
        // @ts-expect-error M15. undefined for a required field: the key vanishes in JSON.
        set: ({ to }) => to("picked", { names: undefined, i: 0 }),
      },
    },
  },
});

// Contracts: data and payloads are JSON.
// @ts-expect-error M17. A Date in a payload.
setup({ states: { idle: types<{}>() }, events: { go: types<{ at: Date }>() } });
// @ts-expect-error M25. A cancellation handle in data.
setup({ states: { idle: types<{ controller: AbortController }>() }, events: {} });
// @ts-expect-error M26. A Promise in data.
setup({ states: { idle: types<{ pending: Promise<string> }>() }, events: {} });
// @ts-expect-error M27. A File in data, lost on persist.
setup({ states: { idle: types<{ file: File }>() }, events: {} });
class User {
  name = "";
  greet(): string {
    return this.name;
  }
}
// @ts-expect-error M28. A class instance with methods in data.
setup({ states: { idle: types<{ user: User }>() }, events: {} });
// @ts-expect-error M29. A bigint in data: JSON.stringify throws.
setup({ states: { idle: types<{ id: bigint }>() }, events: {} });
// @ts-expect-error M30. A Set in data: it serializes to {}.
setup({ states: { idle: types<{ seen: Set<string> }>() }, events: {} });
// @ts-expect-error M31. A Map in data: it serializes to {}.
setup({ states: { idle: types<{ byId: Map<string, string> }>() }, events: {} });
// @ts-expect-error M32. A DOM event in a payload.
setup({ states: { idle: types<{}>() }, events: { input: types<{ e: Event }>() } });
// @ts-expect-error M33. An actor in data: gone after a restore.
setup({ states: { idle: types<{ child: typeof actor }>() }, events: {} });
// @ts-expect-error M33. A DOM node in data: an object with methods, named by its field (pinned at the end).
setup({ states: { idle: types<{ el: HTMLElement }>() }, events: {} });
// @ts-expect-error M34. A field typed undefined: undefined isn't JSON.
setup({ states: { idle: types<{ note: string | undefined }>() }, events: {} });

// Events and sending.
// @ts-expect-error M45. A payload field of the wrong type.
actor.send({ type: "push", by: 1 });
// @ts-expect-error M46. A payload field the event doesn't have.
actor.send({ type: "push", by: "a", at: 1 });

// Tasks: run and error.
job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        // @ts-expect-error M68. run's catch logs and returns nothing: it resolves to undefined, not an event.
        run: async ({ data }) => {
          try {
            return { type: "stored", id: data.text };
          } catch (e) {
            console.error(e);
          }
        },
        // @ts-expect-error M69. error.message on an unknown error.
        error: ({ error, to }) => to("failed", { error: error.message }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        // @ts-expect-error M72. run reads the event that entered the state: it gets the state's data.
        run: async ({ event }) => ({ type: "stored", id: event.text }),
        // @ts-expect-error M70. The unknown error itself as data.
        error: ({ error, to }) => to("failed", { error }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
      // @ts-expect-error M96. A timer reads the event: timers have none.
      after: { "5s": ({ event, to }) => to("failed", { error: event.type }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        // @ts-expect-error M71. error declines: a failure must move, and an abort never reaches it.
        error: () => null,
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});

// Timers.
const months = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
      after: {
        // @ts-expect-error M89. A unit the core doesn't know, a month: its handler's `to` is implicitly any.
        "1mo": ({ to }) => to("failed", { error: "late" }),
        // @ts-expect-error M89. A day, the same.
        "1d": ({ to }) => to("failed", { error: "late" }),
      },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof months,
    MachineError<
      | 'state "saving" has a timer "1mo": write a number and a unit, "500ms", "5s", "2m" or "1h"'
      | 'state "saving" has a timer "1d": write a number and a unit, "500ms", "5s", "2m" or "1h"'
    >
  >
>();
// @ts-expect-error M89. Using the machine quotes both.
createActor(months);
const bare = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: { run: async ({ data }) => ({ type: "stored", id: data.text }), error: ({ to }) => to("idle") },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
      after: { 5000: ({ to }) => to("failed", { error: "late" }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
type BareProblem = 'state "saving" has a timer 5000, a bare number: write it with its unit, "5000ms"';
expect<Equal<typeof bare, MachineError<BareProblem>>>();
// @ts-expect-error M90. A bare number: the machine's problem names its unit.
createActor(bare);

// Use sites, with the helpers' imports beside them.
import { useActor, useActorRef } from "../src/entries/react.ts";
import { can } from "../src/utils/index.ts";

// @ts-expect-error M259. A snapshot through createActor (XState v6's E8): restoreActor restores one.
createActor(good, { snapshot });
// @ts-expect-error M301. can given an event's name: it takes the event.
can(good, snapshot, "close");
// @ts-expect-error M302. useActor given an actor: it takes the machine.
useActor(actor);

// Migration habits: XState's v4, v5 and v6 syntax.
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        // @ts-expect-error M346. A v5 transition array.
        push: [{ target: "open" }, { target: "locked" }],
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
const habits = door.machine({
  predictableActionArguments: true,
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      activities: ["beep"],
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
        // @ts-expect-error M347. v4's null event: its handler's `to` is implicitly any, here.
        "": ({ to }) => to("closed"),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof habits,
    MachineError<
      | '"predictableActionArguments" is not a machine option'
      | `state "closed" has "activities", which states don't take`
      | `state "closed" handles "", which is not an event in the shape: check the name, or add it to setup's events`
    >
  >
>();
// @ts-expect-error M347, M355, M356. v4's null event, activities and flag: using the machine quotes them.
createActor(habits);
// @ts-expect-error M357. v5's typing: types are given by types<T>() in states and events.
setup({ types: {} as { context: { n: number } }, states: { idle: types<{}>() }, events: {} });
door.machine(
  {
    start: ({ to }) => to("closed"),
    states: {
      closed: {
        on: {
          push: ({ event, to }) => to("open", { by: event.by }),
          lock: ({ event, to }) => to("locked", { code: event.code }),
        },
      },
      open: { on: { close: ({ to }) => to("closed") } },
      locked: { on: { unlock: ({ to }) => to("closed") } },
    },
  },
  // @ts-expect-error M358. v5's implementations argument.
  { actions: {} },
);

// XState's names. The core declares each for the type checker only, as a function whose parameter
// is the fix, so a call says what to write instead. The entries' names are TypeScript's own errors.
import {
  and,
  assign,
  createMachine,
  enqueueActions,
  escalate,
  interpret,
  invoke,
  not,
  or,
  raise,
  restoreActor,
  sendTo,
  stateIn,
} from "@reactre/state";
// @ts-expect-error M367. A hallucinated entry.
import { hierarchy } from "@reactre/state/hierarchy";
// @ts-expect-error M366. v5's name for async logic.
import { fromPromise } from "@reactre/state/logic";
// @ts-expect-error M365. XState's hooks.
import { useInterpret, useMachine } from "@reactre/state/react";
void [useInterpret, useMachine, fromPromise, hierarchy];
// @ts-expect-error M362. v5's guard combinators: a guard is a condition in the handler.
and(["isAdmin", "isActive"]);
// @ts-expect-error M362. or.
or(["isAdmin", "isOwner"]);
// @ts-expect-error M362. not.
not("isBanned");
// @ts-expect-error M362. stateIn.
stateIn({ form: "valid" });
expect<
  Equal<
    Parameters<typeof and>[0],
    "and is XState's: a guard here is a condition in the handler, (a && b ? to(...) : null)"
  >
>();
// @ts-expect-error M363. Action creators: assign is the next state's data.
assign({ count: 1 });
// @ts-expect-error M363. raise.
raise({ type: "tick" });
// @ts-expect-error M363. sendTo.
sendTo("child", { type: "ping" });
// @ts-expect-error M363. enqueueActions.
enqueueActions(() => {});
// @ts-expect-error M363. escalate.
escalate({ message: "failed" });
// @ts-expect-error M364. v5's entry point: setup, then .machine.
createMachine({ id: "door", initial: "closed" });
// @ts-expect-error M364. v4's interpreter.
interpret(good);
// @ts-expect-error M367. A hallucinated export from the core: XState's invoke.
invoke({ src: "fetchUser" });
// @ts-expect-error M368. v4's string event.
actor.send("push");
// @ts-expect-error M369. v5's start: an actor starts when it is created.
actor.start();
// @ts-expect-error M370. Removed in v5.
actor.onTransition(() => {});
// @ts-expect-error M370. So is batch.
actor.batch(() => {});
// @ts-expect-error M371. v4's state members.
snapshot.done;
// @ts-expect-error M371. nextEvents.
snapshot.nextEvents;
// @ts-expect-error M372. XState's snapshot shape: context.
snapshot.context;
// @ts-expect-error M372. value.
snapshot.value;
// @ts-expect-error M373. XState's snapshot methods: matches.
snapshot.matches("open");
// @ts-expect-error M373. can.
snapshot.can({ type: "close" });
// @ts-expect-error M374. v4's machine method.
good.withConfig({});
// @ts-expect-error M374. v5's.
good.provide({});
// @ts-expect-error M375. v4's context option: the option's type is the fix.
createActor(good, { context: { by: "a" } });

// The type layer's rules (V4 §3).

// A move to the same state, in a state with a task or timer: the move doesn't exit the state, so
// its work keeps the data it started with. The model must choose: reenter, or keep.
const search = setup({
  states: { idle: types<{}>(), loading: types<{ q: string }>(), shown: types<{ q: string; hits: string[] }>() },
  events: { type: types<{ q: string }>() },
  internal: { found: types<{ hits: string[] }>() },
});
const typeahead = search.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
    loading: {
      task: { run: async ({ data }) => ({ type: "found", hits: [data.q] }), error: ({ to }) => to("idle") },
      on: {
        // The old query's task keeps running, and its result lands on the new query.
        type: ({ event, to }) => to("loading", { q: event.q }),
        found: ({ data, event, to }) => to("shown", { q: data.q, hits: event.hits }),
      },
    },
    shown: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
  },
});
expect<
  Equal<
    typeof typeahead,
    MachineError<`state "loading" goes to itself with to(...), and its task keeps running with the data it started with: write reenter("loading", ...) to restart it with the new data (add reenter to setup's use (import { reenter } from "@reactre/state/reenter")), or keep("loading", data), with the data it started with, to leave it running`>
  >
>();
// @ts-expect-error M87. A typeahead as a stay: the old query's result lands on the new one.
createActor(typeahead);
// keep with a new query types, but leaves the task on the old one: the build refuses it (M477).
export const kept = search.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
    loading: {
      task: { run: async ({ data }) => ({ type: "found", hits: [data.q] }), error: ({ to }) => to("idle") },
      on: {
        type: ({ event, keep }) => keep("loading", { q: event.q }),
        found: ({ data, event, to }) => to("shown", { q: data.q, hits: event.hits }),
      },
    },
    shown: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
  },
});
createActor(kept);
search.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
    loading: {
      task: { run: async ({ data }) => ({ type: "found", hits: [data.q] }), error: ({ to }) => to("idle") },
      on: {
        // @ts-expect-error keep to another state: keep stays in the state the handler runs in.
        type: ({ keep }) => keep("idle"),
        found: ({ data, event, to }) => to("shown", { q: data.q, hits: event.hits }),
      },
    },
    shown: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
  },
});

const editor = setup({
  states: { idle: types<{}>(), typing: types<{ text: string }>(), polling: types<{ text: string }>() },
  events: { input: types<{ text: string }>(), stop: types<{}>() },
});
const debounce = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { input: ({ event, to }) => to("typing", { text: event.text }) } },
    typing: {
      // Each key stays in typing: the timer isn't restarted, and fires 300ms after the first key.
      on: { input: ({ event, to }) => to("typing", { text: event.text }) },
      after: { "300ms": ({ data, to }) => to("polling", data) },
    },
    polling: { on: { stop: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof debounce,
    MachineError<`state "typing" goes to itself with to(...), and its timers keep running with the data they started with: write reenter("typing", ...) to restart them with the new data (add reenter to setup's use (import { reenter } from "@reactre/state/reenter")), or keep("typing", data), with the data they started with, to leave them running`>
  >
>();
// @ts-expect-error M103. A debounce as a stay: it fires after the first key, not the last.
createActor(debounce);
const poll = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { input: ({ event, to }) => to("typing", { text: event.text }) } },
    typing: { on: { stop: ({ to }) => to("idle") }, after: { "1s": ({ data, to }) => to("polling", data) } },
    // The timer fired; a stay doesn't arm it again, so it polls once.
    polling: { on: { stop: ({ to }) => to("idle") }, after: { "5s": ({ data, to }) => to("polling", data) } },
  },
});
expect<
  Equal<
    typeof poll,
    MachineError<`state "polling" goes to itself with to(...), and its timers keep running with the data they started with: write reenter("polling", ...) to restart them with the new data (add reenter to setup's use (import { reenter } from "@reactre/state/reenter")), or keep("polling", data), with the data they started with, to leave them running`>
  >
>();
// @ts-expect-error M104. Polling as a stay: it polls once, then stops.
createActor(poll);

const fetcher = setup({
  states: {
    idle: types<{}>(),
    loading: types<{ url: string; body: string }>(),
    failed: types<{ url: string }>(),
  },
  events: { fetch: types<{ url: string }>(), done: types<{}>() },
  internal: { received: types<{ body: string }>() },
});
const armed = fetcher.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { fetch: ({ event, to }) => to("loading", { url: event.url, body: "" }) } },
    loading: {
      task: {
        run: async ({ data, signal }) => ({ type: "received", body: await request(signal, data.url) }),
        error: ({ data, to }) => to("failed", { url: data.url }),
      },
      after: { "10s": ({ data, to }) => to("failed", { url: data.url }) },
      // The body arrived, and the state stays: the timeout is still armed, and fails it 10s later.
      on: {
        received: ({ data, event, to }) => to("loading", { ...data, body: event.body }),
        done: ({ to }) => to("idle"),
      },
    },
    failed: { on: { fetch: ({ event, to }) => to("loading", { url: event.url, body: "" }) } },
  },
});
expect<
  Equal<
    typeof armed,
    MachineError<`state "loading" goes to itself with to(...), and its task and timers keep running with the data they started with: write reenter("loading", ...) to restart them with the new data (add reenter to setup's use (import { reenter } from "@reactre/state/reenter")), or keep("loading", data), with the data they started with, to leave them running`>
  >
>();
// @ts-expect-error M105. Success as a stay: the timeout stays armed.
createActor(armed);

// A use site can't hide a broken machine: an `any` machine or snapshot turns every check off.
// @ts-expect-error M304. A machine cast to any: createActor's `this` is the fix.
createActor(good as any);
// @ts-expect-error M304. initial, the same.
initial(good as any, undefined);
// @ts-expect-error M304. transition, the same.
transition(good as any, snapshot, { type: "close" });
// @ts-expect-error M304. useActor (@reactre/state/react), the same.
useActor(good as any);
// @ts-expect-error M304. useActorRef (@reactre/state/react), the same.
useActorRef(good as any);
import { useActor as useSignalActor } from "../src/signals.ts";
// @ts-expect-error M304. useActor (@reactre/state/signals), the same.
useSignalActor(good as any);
const stored = JSON.stringify(snapshot);
// @ts-expect-error M261. A snapshot from JSON.parse: restoreActor refuses it, naming migrations.
restoreActor(good, JSON.parse(stored));
// @ts-expect-error M261. transition, the same.
transition(good, JSON.parse(stored), { type: "close" });

// A task's result is a boundary: res.json() is any, and the event would carry it unchecked.
const users = setup({
  states: { idle: types<{}>(), loading: types<{ id: string }>(), shown: types<{ name: string }>() },
  events: { load: types<{ id: string }>() },
  internal: { received: types<{ user: { name: string } }>() },
});
const unparsed = users.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { load: ({ event, to }) => to("loading", { id: event.id }) } },
    loading: {
      task: {
        run: async ({ data, signal }) => ({ type: "received", user: await (await fetch(data.id, { signal })).json() }),
        error: ({ to }) => to("idle"),
      },
      on: { received: ({ event, to }) => to("shown", { name: event.user.name }), load: ({ to }) => to("idle") },
    },
    shown: { final: true },
  },
});
expect<
  Equal<
    typeof unparsed,
    MachineError<`state "loading"'s task resolves to "received" with user typed any: check what you parse (res.json() and JSON.parse return any), and build the event from the checked value`>
  >
>();
// @ts-expect-error M78. An event carrying res.json()'s any.
createActor(unparsed);

// M33's DOM node, by its field (TypeScript's own message was "excessively deep", TS2589).
expect<
  Equal<
    keyof ShapeCheck<{ states: { idle: Type<{ el: HTMLElement }> }; events: {} }>,
    `not JSON: state "idle".el (an object with methods: a class instance, a DOM node, an actor or a Promise, which JSON can't hold. Store plain data: an id, or the fields you need)`
  >
>();

// 40 onward: each feature's mistakes are in ./features/<feature>/mistakes.ts, with its `use`:
// nested 40–43, 45–46 and 58; history 44 and 60; parallel 47–52 and 59; children 53–55 and 61;
// validate 56–57 and 62; persist 63; durable 64.

// Contracts, a field always there: no optional field, and null (not undefined) for no value.
// @ts-expect-error M307. A field made optional to quiet an error: the contract loosened.
setup({ states: { idle: types<{}>(), loaded: types<{ body?: string }>() }, events: {} });
// @ts-expect-error M307. In a payload, or deeper in data, the same.
setup({ states: { idle: types<{ at: { x?: number }[] }>() }, events: { go: types<{ note?: string }>() } });
expect<
  Equal<
    keyof ShapeCheck<{
      states: { loaded: Type<{ body?: string }> };
      events: { go: Type<{ note: string | undefined }> };
    }>,
    | `not JSON: state "loaded".body (optional: a handler may leave it out. Make it required, with null for no value: body: T | null)`
    | `not JSON: event "go".note (undefined: write null for no value, T | null, and give null)`
  >
>();

// A flag that repeats the state: the state is the flag.
// @ts-expect-error M41. In "loading", isLoading is always true.
setup({ states: { idle: types<{}>(), loading: types<{ url: string; isLoading: true }>() }, events: {} });
// @ts-expect-error M41. A boolean named for the state, as the state, or with has.
setup({ states: { open: types<{ open: boolean }>(), failed: types<{ hasFailed: boolean }>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{ states: { idle: Type<{}>; loading: Type<{ url: string; isLoading: true }> }; events: {} }>,
    `state "loading" has "isLoading", a flag that repeats the state it is in: the state is the flag. Remove the field, and read snapshot.state === "loading"`
  >
>();
// M41: a boolean named for another state isn't one: a choice's routing state picks "vip" by its vip.
setup({ states: { routing: types<{ vip: boolean }>(), vip: types<{}>(), standard: types<{}>() }, events: {} });

// The second round's rows (../compare/MISTAKES.md, M404 on), by their M#.
import { toPromise } from "../src/utils/index.ts";

// Contracts.
// @ts-expect-error M416. A void payload: types<T> takes an object type, types<{}>() for none.
setup({ states: { idle: types<{}>() }, events: { close: types<void>() } });
// @ts-expect-error M428. types<T> without its call: the contract names the call.
setup({ states: { idle: types<{ by: string }> }, events: {} });
const OPENED: unique symbol = Symbol("opened");
// @ts-expect-error M417. A symbol key, which JSON drops.
setup({ states: { open: types<{ by: string; [OPENED]: boolean }>() }, events: {} });
// @ts-expect-error M423. never[], an empty literal's type.
setup({ states: { idle: types<{ tags: never[] }>() }, events: {} });
// @ts-expect-error M425. A prototype name as a field.
setup({ states: { idle: types<{ constructor: string }>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{
      states: { open: Type<{ by: string; [OPENED]: boolean }>; idle: Type<{ tags: never[]; constructor: string }> };
      events: {};
    }>,
    | `not JSON: state "open" (a symbol key, which JSON drops: use a string field)`
    | `not JSON: state "idle".tags (never[], an empty array's type: write its element type, as string[])`
    | `not JSON: state "idle".constructor (a prototype name, which a parsed object can't own as a field: rename it)`
  >
>();
// @ts-expect-error M418. An event named after an Object.prototype member.
setup({ states: { idle: types<{}>() }, events: { toString: types<{}>() } });
// @ts-expect-error M420. Two names that differ only by case.
setup({ states: { idle: types<{}>() }, events: { close: types<{}>(), Close: types<{}>() } });
// @ts-expect-error M421. One name for a sent event and an internal one.
setup({ states: { idle: types<{}>() }, events: { stored: types<{}>() }, internal: { stored: types<{}>() } });
// @ts-expect-error M422. A * in an event's name.
setup({ states: { idle: types<{}>() }, events: { "close*": types<{}>() } });
// M419, by its type alone (the compiler reads a setup call's numeric key too).
expect<
  Equal<
    keyof ShapeCheck<{ states: { idle: Type<{}>; 2: Type<{}> }; events: {} }>,
    `state 2 is named by a number, whose key reorders and never equals it: name it with a word ("step2")`
  >
>();

// Start.
const declines = door.machine({
  start: () => null,
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof declines,
    MachineError<"start can't decline with null: it returns the state the machine starts in, to(state, data), deciding from input">
  >
>();
// @ts-expect-error M408. start declining: it returns the state the machine starts in.
createActor(declines);
door.machine({
  // @ts-expect-error M409. start reads no event: its argument is input and to.
  start: ({ event, to }) => (event === undefined ? to("closed") : to("closed")),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
const doneAtOnce = job.machine({
  start: ({ to }) => to("saved", { id: "" }),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }), retry: ({ to }) => to("idle") },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof doneAtOnce,
    MachineError<
      | `start goes to "saved", a final state: the actor would be done before it starts; start in a state that does the work`
      | 'state "idle" is unreachable: no transition goes to it. Add one, or remove the state'
      | 'state "saving" is unreachable: no transition goes to it. Add one, or remove the state'
      | 'state "failed" is unreachable: no transition goes to it. Add one, or remove the state'
    >
  >
>();
// @ts-expect-error M435. start in a final state.
createActor(doneAtOnce);

// Handlers.
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        // @ts-expect-error M412. The same event twice in one state's on: the second wins.
        push: ({ event, to }) => to("open", { by: event.by.trim() }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        // @ts-expect-error M414. JSON.parse's any in the new state's data.
        push: ({ event, to }) => to("open", { by: JSON.parse(`"${event.by}"`) }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
const validCode = (code: string): boolean => code.length === 1;
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        // @ts-expect-error M485. A guard function as a condition, uncalled (TS2774 says call it).
        lock: ({ event, to }) => (validCode ? to("locked", { code: event.code }) : null),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
const beside = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      // @ts-expect-error M434. A handler beside on: its `to` is implicitly any, here.
      close: ({ to }) => to("closed"),
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof beside,
    MachineError<`state "closed" has "close", which states don't take: handle the event in on, on: { close: ... }`>
  >
>();
// @ts-expect-error M434. Using the machine quotes it.
createActor(beside);

// Tasks.
job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        // @ts-expect-error M411. error returning an event: it returns a step.
        error: ({ error }) => ({ type: "failed", error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }), retry: ({ to }) => to("idle") },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        // @ts-expect-error M437. run returning a step: it returns an event, and on moves.
        run: async ({ data, to }) => to("saved", { id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }), retry: ({ to }) => to("idle") },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
        // @ts-expect-error M615. v5's onDone: run's result is an internal event, handled in on.
        onDone: ({ to }: { to: (state: "saved") => never }) => to("saved"),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }), retry: ({ to }) => to("idle") },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
// M614, by the state's config type (the compiler reads a bare task in a machine too).
type JobStates = Parameters<typeof job.machine>[0]["states"];
export const bareTask: JobStates["saving"] = {
  // @ts-expect-error M614. A bare function as the task (v5's fromPromise): a task is an object.
  task: async ({ data }: { data: { text: string } }) => ({ type: "stored", id: data.text }),
};
const hangs = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof hangs,
    MachineError<`state "saving" runs a task and no public event or timer leaves it: add a cancel event, an after, or a timeout`>
  >
>();
// @ts-expect-error M432. A task state with no way out.
createActor(hangs);
const publicResult = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      // The server may ask for a retry: the task resolves to stored, or to retry, a public event.
      task: {
        run: ({ data, signal }) => saved(data.text, signal),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { retry: ({ to }) => to("idle"), stored: ({ event, to }) => to("saved", { id: event.id }) },
    },
    saved: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof publicResult,
    MachineError<`the task in "saving" resolves to "retry", a public event: declare it in internal`>
  >
>();
// @ts-expect-error M436. A task resolving to a public event.
createActor(publicResult);

// Timers: digits and a unit, nonzero, within setTimeout's limit.
const badTimers = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: {
      after: {
        "-5s": ({ to }) => to("closed"),
        "0ms": ({ to }) => to("locked", { code: "" }),
        "720h": ({ to }) => to("closed"),
      },
      on: { close: ({ to }) => to("closed") },
    },
    locked: { on: { unlock: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof badTimers,
    MachineError<
      | `state "open"'s timer is "-5s", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
      | `state "open"'s timer is "0ms", a timer that fires at once: decide in the handler, or use always`
      | `state "open"'s timer is "720h", past setTimeout's limit (2147483647ms, 24.8 days), so it would fire at once: wait on a durable host, or re-check sooner`
    >
  >
>();
// @ts-expect-error M479, M480, M482. A sign, a zero, and a timer past setTimeout's limit.
createActor(badTimers);
const finalTimer = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: {
        run: async ({ data }) => ({ type: "stored", id: data.text }),
        error: ({ error, to }) => to("failed", { error: String(error) }),
      },
      on: { stored: ({ event, to }) => to("saved", { id: event.id }), retry: ({ to }) => to("idle") },
    },
    // @ts-expect-error M433. A final state with a timer: its handler's `to` is implicitly any, here.
    saved: { final: true, after: { "1s": ({ to }) => to("idle") } },
    failed: { on: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof finalTimer,
    MachineError<`state "saved" is final and has "after": a final state takes no events, tasks or timers. Remove it, or drop final`>
  >
>();
// @ts-expect-error M433. Using the machine quotes it.
createActor(finalTimer);

// Use sites.
// @ts-expect-error M429. An event typed any (JSON.parse): parse it, or narrow it.
actor.send(JSON.parse('{ "type": "push", "by": "ann" }'));
// @ts-expect-error M575. An any type argument: leave it out, the machine gives it.
createActor<any>(good);
// @ts-expect-error M575. initial, the same.
initial<any>(good, undefined);
// @ts-expect-error M575. transition, the same.
transition<any>(good, snapshot, { type: "close" });
// @ts-expect-error M581. A spread of a machine isn't one.
createActor({ ...good });
// @ts-expect-error M582. Input to a machine that takes none.
createActor(good, { input: { by: "ann" } });
// @ts-expect-error M590. Options typed any (JSON.parse): parse them, or narrow them.
createActor(good, JSON.parse("{}"));
// @ts-expect-error M613. XState's id: the variable names the actor.
createActor(good, { id: "door" });
// @ts-expect-error M613. XState's devTools: watch it with inspect.
createActor(good, { devTools: true });
// @ts-expect-error M557. A durable run's snapshot: resume it with durable(machine, host).
restoreActor(good, { state: "closed", data: {}, entries: [] });
export function rename(by: string): void {
  const s = actor.snapshot();
  // @ts-expect-error M583. A snapshot's data written from outside (TS2540: it is readonly; send an event).
  if (s.state === "open") s.data.by = by;
}
// @ts-expect-error M584. An async listener: its writes overlap.
actor.subscribe(async () => {
  await Promise.resolve();
});
// @ts-expect-error M588. toPromise of a machine with no final state never settles.
export const ended = toPromise(actor);
// @ts-expect-error M612. XState's getSnapshot (TS2551 names snapshot).
actor.getSnapshot();
// @ts-expect-error M575. useActor (@reactre/state/react), the same as createActor<any>.
useActor<any>(good);
// @ts-expect-error M575. useActorRef, the same.
useActorRef<any>(good);
// @ts-expect-error M575. useActor (@reactre/state/signals), the same.
useSignalActor<any>(good);
// @ts-expect-error M581. A hook refuses a spread machine too.
useActor({ ...good });

// What the tasks above call (M461: a task does its work, so none is a stub).
import { posted, request } from "./fixtures/service.ts";

/** A save the server may ask to retry: publicResult's task resolves to either event. */
async function saved(text: string, signal: AbortSignal): Promise<{ type: "stored"; id: string } | { type: "retry" }> {
  const id = await request(signal, `/api/save/${encodeURIComponent(text)}`);
  return id === "" ? { type: "retry" } : { type: "stored", id };
}
