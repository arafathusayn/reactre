// An editor in XState v5: nested states, a parent's transition, `assign`, a named guard, a
// targetless update, and a `#id` target.

import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";

const editor = setup({
  use: [nested],
  states: {
    idle: types<{ text: string }>(),
    "edit.draft": types<{ text: string }>(),
    "edit.review": types<{ text: string; by: string }>(),
    sent: types<{ text: string; by: string }>(),
  },
  events: {
    open: types<{}>(),
    write: types<{ text: string }>(),
    submit: types<{ by: string }>(),
    revise: types<{}>(),
    cancel: types<{}>(),
    approve: types<{}>(),
  },
});

export const editorMachine = editor.machine({
  start: ({ to }) => to("idle", { text: "" }),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { cancel: ({ data, to }) => to("idle", { text: data.text }) } },
    "edit.draft": {
      on: {
        write: ({ event, to }) => to("edit.draft", { text: event.text }),
        submit: ({ data, event, to }) =>
          data.text.length > 0 ? to("edit.review", { text: data.text, by: event.by }) : null,
      },
    },
    "edit.review": {
      on: {
        revise: ({ data, to }) => to("edit.draft", { text: data.text }),
        approve: ({ data, to }) => to("sent", data),
      },
    },
    sent: { final: true },
  },
});
