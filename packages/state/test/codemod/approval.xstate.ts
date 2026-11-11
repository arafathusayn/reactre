// An approval in XState v5 with mirrored states (M325): who approved is in the states' names, and
// the two approved states are the same state twice. The codemod keeps them, so the machine replays
// the same, with the fix as a TODO the compiler takes.

import { createMachine } from "./xstate5.ts";

export const approvalMachine = createMachine({
  initial: "pending",
  states: {
    pending: { on: { manager: { target: "approved_by_manager" }, director: { target: "approved_by_director" } } },
    approved_by_manager: { on: { pay: { target: "paid" }, reject: { target: "pending" } } },
    approved_by_director: { on: { pay: { target: "paid" }, reject: { target: "pending" } } },
    paid: { type: "final" },
  },
});
