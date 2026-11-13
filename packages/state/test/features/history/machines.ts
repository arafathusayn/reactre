// A form left and resumed with deep and shallow history, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

const form = setup({
  use: [nested, history],
  states: {
    idle: types<{}>(),
    "form.details.name": types<{ name: string }>(),
    "form.details.email": types<{ email: string }>(),
    "form.review": types<{ ok: boolean }>(),
  },
  events: {
    open: types<{}>(),
    next: types<{}>(),
    check: types<{}>(),
    leave: types<{}>(),
    deep: types<{}>(),
    shallow: types<{}>(),
  },
});

export const formMachine = form.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        open: ({ to }) => to("form.details.name", { name: "" }),
        // Deep: the leaf last left, with its data.
        deep: ({ back, to }) => back("form", to("form.details.name", { name: "" })),
        // Shallow: the child of "form" last left; "details" starts over at its step.
        shallow: ({ back, to }) =>
          back("form", to("form.details.name", { name: "" }), { details: to("form.details.name", { name: "again" }) }),
      },
    },
    form: { on: { leave: ({ to }) => to("idle") } },
    "form.details.name": { on: { next: ({ to }) => to("form.details.email", { email: "a@b" }) } },
    "form.details.email": { on: { check: ({ to }) => to("form.review", { ok: true }) } },
    "form.review": {},
  },
});
