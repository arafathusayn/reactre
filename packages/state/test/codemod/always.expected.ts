// A wizard in XState v5: always with a guard, tags, meta and descriptions, reenter, a "*"
// handler, and a compound state whose onDone moves on when its final state is reached.

import { setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";
import { nested } from "@reactre/state/nested";
import { output } from "@reactre/state/output";
import { reenter } from "@reactre/state/reenter";
import { tags } from "@reactre/state/tags";
import { wildcards } from "@reactre/state/wildcards";

const wizard = setup({
  use: [nested, output, always, reenter, tags, wildcards],
  states: {
    "form.asking": types<{ step: number; tries: number }>(),
    "form.answered": types<{ step: number; tries: number }>(),
    review: types<{ tries: number }>(),
  },
  events: { next: types<{}>(), retry: types<{}>(), noise: types<{}>() },
});

export const wizardMachine = wizard.machine({
  start: ({ to }) => to("form.asking", { step: 0, tries: 0 }),
  states: {
    form: {
      tags: ["editing"],
      description: "Collects the answers.",
      done: ({ data, to }) => to("review", { tries: data.tries }),
    },
    "form.asking": {
      meta: { label: "Asking" },
      on: { next: ({ data, reenter }) => reenter("form.asking", { ...data, step: data.step + 1 }) },
      always: ({ data, to }) => (data.step >= 2 ? to("form.answered", data) : null),
    },
    "form.answered": { tags: ["finished"], description: "Every answer is in.", final: true },
    review: {
      tags: ["done"],
      on: {
        retry: ({ data, reenter }) => reenter("review", { tries: data.tries + 1 }),
        "*": ({ data, to }) => to("form.asking", { step: 0, tries: data.tries }),
      },
    },
  },
});
