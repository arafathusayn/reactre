// A pool in XState v5: spawnChild starts a worker machine by id, and stopChild stops it.

import { assign, setup, spawnChild, stopChild } from "./xstate5.ts";

export const workerMachine = setup({ types: {} as { events: { type: "finish" } } }).createMachine({
  initial: "working",
  states: { working: { on: { finish: "finished" } }, finished: { type: "final" } },
});

export const poolMachine = setup({
  types: {} as { context: { running: number }; events: { type: "add" } | { type: "cancel" } | { type: "close" } },
  actors: { worker: workerMachine },
}).createMachine({
  context: { running: 0 },
  initial: "open",
  states: {
    open: {
      on: {
        add: {
          actions: [spawnChild("worker", { id: "w1" }), assign({ running: ({ context }) => context.running + 1 })],
        },
        cancel: { actions: [stopChild("w1"), assign({ running: ({ context }) => context.running - 1 })] },
        close: "closed",
      },
    },
    closed: { type: "final" },
  },
});
