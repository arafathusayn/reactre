// A durable parallel node whose regions each run a child, for the reenter regression: "back" is a
// parallel node with regions "left" and "right", each in a leaf that runs a "job" child. A reenter
// of the left region's leaf restarts the left region's child alone: the right region's child keeps
// its entry and its timer.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { durable } from "@reactre/state/durable";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";
import { reenter } from "@reactre/state/reenter";

const job = setup({
  input: types<{ id: string }>(),
  states: { working: types<{ id: string }>(), done: types<{ id: string }>() },
  events: { finish: types<{}>() },
});

export const jobMachine = job.machine({
  start: ({ input, to }) => to("working", { id: input.id }),
  states: {
    working: {
      // A timer, so the child's entry is visible in the host's schedule.
      after: { "900ms": ({ data, to }) => to("done", { id: data.id }) },
      on: { finish: ({ data, to }) => to("done", { id: data.id }) },
    },
    done: { final: true },
  },
});

const back = setup({
  use: [durable, nested, parallel, reenter, children],
  shape: "vqkgwno0",
  parallel: ["back"],
  states: {
    home: types<{}>(),
    "back.left.working": types<{ n: number }>(),
    "back.left.done": types<{}>(),
    "back.right.working": types<{ n: number }>(),
    "back.right.done": types<{}>(),
  },
  events: { go: types<{}>(), retry: types<{}>() },
  children: { job: jobMachine },
});

export const backMachine = back.machine({
  start: ({ to }) => to("home"),
  states: {
    home: {
      on: {
        go: ({ to }) =>
          to("back", {
            left: to("back.left.working", { n: 0 }),
            right: to("back.right.working", { n: 0 }),
          }),
      },
    },
    // The parallel node: its regions end in their own final leaves.
    back: { done: ({ to }) => to("home") },
    // The left region's leaf: a retry reenters it, restarting its child with the new data.
    "back.left.working": {
      children: { job: { input: ({ data }) => ({ id: `left-${data.n}` }), done: ({ to }) => to("back.left.done") } },
      on: { retry: ({ reenter }) => reenter("back.left.working", { n: 1 }) },
    },
    "back.left.done": { final: true },
    "back.right.working": {
      children: { job: { input: ({ data }) => ({ id: `right-${data.n}` }), done: ({ to }) => to("back.right.done") } },
    },
    "back.right.done": { final: true },
  },
});
