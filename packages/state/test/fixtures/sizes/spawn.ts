// What spawn costs an app that uses it: a pool that spawns a worker per job by key, and hears each
// one's end.

import { createActor, setup, types } from "@reactre/state";
import { child, children } from "@reactre/state/children";
import { effects } from "@reactre/state/effects";
import { spawn } from "@reactre/state/spawn";

const worker = setup({
  input: types<{ id: string }>(),
  states: { working: types<{ id: string }>(), finished: types<{ id: string }>() },
  events: { finish: types<{}>() },
});
export const workerMachine = worker.machine({
  start: ({ input, to }) => to("working", { id: input.id }),
  states: { working: { on: { finish: ({ data, to }) => to("finished", { id: data.id }) } }, finished: { final: true } },
});

const pool = setup({
  use: [children, effects, spawn],
  states: { open: types<{ done: number }>() },
  events: { add: types<{ id: string }>() },
  internal: { finished: types<{ output: { state: "finished"; data: { id: string } } }>() },
  children: { worker: workerMachine },
});
export const poolMachine = pool.machine({
  start: ({ to }) => to("open", { done: 0 }),
  states: {
    open: {
      on: {
        add: ({ data, event, enq, to }) => {
          enq.spawn("worker", { key: event.id, input: { id: event.id } });
          enq.subscribeTo("worker", { key: event.id, done: "finished" });
          return to("open", { done: data.done });
        },
        finished: ({ data, to }) => to("open", { done: data.done + 1 }),
      },
    },
  },
});

export function run(): number {
  const actor = createActor(poolMachine);
  actor.send({ type: "add", id: "a" });
  child(actor, "worker", "a")?.send({ type: "finish" });
  return actor.snapshot().data.done;
}
