// What provide costs an app that uses it (with effects, which runs its actions): named actions and
// a guard, and `provide(machine, ...)` swapping an action, as a test would.

import { createActor, setup, types } from "@reactre/state";
import { effects } from "@reactre/state/effects";
import { provide } from "@reactre/state/provide";

const seen: string[] = [];

const order = setup({
  use: [effects, provide],
  actions: { track: (params: { key: string }) => seen.push(params.key), reset: () => seen.push("reset") },
  guards: { big: (total: number) => total > 100 },
  states: { cart: types<{ total: number }>(), review: types<{ total: number }>() },
  events: { submit: types<{}>(), back: types<{}>() },
});

export const orderMachine = order.machine({
  start: ({ to }) => to("cart", { total: 150 }),
  states: {
    cart: {
      on: {
        submit: ({ data, actions, guards, enq, to }) => {
          if (!guards.big(data.total)) return null;
          enq(actions.track, { key: "big" });
          return to("review", { total: data.total });
        },
      },
    },
    review: {
      entry: ({ actions, enq }) => enq(actions.reset),
      on: { back: ({ data, to }) => to("cart", { total: data.total }) },
    },
  },
});

export function run(): string[] {
  const actor = createActor(provide(orderMachine, { actions: { track: (params) => seen.push(`spy ${params.key}`) } }));
  actor.send({ type: "submit" });
  actor.send({ type: "back" });
  actor.stop();
  return seen;
}
