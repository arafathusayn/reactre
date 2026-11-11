// The smallest job that distinguishes the flat machine's lean task runner from its pure transition
// path: entry starts a task and an incompatible timer; leaving for the task's result cancels both.

import { setup, types } from "@reactre/state";

const job = setup({
  states: {
    idle: types<{}>(),
    working: types<{}>(),
    done: types<{ readonly id: string }>(),
    failed: types<{ readonly error: string }>(),
    stale: types<{}>(),
  },
  events: { run: types<{}>(), retry: types<{}>(), reset: types<{}>(), stale: types<{}>() },
  internal: { finished: types<{ readonly id: string }>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { run: ({ to }) => to("working") } },
    working: {
      task: {
        run: async () => {
          await Promise.resolve();
          return { type: "finished", id: "job-1" };
        },
        error: ({ to }) => to("failed", { error: "task" }),
      },
      after: { "20ms": ({ to }) => to("failed", { error: "timer" }) },
      on: {
        finished: ({ event, to }) => to("done", { id: event.id }),
        stale: ({ to }) => to("stale"),
      },
    },
    done: { final: true },
    failed: { on: { retry: ({ to }) => to("idle") } },
    stale: { on: { reset: ({ to }) => to("idle") } },
  },
});
