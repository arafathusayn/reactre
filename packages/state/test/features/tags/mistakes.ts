// tags's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in first.

import { initial, type MachineError, setup, types } from "@reactre/state";
import { tags } from "@reactre/state/tags";
import { getMeta, hasTag } from "@reactre/state/utils";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { idle: types<{}>(), busy: types<{}>() };
const events = { go: types<{}>(), stop: types<{}>() };

// The correct machine.
export const jobOk = setup({ use: [tags], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { description: "Waiting", on: { go: ({ to }) => to("busy") } },
    busy: { tags: ["busy"], meta: { label: "Working" }, on: { stop: ({ to }) => to("idle") } },
  },
});
hasTag(jobOk, initial(jobOk, undefined), "busy");
const label: string | undefined = getMeta(jobOk, initial(jobOk, undefined)).busy?.label;
void label;
// @ts-expect-error A tag no node has: hasTag takes the tags the machine writes.
hasTag(jobOk, initial(jobOk, undefined), "bussy");

// tags without the opt-in.
const off = setup({ states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy") } },
    busy: { tags: ["busy"], on: { stop: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<`state "busy" has "tags": add tags to setup's use (import { tags } from "@reactre/state/tags")`>
  >
>();

// A final state's tags without the opt-in: the same error.
const offFinal = setup({ states, events: { go: types<{}>() } }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy") } },
    busy: { final: true, tags: ["done"] },
  },
});
expect<
  Equal<
    typeof offFinal,
    MachineError<`state "busy" has "tags": add tags to setup's use (import { tags } from "@reactre/state/tags")`>
  >
>();

// hasTag on a machine without tags: the error names the import.
const plain = setup({ states, events }).machine({
  start: ({ to }) => to("idle"),
  states: { idle: { on: { go: ({ to }) => to("busy") } }, busy: { on: { stop: ({ to }) => to("idle") } } },
});
// @ts-expect-error hasTag needs tags in use.
hasTag(plain, initial(plain, undefined), "busy");

setup({ use: [tags], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { go: ({ to }) => to("busy") } },
    // @ts-expect-error meta is JSON: a function isn't.
    busy: { meta: { at: () => 1 }, on: { stop: ({ to }) => to("idle") } },
  },
});
