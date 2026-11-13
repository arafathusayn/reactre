// A checkout in XState v6: transition functions with block bodies, early returns, targetless
// context updates (patches), and named guards called from the functions.

import { setup, types } from "@reactre/state";

const checkout = setup({
  states: {
    cart: types<{ items: number; total: number; coupon: string | null }>(),
    paying: types<{ items: number; total: number; coupon: string | null }>(),
    paid: types<{ items: number; total: number; coupon: string | null; paid: number }>(),
  },
  events: {
    add: types<{ price: number }>(),
    apply: types<{ code: string }>(),
    pay: types<{}>(),
    back: types<{}>(),
    confirm: types<{}>(),
  },
});

export const checkoutMachine = checkout.machine({
  start: ({ to }) => to("cart", { items: 0, total: 0, coupon: null }),
  states: {
    cart: {
      on: {
        add: ({ data, event, to }) => to("cart", { ...data, items: data.items + 1, total: data.total + event.price }),
        apply: ({ data, event, to }) => {
          if (!event.code.startsWith("SAVE")) return null;
          return to("cart", { ...data, coupon: event.code });
        },
        pay: ({ data, to }) => {
          if (data.items > 0) {
            return to("paying", data);
          }
          return null;
        },
      },
    },
    paying: {
      on: {
        back: ({ data, to }) => to("cart", data),
        confirm: ({ data, to }) => {
          const discount = data.coupon === null ? 0 : 10;
          return to("paid", { items: data.items, total: data.total, coupon: data.coupon, paid: data.total - discount });
        },
      },
    },
    paid: { final: true },
  },
});
