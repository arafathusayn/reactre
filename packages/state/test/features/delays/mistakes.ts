// delays's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in cases first.

import { createActor, type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { delays } from "@reactre/state/delays";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const plain = setup({
  states: { idle: types<{}>(), waiting: types<{ ms: number }>() },
  events: { go: types<{ ms: number }>() },
});
const iso = plain.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ event, to }) => to("waiting", { ms: event.ms }) } },
    waiting: { after: { PT1M30S: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof iso,
    MachineError<`state "waiting" has a timer "PT1M30S": an ISO 8601 duration needs delays: add delays to setup's use (import { delays } from "@reactre/state/delays")`>
  >
>();
// @ts-expect-error The opt-in: an ISO duration in after without delays names the import.
createActor(iso);

// @ts-expect-error The opt-in: setup's delays without delays in use.
setup({ delays: { retry: "2s" }, states: { idle: types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{ delays: { retry: "2s" }; states: { idle: Type<{}> }; events: {} }>,
    `setup has "delays": add delays to setup's use (import { delays } from "@reactre/state/delays")`
  >
>();

const timed = setup({
  use: [delays],
  delays: { retry: "PT2S", sla: ({ data }: { data: { ms: number } }) => data.ms },
  states: { idle: types<{}>(), waiting: types<{ ms: number }>() },
  events: { go: types<{ ms: number }>() },
});

// The correct machine: an ISO duration, a named delay, and one from the data.
export const timedOk = timed.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: { go: ({ event, to }) => to("waiting", { ms: event.ms }) },
      after: { retry: ({ to }) => to("waiting", { ms: 1 }) },
    },
    waiting: { after: { P1DT12H: ({ to }) => to("idle"), sla: ({ to }) => to("idle") } },
  },
});
createActor(timedOk);

const wrong = timed.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: { go: ({ event, to }) => to("waiting", { ms: event.ms }) },
      // A year or a month has no fixed length; a delay reading data idle lacks.
      after: { P1Y: ({ to }) => to("waiting", { ms: 1 }), sla: ({ to }) => to("waiting", { ms: 1 }) },
    },
    waiting: { after: { retry: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof wrong,
    MachineError<
      | `state "idle" has a timer "P1Y", which is neither a duration nor one of setup's delays: an ISO 8601 duration here takes weeks, days, hours, minutes and seconds ("PT1M30S", "P1D", "P1DT12H"); a year or a month has no fixed length: write days, or add it to setup's delays`
      | `state "idle" uses delay "sla", whose argument's type its data doesn't have: give the delay's argument a type every state using it has`
    >
  >
>();
// @ts-expect-error An ISO year, and a delay function reading data its state lacks.
createActor(wrong);

timed.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: { go: ({ event, to }) => to("waiting", { ms: event.ms }) },
      // @ts-expect-error A misspelled delay: not a key after takes.
      after: { rtery: ({ to }) => to("waiting", { ms: 1 }) },
    },
    waiting: { after: { retry: ({ to }) => to("idle") } },
  },
});

// @ts-expect-error A delay in setup that isn't a duration.
setup({ use: [delays], delays: { retry: "2 sec" }, states: { idle: types<{}>() }, events: {} });

// The catalog's rows (../../../compare/MISTAKES.md), by their M#.
// @ts-expect-error M95. A delay named like a duration: after: { "5s" } can't tell them apart.
setup({ use: [delays], delays: { "5s": 1000 }, states: { idle: types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly [typeof delays]; delays: { "5s": 1000 }; states: { idle: Type<{}> }; events: {} }>,
    `delay "5s" is named like a duration, so after: { "5s": ... } reads as one: name it for what it waits for ("debounce", "retry")`
  >
>();

// The second round's rows, by their M#: with delays in use, a duration is still digits and a unit.
const loose = timed.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: { go: ({ event, to }) => to("waiting", { ms: event.ms }) },
      after: { "-5s": ({ to }) => to("waiting", { ms: 1 }), "1e3ms": ({ to }) => to("waiting", { ms: 1 }) },
    },
    waiting: {
      after: { " 5s": ({ to }) => to("idle"), ".5s": ({ to }) => to("idle"), "0x10s": ({ to }) => to("idle") },
    },
  },
});
expect<
  Equal<
    typeof loose,
    MachineError<
      | `state "idle"'s timer is "-5s", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
      | `state "idle"'s timer is "1e3ms", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
      | `state "waiting"'s timer is " 5s", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
      | `state "waiting"'s timer is ".5s", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
      | `state "waiting"'s timer is "0x10s", which isn't digits and a unit: write it as "5s", "1000ms" or "0.5s"`
    >
  >
>();
// @ts-expect-error M479. A sign, an exponent, a space, no leading digit, hex: each compiles to no timer.
createActor(loose);
