// output's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in first.

import { type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";
import { output } from "@reactre/state/output";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = {
  idle: types<{}>(),
  "job.busy": types<{}>(),
  "job.ok": types<{ id: string }>(),
  done: types<{ id: string }>(),
};
const events = { go: types<{}>(), ok: types<{ id: string }>() };

// The correct machine: "job" completes when its leaf is final, with that leaf's data.
export const jobOk = setup({ use: [nested, output], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("job.busy") } },
    job: { done: ({ state, data, to }) => to("done", { id: state === "job.ok" ? data.id : "" }) },
    "job.busy": { on: { ok: ({ event, to }) => to("job.ok", { id: event.id }) } },
    "job.ok": { final: true },
    done: { final: true },
  },
});

// A parent's done without the opt-in.
const off = setup({ use: [nested], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("job.busy") } },
    job: { done: ({ to }) => to("done", { id: "" }) },
    "job.busy": { on: { ok: ({ event, to }) => to("job.ok", { id: event.id }) } },
    "job.ok": { final: true },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<`state "job" has "done": add output to setup's use (import { output } from "@reactre/state/output")`>
  >
>();

// output needs nested: a parent to complete.
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly [typeof output]; states: { idle: Type<{}> }; events: {} }>,
    `output needs nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`
  >
>();

// A done no final leaf ever runs.
const never = setup({ use: [nested, output], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("job.busy") } },
    job: { done: ({ to }) => to("done", { id: "" }) },
    "job.busy": { on: { ok: ({ event, to }) => to("job.ok", { id: event.id }) } },
    "job.ok": { on: { go: ({ data, to }) => to("done", { id: data.id }) } },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof never,
    MachineError<`parent "job" has done, but no leaf under it is final: mark the leaf it ends in { final: true }, or remove done`>
  >
>();
