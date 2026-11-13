// An order workflow at version 2, with the steps that migrate its versions 0 and 1: compiled by the
// plugin (../../compiled.ts), for ./persist.test.ts.
//
//   - version 0: `cart` ({ id, count }) and `done` ({ id });
//   - version 1: renamed to `open` ({ id, count }) and `closed` ({ id });
//   - version 2: `count` is `items`, and `closed` became `paid` (with a receipt) or `cancelled`.

import { setup, types } from "@reactre/state";
import { migrations, persist } from "@reactre/state/persist";

const order = setup({
  use: [persist],
  version: 2,
  shape: "5tpcnaht",
  input: types<{ id: string }>(),
  states: {
    open: types<{ id: string; items: number }>(),
    paid: types<{ id: string; items: number; receipt: string }>(),
    cancelled: types<{ id: string }>(),
  },
  events: { add: types<{}>(), pay: types<{ receipt: string }>(), cancel: types<{}>() },
});

export const orderMachine = order.machine({
  start: ({ input, to }) => to("open", { id: input.id, items: 0 }),
  states: {
    open: {
      on: {
        add: ({ data, keep }) => keep("open", { id: data.id, items: data.items + 1 }),
        pay: ({ data, event, to }) => to("paid", { id: data.id, items: data.items, receipt: event.receipt }),
        cancel: ({ data, to }) => to("cancelled", { id: data.id }),
      },
      after: { "1h": ({ data, to }) => to("cancelled", { id: data.id }) },
    },
    paid: { final: true },
    cancelled: { final: true },
  },
});

/** Reads a stored order of any version into version 2. */
export const migrate = migrations(orderMachine)
  .from<1, { open: { id: string; count: number }; closed: { id: string } }>(({ state, data, to }) =>
    state === "open" ? to("open", { id: data.id, items: data.count }) : to("cancelled", { id: data.id }),
  )
  .from<0, { cart: { id: string; count: number }; done: { id: string } }>(({ state, data, to }) =>
    state === "cart" ? to("open", { id: data.id, count: data.count }) : to("closed", { id: data.id }),
  );
