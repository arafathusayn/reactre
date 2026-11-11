// A machine that type-checks but breaks a contract types can't see: a transition reads the clock,
// so replaying the same events gives other data. Every bundler's build must fail on it.

import { setup, types } from "@reactre/state";

const toggle = setup({
  states: { on: types<{ at: number }>(), off: types<{}>() },
  events: { flip: types<{}>() },
});

export const toggleMachine = toggle.machine({
  start: ({ to }) => to("off"),
  states: {
    off: { on: { flip: ({ to }) => to("on", { at: Date.now() }) } },
    on: { on: { flip: ({ to }) => to("off") } },
  },
});
