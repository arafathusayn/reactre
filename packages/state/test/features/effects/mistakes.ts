// effects's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in cases first.

import { createActor, type MachineError, setup, transition, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const plain = setup({
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
});

// The opt-in: `entry` without effects in use names the import.
const entered = plain.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { entry: () => {}, on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});
expect<
  Equal<
    typeof entered,
    MachineError<`state "closed" has "entry": add effects to setup's use (import { effects } from "@reactre/state/effects")`>
  >
>();
// @ts-expect-error The opt-in: `entry` (or `exit`) without effects in use, a problem naming the import.
createActor(entered);

const ends = setup({
  states: { open: types<{}>(), closed: types<{}>() },
  events: { close: types<{}>() },
});
const endedOff = ends.machine({
  start: ({ to }) => to("open"),
  states: { open: { on: { close: ({ to }) => to("closed") } }, closed: { final: true, entry: () => {} } },
});
expect<
  Equal<
    typeof endedOff,
    MachineError<`state "closed" has "entry": add effects to setup's use (import { effects } from "@reactre/state/effects")`>
  >
>();
// @ts-expect-error The opt-in: a final state's `entry` without effects in use names the import too.
createActor(endedOff);

const endsOn = setup({
  use: [effects],
  states: { open: types<{}>(), closed: types<{ by: string }>() },
  events: { close: types<{}>() },
});
// A final state's entry, with effects: it runs when the machine ends in it.
export const endedOk = endsOn.machine({
  start: ({ to }) => to("open"),
  states: {
    open: { on: { close: ({ to }) => to("closed", { by: "ann" }) } },
    closed: { final: true, entry: ({ data, enq }) => enq.log(data.by) },
  },
});
createActor(endedOk);
const exited = endsOn.machine({
  start: ({ to }) => to("open"),
  states: {
    open: { on: { close: ({ to }) => to("closed", { by: "ann" }) } },
    closed: { final: true, exit: () => {} },
  },
});
expect<
  Equal<
    typeof exited,
    MachineError<`state "closed" is final and has "exit": a final state takes no events, tasks or timers. Remove it, or drop final`>
  >
>();
// @ts-expect-error A final state has no exit: it never exits.
createActor(exited);

plain.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, enq, to }) => {
          // @ts-expect-error The opt-in: `enq` without effects in use is a function whose parameter is the fix.
          enq(() => console.log(event.by));
          return to("open", { by: event.by });
        },
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

const door = setup({
  use: [effects],
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
  internal: { tick: types<{ n: number }>() },
});

// The correct machine: every form of enq, entry and exit.
export const doorOk = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      entry: ({ enq }) => enq.log("closed"),
      on: {
        push: ({ event, enq, to }) => {
          enq((by: string) => console.log(by), event.by);
          enq.raise({ type: "tick", n: 1 }, { delay: 100, id: "tick" });
          enq.sendTo({ send: (e: { readonly type: "ping" }) => e }, { type: "ping" });
          enq.effect(() => () => {});
          return to("open", { by: event.by });
        },
      },
    },
    open: {
      exit: ({ data, enq }) => enq.log(data.by),
      on: {
        close: ({ enq, to }) => {
          enq.cancel("tick");
          return to("closed");
        },
        tick: ({ data, keep }) => keep("open", data),
      },
    },
  },
});
createActor(doorOk);
const moved = transition(doorOk, { state: "closed", data: {}, version: 0 }, { type: "push", by: "ann" });
// The result carries the effects, unrun.
if (moved.ok) moved.fx.map((e) => e.type);

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, enq, to }) => {
          // @ts-expect-error A raised event that isn't one of the machine's.
          enq.raise({ type: "pull" });
          // @ts-expect-error A raised event without its payload.
          enq.raise({ type: "tick" });
          // @ts-expect-error An effect's arguments that its function doesn't take.
          enq((by: string) => console.log(by), 1);
          // @ts-expect-error sendTo a child by name, without children: only an actor.
          enq.sendTo("upload", { type: "go" });
          // @ts-expect-error sendTo an actor, with an event it doesn't take.
          enq.sendTo({ send: (e: { readonly type: "ping" }) => e }, { type: "pong" });
          // @ts-expect-error A delay in words: milliseconds.
          enq.raise({ type: "tick", n: 1 }, { delay: "1s" });
          return to("open", { by: event.by });
        },
      },
    },
    open: {
      // @ts-expect-error entry decides nothing: it has no `to` (the handler that goes here decides).
      entry: ({ to }) => to("closed"),
      on: { close: ({ to }) => to("closed"), tick: ({ data, to }) => to("open", data) },
    },
  },
});

