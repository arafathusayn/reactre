// A machine of plain transitions: compiled, it ships the actor alone (no tasks module).

import { setup, types } from "@reactre/state";

const door = setup({
  version: 2,
  states: { closed: types<{}>(), open: types<{ by: string }>(), locked: types<{ code: string }>() },
  events: {
    push: types<{ by: string }>(),
    close: types<{}>(),
    lock: types<{ code: string }>(),
    unlock: types<{ code: string }>(),
  },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: {
      on: {
        push: ({ event, to }) => to("open", { by: event.by }),
        lock: ({ event, to }) => to("locked", { code: event.code }),
      },
    },
    open: { on: { close: ({ to }) => to("closed") } },
    locked: { on: { unlock: ({ data, event, to }) => (event.code === data.code ? to("closed") : null) } },
  },
});
