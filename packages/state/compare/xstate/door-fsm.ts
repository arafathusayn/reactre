// The door in xstate/fsm, XState v6's smallest build: a pure transition table, no actor runtime.

import { setup, types } from "xstate6/fsm";

export const doorFsm = setup({
  schemas: {
    context: types<{ by: string | null; code: string | null }>(),
    events: {
      push: types<{ by: string }>(),
      close: types<{}>(),
      lock: types<{ code: string }>(),
      unlock: types<{ code: string }>(),
    },
  },
  states: {
    // The FSM's types take targets only from the states listed here.
    closed: {},
    open: { schemas: { context: types<{ by: string }>() } },
    locked: { schemas: { context: types<{ code: string }>() } },
  },
}).createFSM({
  initial: "closed",
  context: { by: null, code: null },
  states: {
    closed: {
      on: {
        push: ({ event }) => ({ target: "open", context: { by: event.by, code: null } }),
        lock: ({ event }) => ({ target: "locked", context: { by: null, code: event.code } }),
      },
    },
    open: { on: { close: { target: "closed" } } },
    locked: {
      on: { unlock: ({ context, event }) => (event.code === context.code ? { target: "closed" } : undefined) },
    },
  },
});
