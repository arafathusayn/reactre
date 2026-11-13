// What always costs an app that uses it: a flat cart whose eventless transition settles after each
// move (the settle wrapper on the graph, S50's guard).

import { createActor, setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";

const cart = setup({
  use: [always],
  states: { filling: types<{ n: number }>(), full: types<{ n: number }>() },
  events: { add: types<{}>(), empty: types<{}>() },
});

export const cartMachine = cart.machine({
  start: ({ to }) => to("filling", { n: 2 }),
  states: {
    filling: {
      on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) },
      always: ({ data, to }) => (data.n >= 3 ? to("full", { n: data.n }) : null),
    },
    full: { on: { empty: ({ to }) => to("filling", { n: 0 }) } },
  },
});

export function run(): string {
  const actor = createActor(cartMachine);
  actor.send({ type: "add" });
  actor.send({ type: "empty" });
  return actor.snapshot().state;
}
