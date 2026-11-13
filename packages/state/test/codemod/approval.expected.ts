// An approval in XState v5 with mirrored states (M325): who approved is in the states' names, and
// the two approved states are the same state twice. The codemod keeps them, so the machine replays
// the same, with the fix as a TODO the compiler takes.

import { setup, types } from "@reactre/state";

const approval = setup({
  states: {
    pending: types<{}>(),
    approved_by_manager: types<{}>(),
    approved_by_director: types<{}>(),
    paid: types<{}>(),
  },
  events: { manager: types<{}>(), director: types<{}>(), pay: types<{}>(), reject: types<{}>() },
});

export const approvalMachine = approval.machine({
  start: ({ to }) => to("pending"),
  states: {
    pending: {
      on: { manager: ({ to }) => to("approved_by_manager"), director: ({ to }) => to("approved_by_director") },
    },
    // TODO(@reactre/state): "approved_by_manager" and "approved_by_director" are the same state twice (same data, same handlers): make one state, "approved", with the difference in its data, { by: "manager" | "director" }
    approved_by_manager: { on: { pay: ({ to }) => to("paid"), reject: ({ to }) => to("pending") } },
    approved_by_director: { on: { pay: ({ to }) => to("paid"), reject: ({ to }) => to("pending") } },
    paid: { final: true },
  },
});
