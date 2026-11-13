// A wizard in XState v5: always with a guard, tags, meta and descriptions, reenter, a "*"
// handler, and a compound state whose onDone moves on when its final state is reached.

import { assign, setup } from "./xstate5.ts";

export const wizardMachine = setup({
  types: {} as {
    context: { step: number; tries: number };
    events: { type: "next" } | { type: "retry" } | { type: "noise" };
  },
}).createMachine({
  context: { step: 0, tries: 0 },
  initial: "form",
  states: {
    form: {
      description: "Collects the answers.",
      tags: ["editing"],
      initial: "asking",
      onDone: { target: "review" },
      states: {
        asking: {
          meta: { label: "Asking" },
          always: { guard: ({ context }) => context.step >= 2, target: "answered" },
          on: {
            next: { target: "asking", reenter: true, actions: assign({ step: ({ context }) => context.step + 1 }) },
          },
        },
        answered: { type: "final", tags: ["finished"], description: "Every answer is in." },
      },
    },
    review: {
      tags: ["done"],
      on: {
        retry: { target: "review", reenter: true, actions: assign({ tries: ({ context }) => context.tries + 1 }) },
        "*": { target: "form", actions: assign({ step: 0 }) },
      },
    },
  },
});
