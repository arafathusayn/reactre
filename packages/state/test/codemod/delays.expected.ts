// A reminder in XState v5: after with delays named in setup, one a number and one computed from
// the context.

import { setup, types } from "@reactre/state";
import { delays } from "@reactre/state/delays";

const reminder = setup({
  use: [delays],
  delays: { sla: ({ data }: { data: { ms: number } }) => data.ms },
  states: {
    idle: types<{ ms: number }>(),
    waiting: types<{ ms: number }>(),
    late: types<{ ms: number }>(),
    done: types<{ ms: number }>(),
  },
  events: { start: types<{ ms: number }>(), answer: types<{}>() },
});

export const reminderMachine = reminder.machine({
  start: ({ to }) => to("idle", { ms: 0 }),
  states: {
    idle: { on: { start: ({ event, to }) => to("waiting", { ms: event.ms }) } },
    waiting: { on: { answer: ({ data, to }) => to("done", data) }, after: { sla: ({ data, to }) => to("late", data) } },
    late: { after: { "30ms": ({ data, to }) => to("done", data) } },
    done: { final: true },
  },
});
