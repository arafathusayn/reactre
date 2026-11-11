// A pool in XState v5: spawnChild starts a worker machine by id, and stopChild stops it.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { effects } from "@reactre/state/effects";
import { spawn } from "@reactre/state/spawn";

const worker = setup({
  states: { working: types<{}>(), finished: types<{}>() },
  events: { finish: types<{}>() },
});

export const workerMachine = worker.machine({
  start: ({ to }) => to("working"),
  states: {
    working: { on: { finish: ({ to }) => to("finished") } },
    finished: { final: true },
  },
});

const pool = setup({
  use: [children, effects, spawn],
  states: { open: types<{ running: number }>(), closed: types<{ running: number }>() },
  events: { add: types<{}>(), cancel: types<{}>(), close: types<{}>() },
  children: { worker: workerMachine },
});

export const poolMachine = pool.machine({
  start: ({ to }) => to("open", { running: 0 }),
  states: {
    open: {
      on: {
        add: ({ data, enq, to }) => (enq.spawn("worker", { key: "w1" }), to("open", { running: data.running + 1 })),
        cancel: ({ data, enq, to }) => (enq.stop("worker", "w1"), to("open", { running: data.running - 1 })),
        close: ({ data, to }) => to("closed", data),
      },
    },
    closed: { final: true },
  },
});
