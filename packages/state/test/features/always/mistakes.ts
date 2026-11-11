// always's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in first.

import { createActor, type MachineError, setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { filling: types<{ n: number }>(), full: types<{}>() };
const events = { add: types<{}>() };

// The correct machine.
export const cartOk = setup({ use: [always], states, events }).machine({
  start: ({ to }) => to("filling", { n: 0 }),
  states: {
    filling: {
      on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) },
      always: ({ data, to }) => (data.n > 2 ? to("full") : null),
    },
    full: { final: true },
  },
});

// always without the opt-in: the machine's problem names the import.
const off = setup({ states, events }).machine({
  start: ({ to }) => to("filling", { n: 0 }),
  states: {
    filling: {
      on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) },
      always: ({ data, to }) => (data.n > 2 ? to("full") : null),
    },
    full: { final: true },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<`state "filling" has "always": add always to setup's use (import { always } from "@reactre/state/always")`>
  >
>();
// @ts-expect-error always without the opt-in: the machine can't run, and the error quotes the fix.
createActor(off);

setup({ use: [always], states, events }).machine({
  start: ({ to }) => to("filling", { n: 0 }),
  states: {
    filling: {
      on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) },
      // @ts-expect-error always returns to(...) or null: a forgotten branch's undefined is not "rest".
      always: ({ data, to }) => {
        if (data.n > 2) return to("full");
      },
    },
    full: { final: true },
  },
});

setup({ use: [always], states, events }).machine({
  start: ({ to }) => to("filling", { n: 0 }),
  states: {
    filling: {
      on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) },
      // @ts-expect-error XState's always: { target } is not a function.
      always: { target: "full" },
    },
    full: { final: true },
  },
});

// The second round's rows, by their M#.
const neverDeclines = setup({ use: [always], states, events }).machine({
  start: ({ to }) => to("filling", { n: 0 }),
  states: {
    filling: { on: { add: ({ data, to }) => to("filling", { n: data.n + 1 }) }, always: ({ to }) => to("full") },
    full: { final: true },
  },
});
expect<
  Equal<
    typeof neverDeclines,
    MachineError<`the always of "filling" never declines, so its on never runs: make it a choice, or let always return null`>
  >
>();
// @ts-expect-error M525. An always that always leaves, beside handlers that never run.
createActor(neverDeclines);
const passing = setup({
  use: [always],
  states: { checking: types<{ n: number }>(), small: types<{}>(), big: types<{}>() },
  events: { reset: types<{}>() },
}).machine({
  start: ({ to }) => to("checking", { n: 1 }),
  states: {
    checking: { always: ({ data, to }) => (data.n > 2 ? to("big") : to("small")) },
    small: { on: { reset: ({ to }) => to("checking", { n: 3 }) } },
    big: { final: true },
  },
});
const passed = createActor(passing).snapshot();
// @ts-expect-error M526. The actor is never in a state whose always always leaves: wait for its targets.
if (passed.state === "checking") passed.data;
