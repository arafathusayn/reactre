// A panel in XState v5: effects (entry, raise), an impure named guard, a callback actor, a delay
// computed from context and `always` convert to their opt-ins; stateIn, a context update built by
// a helper and an event no state handles become TODOs at their spots.

import { assign, fromCallback, log, raise, setup, stateIn } from "./xstate5.ts";

interface Panel {
  count: number;
  note: string;
}

export const bump = (panel: Panel): Panel => ({ ...panel, count: panel.count + 1 });

export const ticker = fromCallback(({ sendBack }) => {
  const id = setInterval(() => sendBack({ type: "tick" }), 1000);
  return () => clearInterval(id);
});

export const panelMachine = setup({
  types: {} as {
    context: Panel;
    events: { type: "open" } | { type: "close" } | { type: "tick" } | { type: "ping" };
  },
  actors: { ticker },
  guards: { isWeekday: () => new Date().getDay() % 6 !== 0 },
  delays: { idleTimeout: ({ context }) => context.count * 1000 },
}).createMachine({
  context: { count: 0, note: "" },
  initial: "closed",
  states: {
    closed: {
      entry: log("closed"),
      on: { open: { guard: "isWeekday", target: "opened", actions: raise({ type: "tick" }) } },
    },
    opened: {
      invoke: { src: "ticker" },
      on: {
        tick: { actions: assign(({ context }) => bump(context)) },
        close: { target: "closed", guard: stateIn("opened") },
      },
      after: { idleTimeout: { target: "closed" } },
      always: { guard: ({ context }) => context.count > 9, target: "closed" },
    },
  },
});
