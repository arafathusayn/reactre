// A checkout in XState v6: transition functions with block bodies, early returns, targetless
// context updates (patches), and named guards called from the functions.

import { setup, types } from "xstate6";

export const checkoutMachine = setup({
  schemas: {
    context: types<{ items: number; total: number; coupon: string | null; paid: number | null }>(),
    events: {
      add: types<{ price: number }>(),
      apply: types<{ code: string }>(),
      pay: types<{}>(),
      back: types<{}>(),
      confirm: types<{}>(),
    },
  },
  guards: {
    hasItems: (items: number) => items > 0,
    validCode: (code: string) => code.startsWith("SAVE"),
  },
}).createMachine({
  context: { items: 0, total: 0, coupon: null, paid: null },
  initial: "cart",
  states: {
    cart: {
      on: {
        add: ({ context, event }) => ({ context: { items: context.items + 1, total: context.total + event.price } }),
        apply: ({ context, event, guards }) => {
          if (!guards.validCode(event.code)) return;
          return { context: { ...context, coupon: event.code } };
        },
        pay: ({ context, guards }) => {
          if (guards.hasItems(context.items)) {
            return { target: "paying" };
          }
        },
      },
    },
    paying: {
      on: {
        back: { target: "cart" },
        confirm: ({ context }) => {
          const discount = context.coupon === null ? 0 : 10;
          return { target: "paid", context: { paid: context.total - discount } };
        },
      },
    },
    paid: { type: "final" },
  },
});
