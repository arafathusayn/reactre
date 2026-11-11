// route's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in first.

import { createActor, type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { route } from "@reactre/state/route";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { home: types<{}>(), settings: types<{ tab: string }>() };
const events = { open: types<{}>() };

// The correct machine: "settings" is reached only by its route.
export const appOk = setup({ use: [route], states, events }).machine({
  start: ({ to }) => to("home"),
  states: {
    home: { on: { open: ({ to }) => to("home") } },
    settings: { route: ({ to }) => to("settings", { tab: "main" }), on: { open: ({ to }) => to("home") } },
  },
});
const app = createActor(appOk);
app.send({ type: "route", to: "settings" });
// @ts-expect-error a route only to a node that takes one: "home" has no route.
app.send({ type: "route", to: "home" });

// route without the opt-in.
const off = setup({ states, events }).machine({
  start: ({ to }) => to("home"),
  states: {
    home: { on: { open: ({ to }) => to("settings", { tab: "main" }) } },
    settings: { route: ({ to }) => to("settings", { tab: "main" }), on: { open: ({ to }) => to("home") } },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<`state "settings" has "route": add route to setup's use (import { route } from "@reactre/state/route")`>
  >
>();

setup({ use: [route], states, events }).machine({
  start: ({ to }) => to("home"),
  states: {
    home: { on: { open: ({ to }) => to("home") } },
    // @ts-expect-error a route goes into its own node: here, settings.
    settings: { route: ({ to }) => to("home"), on: { open: ({ to }) => to("home") } },
  },
});

// An event named "route" beside the opt-in.
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof route];
      states: { home: Type<{}> };
      events: { route: Type<{ to: string }> };
    }>,
    `event "route" is the route feature's ({ type: "route", to }): rename yours`
  >
>();
