// A machine with route states, compiled when loaded after ../../compiled.ts.

import { setup, types } from "@reactre/state";
import { route } from "@reactre/state/route";

const shop = setup({
  use: [route],
  states: {
    home: types<{}>(),
    cart: types<{ items: number }>(),
    checkout: types<{ items: number }>(),
    receipt: types<{ id: string }>(),
  },
  events: { add: types<{}>(), pay: types<{ id: string }>() },
});

export const shopMachine = shop.machine({
  start: ({ to }) => to("home"),
  states: {
    home: { route: ({ to }) => to("home"), on: { add: ({ to }) => to("cart", { items: 1 }) } },
    cart: { on: { add: ({ data, to }) => to("cart", { items: data.items + 1 }) } },
    // Routable from anywhere, but only with items in the cart: the route is its guard too.
    checkout: {
      route: ({ state, data, to }) =>
        state === "cart" && data.items > 0 ? to("checkout", { items: data.items }) : null,
      on: { pay: ({ event, to }) => to("receipt", { id: event.id }) },
    },
    receipt: { final: true },
  },
});
