// An editor in XState v5: nested states, a parent's transition, `assign`, a named guard, a
// targetless update, and a `#id` target.

import { assign, setup } from "./xstate5.ts";

export const editorMachine = setup({
  types: {} as {
    context: { text: string; by: string | null };
    events:
      | { type: "open" }
      | { type: "write"; text: string }
      | { type: "submit"; by: string }
      | { type: "revise" }
      | { type: "cancel" }
      | { type: "approve" };
  },
  guards: {
    hasText: ({ context }) => context.text.length > 0,
  },
}).createMachine({
  id: "editor",
  context: { text: "", by: null },
  initial: "idle",
  states: {
    idle: { on: { open: { target: "edit", actions: assign({ text: "" }) } } },
    edit: {
      initial: "draft",
      on: { cancel: "idle" },
      states: {
        draft: {
          on: {
            write: { actions: assign({ text: ({ event }) => event.text }) },
            submit: { guard: "hasText", target: "review", actions: assign({ by: ({ event }) => event.by }) },
          },
        },
        review: { on: { revise: "draft", approve: "#editor.sent" } },
      },
    },
    sent: { type: "final" },
  },
});
