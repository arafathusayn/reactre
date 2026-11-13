// What system costs an app that uses it: an order whose payment child is registered in a system,
// and reached from the app by its key.

import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createSystem, system } from "@reactre/state/system";

const payment = setup({
  states: { pending: types<{}>(), paid: types<{}>() },
  events: { approve: types<{}>() },
});
export const paymentMachine = payment.machine({
  start: ({ to }) => to("pending"),
  states: { pending: { on: { approve: ({ to }) => to("paid") } }, paid: { final: true } },
});

const order = setup({
  use: [children, system],
  states: { cart: types<{}>(), paying: types<{}>(), placed: types<{}>() },
  events: { checkout: types<{}>() },
  children: { payment: paymentMachine },
});
export const orderMachine = order.machine({
  start: ({ to }) => to("cart"),
  states: {
    cart: { on: { checkout: ({ to }) => to("paying") } },
    paying: { children: { payment: { registryKey: "payment", done: ({ to }) => to("placed") } } },
    placed: { final: true },
  },
});

export function run(): string {
  const sys = createSystem({ registry: { payment: paymentMachine } });
  const actor = sys.createActor(orderMachine);
  actor.send({ type: "checkout" });
  sys.get("payment")?.send({ type: "approve" });
  return actor.snapshot().state;
}
