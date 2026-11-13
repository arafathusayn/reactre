// A machine of plain transitions: compiled, it ships the actor alone.

import { setup, types } from "@reactre/state";

const door = setup({
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});
