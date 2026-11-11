// A pool of spawned workers, compiled as a build compiles them (../../compiled.ts registers the
// plugin): `add` spawns a worker by key and subscribes to its end and its progress; `cancel` stops it.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { effects } from "@reactre/state/effects";
import { emit } from "@reactre/state/emit";
import { persist } from "@reactre/state/persist";
import { spawn } from "@reactre/state/spawn";

const worker = setup({
  use: [effects, emit],
  input: types<{ id: string }>(),
  states: { working: types<{ id: string; pct: number }>(), finished: types<{ id: string }>() },
  events: { step: types<{ pct: number }>(), finish: types<{}>() },
  emitted: { progress: types<{ pct: number }>() },
});
export const workerMachine = worker.machine({
  start: ({ input, to }) => to("working", { id: input.id, pct: 0 }),
  states: {
    working: {
      on: {
        step: ({ data, event, enq, to }) => {
          enq.emit({ type: "progress", pct: event.pct });
          return to("working", { id: data.id, pct: event.pct });
        },
        finish: ({ data, to }) => to("finished", { id: data.id }),
      },
    },
    finished: { final: true },
  },
});

const pool = setup({
  use: [children, effects, spawn, persist],
  shape: "skq9z0bu",
  states: { open: types<{ running: number; done: string; pct: number }>() },
  events: { add: types<{ id: string }>(), cancel: types<{ id: string }>() },
  internal: {
    finished: types<{ output: { state: "finished"; data: { id: string } } }>(),
    progressed: types<{ pct: number }>(),
  },
  children: { worker: workerMachine },
});
export const poolMachine = pool.machine({
  start: ({ to }) => to("open", { running: 0, done: "", pct: 0 }),
  states: {
    open: {
      on: {
        add: ({ data, event, enq, to }) => {
          enq.spawn("worker", { key: event.id, input: { id: event.id } });
          enq.subscribeTo("worker", { key: event.id, done: "finished" });
          enq.listen("worker", "progress", "progressed", { key: event.id });
          return to("open", { running: data.running + 1, done: data.done, pct: data.pct });
        },
        cancel: ({ data, event, enq, to }) => {
          enq.stop("worker", event.id);
          return to("open", { running: data.running - 1, done: data.done, pct: data.pct });
        },
        finished: ({ data, event, to }) =>
          to("open", { running: data.running - 1, done: data.done + event.output.data.id, pct: data.pct }),
        progressed: ({ data, event, to }) => to("open", { running: data.running, done: data.done, pct: event.pct }),
      },
    },
  },
});
