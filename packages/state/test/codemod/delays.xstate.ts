// A reminder in XState v5: after with delays named in setup, one a number and one computed from
// the context.

import { assign, setup } from "./xstate5.ts";

export const reminderMachine = setup({
  types: {} as { context: { ms: number }; events: { type: "start"; ms: number } | { type: "answer" } },
  delays: { soon: 30, sla: ({ context }) => context.ms },
}).createMachine({
  context: { ms: 0 },
  initial: "idle",
  states: {
    idle: { on: { start: { target: "waiting", actions: assign({ ms: ({ event }) => event.ms }) } } },
    waiting: { after: { sla: "late" }, on: { answer: "done" } },
    late: { after: { soon: "done" } },
    done: { type: "final" },
  },
});
