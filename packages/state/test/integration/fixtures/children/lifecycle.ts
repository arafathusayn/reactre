// A parent with a child, compiled by the plugin as a build compiles it: the parent's "busy" node
// runs a "job" child, and the parent can cancel (leave the node) or stop. The child records its
// own start in `log`, so a test can tell that a cancelled parent's child stopped, and that a
// restart starts a new one.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";

/** What the child did, in order: "start <id>". */
export const log: string[] = [];

const job = setup({
  input: types<{ id: string }>(),
  states: { working: types<{ id: string }>(), done: types<{ id: string }>() },
  events: { finish: types<{}>() },
  internal: { started: types<{}>() },
});

export const jobMachine = job.machine({
  start: ({ input, to }) => to("working", { id: input.id }),
  states: {
    working: {
      // The task is the side effect a transition may not be: it records the child's start.
      task: {
        run: async ({ data }) => {
          log.push(`start ${data.id}`);
          return { type: "started" };
        },
        error: ({ data, keep }) => keep("working", data),
      },
      on: {
        started: ({ data, keep }) => keep("working", data),
        finish: ({ data, to }) => to("done", { id: data.id }),
      },
    },
    done: { final: true },
  },
});

const parent = setup({
  use: [children],
  states: {
    idle: types<{ n: number }>(),
    busy: types<{ n: number; seen: string }>(),
    finished: types<{ n: number }>(),
  },
  events: { go: types<{}>(), cancel: types<{}>() },
  children: { job: jobMachine },
});

export const parentMachine = parent.machine({
  start: ({ to }) => to("idle", { n: 0 }),
  states: {
    idle: { on: { go: ({ data, to }) => to("busy", { n: data.n + 1, seen: "" }) } },
    busy: {
      children: {
        job: {
          input: ({ data }) => ({ id: `job-${data.n}` }),
          done: ({ data, to }) => to("finished", { n: data.n }),
          update: ({ data, child, keep }) => keep("busy", { ...data, seen: child.state }),
        },
      },
      on: { cancel: ({ data, to }) => to("idle", { n: data.n }) },
    },
    finished: { final: true },
  },
});
