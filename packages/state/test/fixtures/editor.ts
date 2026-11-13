// A machine with a parent and history: "edit" is the parent of "edit.draft" and "edit.review". Its
// handlers apply to both leaves, its timer runs while either is active, and `back("edit", ...)`
// returns to the leaf it held when it was left.

import { setup, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const editor = setup({
  use: [nested, history],
  states: {
    idle: types<{}>(),
    "edit.draft": types<{ text: string }>(),
    "edit.review": types<{ text: string; by: string }>(),
    away: types<{}>(),
    sent: types<{ text: string }>(),
  },
  events: {
    open: types<{}>(),
    write: types<{ text: string }>(),
    submit: types<{ by: string }>(),
    revise: types<{}>(),
    approve: types<{}>(),
    cancel: types<{}>(),
    leave: types<{}>(),
    resume: types<{}>(),
  },
});

export const editorMachine = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    // The parent: its handlers apply to every leaf under it, after the leaf's own.
    edit: {
      on: {
        cancel: ({ to }) => to("idle"),
        leave: ({ to }) => to("away"),
        // `state` narrows `data`: only a draft takes more text. A review declines.
        write: ({ state, data, event, to }) =>
          state === "edit.draft" ? to("edit.draft", { text: data.text + event.text }) : null,
      },
      // A parent's timer runs while any leaf under it is active, through the leaves' moves.
      after: { "40ms": ({ to }) => to("away") },
    },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": {
      on: {
        revise: ({ data, to }) => to("edit.draft", { text: data.text }),
        approve: ({ data, to }) => to("sent", { text: data.text }),
        // Declined for a review by "boss": the event bubbles to the parent, which cancels.
        cancel: ({ data, to }) => (data.by === "boss" ? null : to("edit.draft", { text: data.text })),
      },
    },
    away: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })) } },
    sent: { final: true },
  },
});
