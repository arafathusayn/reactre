// Machines whose parents complete, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { output } from "@reactre/state/output";
import { parallel } from "@reactre/state/parallel";

// A parent's done gets its final leaf (the output is that leaf's data), and the machine ends in a
// final leaf no parent with a done is over.
const upload = setup({
  use: [nested, output],
  states: {
    idle: types<{}>(),
    "upload.sending": types<{ file: string }>(),
    "upload.sent": types<{ url: string }>(),
    "upload.failed": types<{ reason: string }>(),
    uploaded: types<{ url: string }>(),
    gaveUp: types<{ reason: string }>(),
  },
  events: { send: types<{ file: string }>(), ok: types<{}>(), fail: types<{ reason: string }>() },
});

export const uploadMachine = upload.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { send: ({ event, to }) => to("upload.sending", { file: event.file }) } },
    upload: {
      // `state` and `data` are any leaf's under "upload" (types can't read which are final while
      // they type the config): narrow on each final leaf.
      done: ({ state, data, to }) =>
        state === "upload.sent"
          ? to("uploaded", { url: data.url })
          : to("gaveUp", { reason: state === "upload.failed" ? data.reason : "" }),
    },
    "upload.sending": {
      on: {
        ok: ({ data, to }) => to("upload.sent", { url: `/files/${data.file}` }),
        fail: ({ event, to }) => to("upload.failed", { reason: event.reason }),
      },
    },
    "upload.sent": { final: true },
    "upload.failed": { final: true },
    uploaded: { final: true },
    gaveUp: { final: true },
  },
});

// A parent inside a region completes before its region could end.
const job = setup({
  use: [nested, parallel, output],
  parallel: ["work"],
  states: {
    "work.fetch.get.trying": types<{}>(),
    "work.fetch.get.got": types<{ body: string }>(),
    "work.fetch.ok": types<{ body: string }>(),
    "work.log.on": types<{}>(),
    "work.log.off": types<{}>(),
    finished: types<{ body: string }>(),
  },
  events: { got: types<{ body: string }>(), quiet: types<{}>() },
});

export const jobMachine = job.machine({
  start: ({ to }) => to("work", { fetch: to("work.fetch.get.trying"), log: to("work.log.on") }),
  states: {
    work: {
      done: ({ data, to }) =>
        to("finished", { body: data.fetch.state === "work.fetch.ok" ? data.fetch.data.body : "" }),
    },
    "work.fetch.get": {
      done: ({ state, data, to }) => to("work.fetch.ok", { body: state === "work.fetch.get.got" ? data.body : "" }),
    },
    "work.fetch.get.trying": { on: { got: ({ event, to }) => to("work.fetch.get.got", { body: event.body }) } },
    "work.fetch.get.got": { final: true },
    "work.fetch.ok": { final: true },
    "work.log.on": { on: { quiet: ({ to }) => to("work.log.off") } },
    "work.log.off": { final: true },
    finished: { final: true },
  },
});
