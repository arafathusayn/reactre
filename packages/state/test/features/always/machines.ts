// Machines with eventless transitions, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";
import { nested } from "@reactre/state/nested";

// A flat machine: three adds fill the cart, and `always` moves on in the same step.
const cart = setup({
  use: [always],
  states: { filling: types<{ n: number }>(), full: types<{ n: number }>() },
  events: { add: types<{}>(), empty: types<{}>() },
});

export const cartMachine = cart.machine({
  start: ({ to }) => to("filling", { n: 2 }),
  states: {
    filling: {
      on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) },
      always: ({ data, to }) => (data.n >= 3 ? to("full", { n: data.n }) : null),
    },
    full: { on: { empty: ({ to }) => to("filling", { n: 0 }) } },
  },
});

// A parent's always, and a timer that moves into a state whose always moves on.
const editor = setup({
  use: [nested, always],
  states: {
    idle: types<{}>(),
    "edit.draft": types<{ text: string }>(),
    "edit.long": types<{ text: string }>(),
    saved: types<{}>(),
  },
  events: { open: types<{}>(), write: types<{ text: string }>(), save: types<{}>() },
});

export const editorMachine = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    // Every leaf under "edit": a text over 5 characters is long.
    edit: {
      always: ({ state, data, to }) =>
        state === "edit.draft" && data.text.length > 5 ? to("edit.long", { text: data.text }) : null,
      after: { "20ms": ({ to }) => to("saved") },
    },
    "edit.draft": { on: { write: ({ to, event }) => to("edit.draft", { text: event.text }) } },
    "edit.long": { on: { save: ({ to }) => to("saved") } },
    saved: { final: true },
  },
});

// A loop: each always goes to the other, counting (with the same data, the build refuses it).
const loop = setup({
  use: [always],
  states: { idle: types<{}>(), a: types<{ n: number }>(), b: types<{ n: number }>() },
  events: { go: types<{}>() },
});

export const loopMachine = loop.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("a", { n: 0 }) } },
    a: { always: ({ data, to }) => to("b", { n: data.n + 1 }) },
    b: { always: ({ data, to }) => to("a", { n: data.n + 1 }) },
  },
});
