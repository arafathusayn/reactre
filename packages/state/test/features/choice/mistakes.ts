// choice's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in first.

import { createActor, type MachineError, setup, types } from "@reactre/state";
import { choice } from "@reactre/state/choice";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { idle: types<{}>(), routing: types<{ vip: boolean }>(), vip: types<{}>(), standard: types<{}>() };
const events = { go: types<{ vip: boolean }>(), back: types<{}>() };

// The correct machine.
export const orderOk = setup({ use: [choice], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ event, to }) => to("routing", { vip: event.vip }) } },
    routing: { choice: ({ data, to }) => (data.vip ? to("vip") : to("standard")) },
    vip: { on: { back: ({ to }) => to("idle") } },
    standard: { on: { back: ({ to }) => to("idle") } },
  },
});

// choice without the opt-in.
const off = setup({ states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ event, to }) => to("routing", { vip: event.vip }) } },
    routing: { choice: ({ data, to }) => (data.vip ? to("vip") : to("standard")) },
    vip: { on: { back: ({ to }) => to("idle") } },
    standard: { on: { back: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<`state "routing" has "choice": add choice to setup's use (import { choice } from "@reactre/state/choice")`>
  >
>();

setup({ use: [choice], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ event, to }) => to("routing", { vip: event.vip }) } },
    // @ts-expect-error a choice must resolve: null isn't a target (XState throws at entry instead).
    routing: { choice: ({ data, to }) => (data.vip ? to("vip") : null) },
    vip: { on: { back: ({ to }) => to("idle") } },
    standard: { on: { back: ({ to }) => to("idle") } },
  },
});

// A choice with handlers of its own: it never rests, so they'd never run.
const resting = setup({ use: [choice], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ event, to }) => to("routing", { vip: event.vip }) } },
    routing: {
      choice: ({ data, to }) => (data.vip ? to("vip") : to("standard")),
      on: { back: ({ to }) => to("idle") },
    },
    vip: { on: { back: ({ to }) => to("idle") } },
    standard: { on: { back: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof resting,
    MachineError<`state "routing" is a choice: it only decides where to go, so it takes no "on". Put that on the states it goes to`>
  >
>();

// The machine never rests in a choice: a snapshot is never in one.
const s = createActor(orderOk).snapshot();
// @ts-expect-error "routing" is not a state a snapshot can be in.
if (s.state === "routing") s.data.vip;
