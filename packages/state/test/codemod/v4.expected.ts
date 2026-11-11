// A counter written the XState v4 way: `createMachine<Context, Event>`, string targets, `cond`
// (inline and named, in the options), arrays of guarded transitions, and positional
// `(context, event)` arguments.

import { setup, types } from "@reactre/state";

const counter = setup({
  states: {
    active: types<{ count: number }>(),
    paused: types<{ count: number }>(),
    stopped: types<{ count: number }>(),
  },
  events: { INC: types<{ by: number }>(), DEC: types<{}>(), STOP: types<{}>(), RESUME: types<{}>() },
});

export const counterMachine = counter.machine({
  start: ({ to }) => to("active", { count: 0 }),
  states: {
    active: {
      on: {
        INC: ({ data, event, to }) => to("active", { count: data.count + event.by }),
        DEC: ({ data, to }) => (data.count > 0 ? to("active", { count: data.count - 1 }) : null),
        STOP: ({ data, to }) => (data.count >= 3 ? to("stopped", data) : to("paused", data)),
      },
    },
    paused: { on: { RESUME: ({ data, to }) => to("active", data) } },
    stopped: { final: true },
  },
});
