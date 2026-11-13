// A machine with a parent, a timer and a task, for the nested-only lifecycle: the editor's shape
// (a parent over two leaves, `back` to it) plus a task on a leaf, so the lifecycle's node diff,
// `update`, `deliver` and `stop` all have something to do. No children, effects, persist, inspect
// or reenter: exactly the machine a statically selected nested-only lifecycle may serve.

import { setup, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

/** What the machine's task and timer did, in order: the test reads it. */
export const log: string[] = [];

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
    leave: types<{}>(),
    resume: types<{}>(),
  },
  // The task's result: an internal event, so only the machine's own task sends it.
  internal: { saved: types<{}>() },
});

export const editorMachine = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: {
      on: {
        leave: ({ to }) => to("away"),
        // A parent's handler applies to every leaf under it, after the leaf's own.
        write: ({ state, data, event, to }) =>
          state === "edit.draft" ? to("edit.draft", { text: data.text + event.text }) : null,
      },
      // A parent's timer runs while any leaf under it is active, through the leaves' moves.
      after: { "40ms": ({ to }) => to("away") },
    },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": {
      on: { saved: ({ data, to }) => to("sent", { text: data.text }) },
      // A leaf's task: its result is delivered to the machine, and its `error` decides a move.
      task: {
        run: async ({ data }) => {
          log.push(`run ${data.text}`);
          return { type: "saved" };
        },
        error: ({ to }) => to("idle"),
      },
    },
    away: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })) } },
    sent: { final: true },
  },
});
