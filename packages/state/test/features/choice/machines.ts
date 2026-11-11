// A machine with a choice state, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { choice } from "@reactre/state/choice";

const order = setup({
  use: [choice],
  states: {
    idle: types<{}>(),
    routing: types<{ total: number; vip: boolean }>(),
    vip: types<{ total: number }>(),
    review: types<{ total: number }>(),
    standard: types<{ total: number }>(),
  },
  events: { checkout: types<{ total: number; vip: boolean }>(), reset: types<{}>() },
});

export const orderMachine = order.machine({
  start: ({ to }) => to("routing", { total: 0, vip: false }),
  states: {
    idle: { on: { checkout: ({ event, to }) => to("routing", { total: event.total, vip: event.vip }) } },
    // The machine never rests here: it decides, in the same step.
    routing: {
      choice: ({ data, to }) =>
        data.vip
          ? to("vip", { total: data.total })
          : data.total > 100
            ? to("review", { total: data.total })
            : data.total === 0
              ? to("idle")
              : to("standard", { total: data.total }),
    },
    vip: { on: { reset: ({ to }) => to("idle") } },
    review: { on: { reset: ({ to }) => to("idle") } },
    standard: { on: { reset: ({ to }) => to("idle") } },
  },
});
