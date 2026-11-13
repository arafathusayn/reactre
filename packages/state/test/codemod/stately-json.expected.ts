import { setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { nested } from "@reactre/state/nested";
import { provide } from "@reactre/state/provide";
import { tags } from "@reactre/state/tags";

// TODO(@reactre/state): guard "isEmpty" isn't written in this file: write its condition in isEmpty, and pass it the fields of data and the event it reads. Until then it is false
function isEmpty(): boolean {
  return false;
}

// TODO(@reactre/state): actor "chargeCard" isn't written in this file: write the task in chargeCard (it gets the invoke's input and an abort signal). Until then it finishes at once (its output is null)
async function chargeCard(_: { input?: unknown; signal: AbortSignal }): Promise<null> {
  return null;
}

const checkout = setup({
  use: [nested, effects, provide, tags],
  actions: {
    // TODO(@reactre/state): action "showEmptyCart" isn't written in this file: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing
    showEmptyCart: () => {},
    // TODO(@reactre/state): action "loadPaymentMethods" isn't written in this file: write it in setup's actions (it gets its params; pass it the fields of data and the event it reads). Until then it does nothing
    loadPaymentMethods: () => {},
  },
  states: {
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isEmpty, chargeCard) aren't written yet, so the fields each state reads aren't known
    Cart: types<{ items: null[]; total: number; coupon: null; express: boolean }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isEmpty, chargeCard) aren't written yet, so the fields each state reads aren't known
    "Details.Address": types<{ items: null[]; total: number; coupon: null; express: boolean }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isEmpty, chargeCard) aren't written yet, so the fields each state reads aren't known
    "Details.Payment": types<{ items: null[]; total: number; coupon: null; express: boolean }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isEmpty, chargeCard) aren't written yet, so the fields each state reads aren't known
    Paying: types<{ items: null[]; total: number; coupon: null; express: boolean }>(),
    // TODO(@reactre/state): narrow this state's data to the fields it uses: the stubs (isEmpty, chargeCard) aren't written yet, so the fields each state reads aren't known
    Paid: types<{ items: null[]; total: number; coupon: null; express: boolean }>(),
  },
  events: { checkout: types<{}>(), cancel: types<{}>(), next: types<{}>(), back: types<{}>(), pay: types<{}>() },
  internal: { chargeCardDone: types<{ output: Awaited<ReturnType<typeof chargeCard>> }>() },
});

export const checkoutMachine = checkout.machine({
  // TODO(@reactre/state): context field items has no type, and its initial value doesn't say ([]): it is null[] until you write its type in setup's states
  // TODO(@reactre/state): context field coupon has no type, and its initial value doesn't say (null): it is null until you write its type in setup's states
  start: ({ to }) => to("Cart", { items: [], total: 0, coupon: null, express: false }),
  states: {
    Cart: {
      description: "The cart, before checking out.",
      on: {
        checkout: ({ data, actions, enq, to }) =>
          isEmpty() ? (enq(actions.showEmptyCart), to("Cart", data)) : to("Details.Address", data),
      },
    },
    Details: { on: { cancel: ({ data, to }) => to("Cart", data) } },
    "Details.Address": { on: { next: ({ data, to }) => to("Details.Payment", data) } },
    "Details.Payment": {
      entry: ({ actions, enq }) => enq(actions.loadPaymentMethods),
      on: { back: ({ data, to }) => to("Details.Address", data), pay: ({ data, to }) => to("Paying", data) },
    },
    Paying: {
      meta: {
        label: "Paying…",
      },
      on: { chargeCardDone: ({ data, to }) => to("Paid", data) },
      after: {
        // The bank took too long.
        "50ms": ({ data, to }) => to("Details.Payment", data),
      },
      task: {
        run: async ({ signal }) => ({ type: "chargeCardDone", output: await chargeCard({ signal }) }),
        error: ({ data, to }) => to("Details.Payment", data),
      },
    },
    Paid: { final: true },
  },
});
