// The model for ../model.test.ts: a cart. `add` adds one of a SKU, `remove` takes the SKU out, and
// `checkout` ends a cart that isn't empty. An internal `priced` event is what a pricing task would
// produce, so the walk can deliver it.

import { setup, types } from "@reactre/state";

type Line = { sku: string; n: number };

const cart = setup({
  states: {
    shopping: types<{ lines: Line[] }>(),
    pricing: types<{ lines: Line[] }>(),
    checkedOut: types<{ lines: Line[]; total: number }>(),
  },
  events: { add: types<{ sku: string }>(), remove: types<{ sku: string }>(), checkout: types<{}>() },
  internal: { priced: types<{ total: number }>() },
});

export const cartMachine = cart.machine({
  start: ({ to }) => to("shopping", { lines: [] }),
  states: {
    shopping: {
      on: {
        add: ({ data, event, to }) =>
          to("shopping", {
            lines: data.lines.some((l) => l.sku === event.sku)
              ? data.lines.map((l) => (l.sku === event.sku ? { sku: l.sku, n: l.n + 1 } : l))
              : [...data.lines, { sku: event.sku, n: 1 }],
          }),
        remove: ({ data, event, to }) => to("shopping", { lines: data.lines.filter((l) => l.sku !== event.sku) }),
        checkout: ({ data, to }) => (data.lines.length > 0 ? to("pricing", { lines: data.lines }) : null),
      },
    },
    pricing: {
      task: {
        run: async ({ data }) => ({ type: "priced", total: data.lines.reduce((sum, l) => sum + l.n, 0) }),
        error: ({ data, to }) => to("shopping", { lines: data.lines }),
      },
      on: { priced: ({ data, event, to }) => to("checkedOut", { lines: data.lines, total: event.total }) },
      // A pricing that hangs goes back to the cart (M432: a task state needs a way out).
      after: { "30s": ({ data, to }) => to("shopping", { lines: data.lines }) },
    },
    checkedOut: { final: true },
  },
});
