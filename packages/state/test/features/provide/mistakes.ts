// provide's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. The opt-in cases first.

import { createActor, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { delays } from "@reactre/state/delays";
import { effects } from "@reactre/state/effects";
import { provide } from "@reactre/state/provide";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

type Track = (params: { key: string }) => void;

// @ts-expect-error The opt-in: setup's actions without provide in use names the import.
setup({
  use: [effects],
  actions: { track: (params: { key: string }) => params },
  states: { a: types<{}>() },
  events: {},
});
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof effects];
      actions: { track: Track };
      states: { a: Type<{}> };
      events: {};
    }>,
    `setup has "actions": add provide to setup's use (import { provide } from "@reactre/state/provide")`
  >
>();

// @ts-expect-error Named actions run as effects: they need effects.
setup({
  use: [provide],
  actions: { track: (params: { key: string }) => params },
  states: { a: types<{}>() },
  events: {},
});
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof provide];
      actions: { track: Track };
      states: { a: Type<{}> };
      events: {};
    }>,
    `setup has actions, which run as effects (enq(actions.track, params)): add effects to setup's use (import { effects } from "@reactre/state/effects")`
  >
>();

const order = setup({
  use: [effects, provide, delays],
  actions: { track: (params: { key: string }) => params.key, reset: () => {} },
  guards: { big: (total: number) => total > 100 },
  delays: { retry: "2s" },
  states: { cart: types<{ total: number }>(), review: types<{ total: number }>() },
  events: { submit: types<{}>(), back: types<{}>() },
});

// The correct machine.
export const orderOk = order.machine({
  start: ({ to }) => to("cart", { total: 0 }),
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
      on: { back: ({ data, to }) => to("cart", data) },
      after: { retry: ({ data, to }) => to("cart", data) },
    },
  },
});
createActor(orderOk);
provide(orderOk, { actions: { track: (params) => params.key }, delays: { retry: 0 } });

order.machine({
  start: ({ to }) => to("cart", { total: 0 }),
  states: {
    cart: {
      on: {
        submit: ({ data, actions, guards, enq, to }) => {
          // @ts-expect-error A named action without its params.
          enq(actions.track);
          // @ts-expect-error A named action with params it doesn't take.
          enq(actions.track, { id: 1 });
          // @ts-expect-error A named action called: it is an effect, so enqueue it.
          actions.track({ key: "big" });
          // @ts-expect-error A named action setup doesn't declare.
          enq(actions.notify);
          // @ts-expect-error A guard given what it doesn't take.
          return guards.big("many") ? to("review", { total: data.total }) : null;
        },
      },
    },
    review: { on: { back: ({ data, to }) => to("cart", data) } },
  },
});

// @ts-expect-error provide: an action with other params than setup's.
provide(orderOk, { actions: { track: (params: number) => params } });
// @ts-expect-error provide: a delay setup doesn't declare.
provide(orderOk, { delays: { retyr: 0 } });

const plain = setup({ use: [effects], states: { a: types<{}>() }, events: { go: types<{}>() } });
const plainMachine = plain.machine({ start: ({ to }) => to("a"), states: { a: { on: { go: ({ to }) => to("a") } } } });
// @ts-expect-error The opt-in: provide(machine, ...) on a machine without provide names the import.
provide(plainMachine, {});
