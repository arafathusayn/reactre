// Inspected machines, compiled as a build compiles them (../../compiled.ts registers the plugin): an
// upload that a page runs as its child, both with `use: [inspect]`, and the door without it.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { inspect } from "@reactre/state/inspect";

const upload = setup({
  use: [inspect],
  input: types<{ name: string }>(),
  states: { sending: types<{ name: string }>(), sent: types<{ name: string }>() },
  events: { ack: types<{}>() },
});
export const uploadMachine = upload.machine({
  start: ({ input, to }) => to("sending", { name: input.name }),
  states: {
    sending: { on: { ack: ({ data, to }) => to("sent", data) } },
    sent: { final: true },
  },
});

const page = setup({
  use: [children, inspect],
  states: { idle: types<{}>(), uploading: types<{ name: string }>(), done: types<{ name: string }>() },
  events: { pick: types<{ name: string }>(), cancel: types<{}>() },
  children: { upload: uploadMachine },
});
export const pageMachine = page.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { pick: ({ event, to }) => to("uploading", { name: event.name }) } },
    uploading: {
      children: {
        upload: { input: ({ data }) => ({ name: data.name }), done: ({ data, to }) => to("done", data) },
      },
      on: { cancel: ({ to }) => to("idle") },
    },
    done: { on: { pick: ({ event, to }) => to("uploading", { name: event.name }) } },
  },
});

const light = setup({
  use: [inspect],
  states: { off: types<{}>(), on: types<{}>() },
  events: { flip: types<{}>() },
});
export const lightMachine = light.machine({
  start: ({ to }) => to("off"),
  states: { off: { on: { flip: ({ to }) => to("on") } }, on: { on: { flip: ({ to }) => to("off") } } },
});
