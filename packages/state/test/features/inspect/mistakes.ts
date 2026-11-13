// inspect's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says.

import { createActor, type Machine, setup, types } from "@reactre/state";
import { inspect, type InspectionEvent } from "@reactre/state/inspect";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const off = setup({ states: { idle: types<{}>() }, events: { go: types<{}>() } });
const offMachine = off.machine({
  start: ({ to }) => to("idle"),
  states: { idle: { on: { go: ({ to }) => to("idle") } } },
});

// Opt-in: without `use: [inspect]`, each option's type is the fix.
type OffInspect = NonNullable<
  Parameters<typeof createActor<typeof offMachine extends Machine<infer D> ? D : never>>[1]
>;
expect<
  Equal<
    Exclude<keyof NonNullable<OffInspect["inspect"]>, keyof Function>,
    `inspect needs inspect: add inspect to setup's use (import { inspect } from "@reactre/state/inspect")`
  >
>();
// @ts-expect-error Property '"inspect needs inspect: add inspect to setup's use (…)"' is missing.
createActor(offMachine, { inspect: () => {} });
// @ts-expect-error Property '"logger needs inspect: add inspect to setup's use (…)"' is missing.
createActor(offMachine, { logger: console.log });

const on = setup({ use: [inspect], states: { idle: types<{}>() }, events: { go: types<{}>() } });
const onMachine = on.machine({
  start: ({ to }) => to("idle"),
  states: { idle: { on: { go: ({ to }) => to("idle") } } },
});
createActor(onMachine, { inspect: (e: InspectionEvent) => e.id, logger: console.log, id: "app" });

// An inspection event narrows by its type.
createActor(onMachine, {
  inspect: (e) => {
    // @ts-expect-error Only an "event" inspection event has the event.
    e.event;
    if (e.type === "event") e.event.type;
  },
});
// @ts-expect-error A logger takes a line, not the inspection event.
createActor(onMachine, { logger: (e: InspectionEvent) => e });
