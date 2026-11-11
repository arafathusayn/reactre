// A clock in XState v5: a callback actor with input that sends events back, which the state
// handles.

import { assign, fromCallback, setup } from "./xstate5.ts";

export const ticker = fromCallback<{ type: "noop" }, { every: number }>(({ input, sendBack }) => {
  const id = setInterval(() => sendBack({ type: "tick" }), input.every);
  return () => clearInterval(id);
});

export const clockMachine = setup({
  types: {} as { context: { ticks: number }; events: { type: "start" } | { type: "stop" } | { type: "tick" } },
  actors: { ticker },
}).createMachine({
  context: { ticks: 0 },
  initial: "idle",
  states: {
    idle: { on: { start: "running" } },
    running: {
      invoke: { src: "ticker", input: { every: 20 }, onError: "idle" },
      on: {
        tick: [
          { guard: ({ context }) => context.ticks >= 2, target: "idle", actions: assign({ ticks: 0 }) },
          { actions: assign({ ticks: ({ context }) => context.ticks + 1 }) },
        ],
        stop: "idle",
      },
    },
  },
});
