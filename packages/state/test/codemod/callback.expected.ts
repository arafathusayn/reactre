// A clock in XState v5: a callback actor with input that sends events back, which the state
// handles.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createCallbackLogic, logic } from "@reactre/state/logic";

export const ticker = createCallbackLogic<{ type: "noop" }, { every: number }, { type: "tick" }>(
  ({ input, sendBack }) => {
    const id = setInterval(() => sendBack({ type: "tick" }), input.every);
    return () => clearInterval(id);
  },
);

const clock = setup({
  use: [children, logic],
  states: { idle: types<{ ticks: number }>(), running: types<{ ticks: number }>() },
  events: { start: types<{}>(), stop: types<{}>(), tick: types<{}>() },
  children: { ticker },
});

export const clockMachine = clock.machine({
  start: ({ to }) => to("idle", { ticks: 0 }),
  states: {
    idle: { on: { start: ({ data, to }) => to("running", data) } },
    running: {
      on: {
        tick: ({ data, to }) => (data.ticks >= 2 ? to("idle", { ticks: 0 }) : to("running", { ticks: data.ticks + 1 })),
        stop: ({ data, to }) => to("idle", data),
      },
      children: {
        ticker: {
          input: () => ({ every: 20 }),
          error: ({ data, to }) => to("idle", data),
          on: {
            tick: ({ data, to }) =>
              data.ticks >= 2 ? to("idle", { ticks: 0 }) : to("running", { ticks: data.ticks + 1 }),
          },
        },
      },
    },
  },
});
