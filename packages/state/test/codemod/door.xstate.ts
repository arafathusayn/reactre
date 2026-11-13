// The door in XState v6 (compare/xstate/door.ts): typestates, transition functions, `undefined` to refuse.

import { setup, types } from "xstate6";

export const doorMachine = setup({
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
    open: { schemas: { context: types<{ by: string }>() } },
    locked: { schemas: { context: types<{ code: string }>() } },
  },
}).createMachine({
  id: "door",
  version: "2",
  context: { by: null, code: null },
  initial: "closed",
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
