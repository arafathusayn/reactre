// Machines with child actors and schemas, compiled: a page runs an upload child while it is
// uploading; a form's input, events and data are Standard Schemas, checked at runtime.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { validate } from "@reactre/state/validate";

import { object, string } from "./standard-schema.ts";

const upload = setup({
  input: types<{ file: string }>(),
  states: { sending: types<{ file: string }>(), sent: types<{ url: string }>(), failed: types<{ reason: string }>() },
  events: { ok: types<{ url: string }>(), fail: types<{ reason: string }>() },
});

export const uploadMachine = upload.machine({
  start: ({ input, to }) => to("sending", { file: input.file }),
  states: {
    sending: {
      on: {
        ok: ({ event, to }) => to("sent", { url: event.url }),
        fail: ({ event, to }) => to("failed", { reason: event.reason }),
      },
    },
    sent: { final: true },
    failed: { final: true },
  },
});

const page = setup({
  use: [children],
  states: {
    idle: types<{ file: string }>(),
    uploading: types<{ file: string; seen: string }>(),
    uploaded: types<{ url: string }>(),
    failed: types<{ reason: string }>(),
  },
  events: { go: types<{}>() },
  children: { upload: uploadMachine },
});

export const pageMachine = page.machine({
  start: ({ to }) => to("idle", { file: "a.txt" }),
  states: {
    idle: { on: { go: ({ data, to }) => to("uploading", { file: data.file, seen: "" }) } },
    uploading: {
      children: {
        upload: {
          input: ({ data }) => ({ file: data.file }),
          // `output` is the union of the child's final states: `state` narrows its data.
          done: ({ output, to }) =>
            output.state === "sent"
              ? to("uploaded", { url: output.data.url })
              : to("failed", { reason: output.data.reason }),
        },
      },
    },
    uploaded: { final: true },
    failed: { final: true },
  },
});

const form = setup({
  use: [validate],
  version: 1,
  input: object({ name: string() }),
  states: { editing: object({ name: string() }), done: types<{}>() },
  events: { rename: object({ name: string() }), finish: types<{}>() },
});

export const formMachine = form.machine({
  start: ({ input, to }) => to("editing", { name: input.name }),
  states: {
    editing: {
      on: { rename: ({ event, to }) => to("editing", { name: event.name }), finish: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});
