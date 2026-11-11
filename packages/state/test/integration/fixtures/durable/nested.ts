// A durable machine with a parent and a parallel node, for the reenter regression: "trip" is the
// parent of "trip.out" and "trip.back", and "trip.back" is a parallel node with the regions "left"
// and "right", each in a leaf. A reenter of the left region's leaf restarts that leaf alone: the
// parent's timer keeps its deadline, and the other region's timer is untouched.

import { setup, types } from "@reactre/state";
import { durable } from "@reactre/state/durable";
import { nested } from "@reactre/state/nested";
import { parallel } from "@reactre/state/parallel";
import { reenter } from "@reactre/state/reenter";

const trip = setup({
  use: [durable, nested, parallel, reenter],
  shape: "rujrrsdx",
  parallel: ["trip.back"],
  states: {
    home: types<{}>(),
    "trip.out": types<{}>(),
    "trip.back.left.working": types<{ n: number }>(),
    "trip.back.left.done": types<{}>(),
    "trip.back.right.working": types<{ n: number }>(),
    "trip.back.right.done": types<{}>(),
  },
  events: { go: types<{}>(), turn: types<{}>(), retry: types<{}>() },
});

export const tripMachine = trip.machine({
  start: ({ to }) => to("home"),
  states: {
    home: { on: { go: ({ to }) => to("trip.out") } },
    // The parent: its timer runs while any leaf under it is active.
    trip: { after: { "1000ms": ({ to }) => to("home") } },
    "trip.out": {
      on: {
        turn: ({ to }) =>
          to("trip.back", {
            left: to("trip.back.left.working", { n: 0 }),
            right: to("trip.back.right.working", { n: 0 }),
          }),
      },
    },
    // The parallel node: its regions end in their own final leaves.
    "trip.back": { done: ({ to }) => to("home") },
    // The left region's leaf: a retry reenters it, restarting its timer with the new data.
    "trip.back.left.working": {
      after: { "500ms": ({ to }) => to("trip.back.left.done") },
      on: { retry: ({ reenter }) => reenter("trip.back.left.working", { n: 1 }) },
    },
    "trip.back.left.done": { final: true },
    "trip.back.right.working": { after: { "700ms": ({ to }) => to("trip.back.right.done") } },
    "trip.back.right.done": { final: true },
  },
});
