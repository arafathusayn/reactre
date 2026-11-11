// What effects cost an app that uses them: a door with entry and exit, a function effect, a raise
// now and one later (cancelled), a send to another actor, a log, and an effect with a cleanup.

import { createActor, setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";

const seen: string[] = [];
const outside = { send: (event: { readonly type: "ping"; readonly from: string }) => seen.push(event.from) };

const door = setup({
  use: [effects],
  states: { closed: types<{}>(), open: types<{ by: string }>(), alarmed: types<{ n: number }>() },
  events: {
    push: types<{ by: string }>(),
    close: types<{}>(),
    arm: types<{}>(),
    wait: types<{}>(),
    disarm: types<{}>(),
  },
  internal: { ring: types<{ n: number }>() },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      entry: ({ enq }) => enq(() => seen.push("closed")),
      exit: ({ enq }) => enq.log("leaving closed"),
      on: {
        push: ({ event, enq, to }) => {
          enq.sendTo(outside, { type: "ping", from: event.by });
          return to("open", { by: event.by });
        },
        // The stays are `keep`: closed's entry and exit don't run again (M501).
        arm: ({ enq, keep }) => {
          enq.raise({ type: "ring", n: 1 });
          return keep("closed");
        },
        // It stays, so a second wait replaces the first (M513).
        wait: ({ enq, keep }) => {
          enq.cancel("later");
          enq.raise({ type: "ring", n: 2 }, { delay: 1000, id: "later" });
          return keep("closed");
        },
        disarm: ({ enq, keep }) => {
          enq.cancel("later");
          return keep("closed");
        },
        ring: ({ event, to }) => to("alarmed", { n: event.n }),
      },
    },
    open: {
      entry: ({ data, enq }) =>
        enq.effect(() => {
          seen.push(data.by);
          return () => seen.push("cleanup");
        }),
      on: { close: ({ to }) => to("closed") },
    },
    alarmed: { on: { close: ({ to }) => to("closed") } },
  },
});

export function run(): string[] {
  const actor = createActor(doorMachine);
  actor.send({ type: "push", by: "ann" });
  actor.send({ type: "close" });
  actor.send({ type: "wait" });
  actor.send({ type: "disarm" });
  actor.send({ type: "arm" });
  actor.stop();
  return seen;
}
