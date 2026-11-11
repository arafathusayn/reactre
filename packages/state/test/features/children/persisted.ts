// PAGE with persist in use, compiled by the plugin (../../compiled.ts) for ./saved.test.ts: a page
// whose busy node runs a keyed child, so the saved snapshot carries the child's run.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { persist } from "@reactre/state/persist";

const worker = setup({
  states: { working: types<{}>(), finished: types<{ url: string }>() },
  events: { finish: types<{ url: string }>() },
});
export const childMachine = worker.machine({
  start: ({ to }) => to("working"),
  states: {
    working: { on: { finish: ({ event, to }) => to("finished", { url: event.url }) } },
    finished: { final: true },
  },
});

const page = setup({
  use: [children, persist],
  shape: "x6ja2u07",
  states: { idle: types<{}>(), busy: types<{ files: string[]; seen: string }>(), done: types<{ url: string }>() },
  events: { go: types<{}>() },
  children: { job: childMachine },
});
export const pageMachine = page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy", { files: ["a"], seen: "" }) } },
    busy: {
      children: {
        job: {
          each: ({ data }) => data.files.map((f) => ({ key: f, input: undefined })),
          done: ({ output, to }) => to("done", { url: output.data.url }),
          update: ({ data, child, to }) => to("busy", { ...data, seen: child.state }),
        },
      },
    },
    done: { final: true },
  },
});
