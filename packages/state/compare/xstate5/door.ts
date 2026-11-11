// test/fixtures/door.ts in XState v5, as its docs write it: `setup` with types, `assign` for
// context, a named guard. v5 has no per-state context, so `by` and `code` are fields of one context
// (null outside open and locked), as in the v6 port. Its pure transition is `transition()`.

import { assign, setup } from "xstate";

export type DoorEvent =
  | { readonly type: "push"; readonly by: string }
  | { readonly type: "close" }
  | { readonly type: "lock"; readonly code: string }
  | { readonly type: "unlock"; readonly code: string };

export const doorMachine = setup({
  types: {
    context: {} as { by: string | null; code: string | null },
    events: {} as DoorEvent,
  },
  guards: {
    codeMatches: ({ context, event }) => event.type === "unlock" && event.code === context.code,
  },
}).createMachine({
  id: "door",
  context: { by: null, code: null },
  initial: "closed",
  states: {
    closed: {
      on: {
        push: { target: "open", actions: assign(({ event }) => ({ by: event.by, code: null })) },
        lock: { target: "locked", actions: assign(({ event }) => ({ by: null, code: event.code })) },
      },
    },
    open: { on: { close: { target: "closed" } } },
    locked: { on: { unlock: { guard: "codeMatches", target: "closed" } } },
  },
});
