// A machine with tags, meta and descriptions, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { tags } from "@reactre/state/tags";

const job = setup({
  use: [nested, tags],
  states: {
    idle: types<{}>(),
    "work.saving": types<{ text: string }>(),
    "work.retrying": types<{ text: string }>(),
    saved: types<{}>(),
  },
  events: { save: types<{ text: string }>(), fail: types<{}>(), ok: types<{}>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      description: "Waiting for a save",
      on: { save: ({ event, to }) => to("work.saving", { text: event.text }) },
    },
    // A parent's tags and meta hold for every leaf under it.
    work: { tags: ["busy"], meta: { spinner: true } },
    "work.saving": {
      tags: ["writing"],
      meta: { label: "Saving" },
      on: { fail: ({ data, to }) => to("work.retrying", { text: data.text }), ok: ({ to }) => to("saved") },
    },
    "work.retrying": { meta: { label: "Retrying" }, on: { ok: ({ to }) => to("saved") } },
    // A final state takes them too.
    saved: { final: true, tags: ["done"], meta: { label: "Saved" }, description: "The text is saved" },
  },
});