// The catalog's rows (../../../compare/MISTAKES.md), by their M#.
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      // @ts-expect-error M359. XState v6's named action, a string: entry is a function.
      entry: "track",
      on: {
        push: ({ event, enq, to }) => {
          // @ts-expect-error M145. v4's raise("tick"), a string: raise takes the event.
          enq.raise("tick");
          return to("open", { by: event.by });
        },
      },
    },
    open: {
      // @ts-expect-error M142. entry gets no event: it runs on every way into the state.
      entry: ({ event, enq }) => enq.log(event.type),
      on: { close: ({ to }) => to("closed"), tick: ({ data, to }) => to("open", data) },
    },
  },
});
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      // @ts-expect-error M360. v4's and v5's array of actions: one function, calling enq for each effect.
      entry: [() => {}, () => {}],
      on: { push: ({ event, to }) => to("open", { by: event.by }) },
    },
    open: {
      // @ts-expect-error M361. v5's assign: entry writes no data; to(state, data) gives it.
      entry: ({ assign }) => assign({ n: 1 }),
      on: { close: ({ to }) => to("closed"), tick: ({ data, to }) => to("open", data) },
    },
  },
});

// An effect's value is ignored: a function that returns data or a Promise is the mistake.
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, enq, to }) => {
          // @ts-expect-error M154. An effect returning data, v5's assign habit: the next state's data is to's.
          enq(() => ({ context: { by: event.by } }));
          // @ts-expect-error M156. An async effect: its Promise is awaited by nobody, and a rejection is lost.
          enq(async () => {
            await fetch("/audit");
          });
          // What a call returns by the way is fine: a Map's set, an array's push.
          enq(() => new Map<string, string>().set("by", event.by));
          enq(() => [event.by].push("ann"));
          return to("open", { by: event.by });
        },
      },
    },
    open: {
      // @ts-expect-error M155. exit returning data it can't write.
      exit: ({ data }) => ({ ...data, by: "" }),
      on: { close: ({ to }) => to("closed"), tick: ({ data, to }) => to("open", data) },
    },
  },
});

// The second round's rows, by their M#.
// M501: a stay with to(...) in a state with entry and exit runs neither again.
const selfMove = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: {
      entry: ({ enq }) => enq.log("opened"),
      exit: ({ enq }) => enq.log("closed"),
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        close: ({ to }) => to("closed"),
        tick: ({ data, keep }) => keep("open", data),
      },
    },
  },
});
expect<
  Equal<
    typeof selfMove,
    MachineError<`state "open" has entry and exit, and its own handler goes to it with to(...), which doesn't run them again: keep("open", ...) to stay without them, reenter("open", ...) to run them again`>
  >
>();
// @ts-expect-error M501. Using the machine quotes it.
createActor(selfMove);
door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, enq, to }) => {
          // @ts-expect-error M507. A plain arrow returning a promise: its rejection is lost, as an async one's.
          enq(() => fetch("/audit"));
          // @ts-expect-error M482. A delay of 0 fires at once: decide in the handler.
          enq.raise({ type: "tick", n: 1 }, { delay: 0 });
          // @ts-expect-error M480. A delay past setTimeout's limit fires at once.
          enq.raise({ type: "tick", n: 1 }, { delay: 2147483648 });
          return to("open", { by: event.by });
        },
      },
    },
    open: { on: { close: ({ to }) => to("closed"), tick: ({ data, keep }) => keep("open", data) } },
  },
});
const kept = setup({
  use: [effects, persist],
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
});
kept.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, enq, to }) => {
          // @ts-expect-error M519. A delayed sendTo to an actor by reference doesn't survive persist.
          enq.sendTo({ send: (e: { readonly type: "ping" }) => e }, { type: "ping" }, { delay: 100 });
          return to("open", { by: event.by });
        },
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});
import { persist } from "@reactre/state/persist";
