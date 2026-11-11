// durable's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. The opt-in, 64.

import { type NeedsOptIn, setup, type Type, types } from "@reactre/state";
import { durable, type Host } from "@reactre/state/durable";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { idle: types<{}>(), done: types<{}>() };
const events = { go: types<{}>() };
declare const host: Host<{ states: typeof states; events: typeof events }>;

// The correct machine: with durable in use, a journaling host runs it.
export const journaled = setup({ use: [durable], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: { idle: { on: { go: ({ to }) => to("done") } }, done: { final: true } },
});
durable(journaled, host);

const plain = setup({ states, events }).machine({
  start: ({ to }) => to("idle"),
  states: { idle: { on: { go: ({ to }) => to("done") } }, done: { final: true } },
});
// @ts-expect-error 64. durable(machine, host) without durable in use: the error names the import.
durable(plain, host);
expect<
  Equal<
    NeedsOptIn<{ states: { idle: Type<{}> }; events: {} }, "durable", "durable(machine, host)">,
    {
      readonly 'durable(machine, host) needs durable: add durable to setup\'s use (import { durable } from "@reactre/state/durable")': never;
    }
  >
>();

// The second round's rows, by their M#.
// @ts-expect-error M555. durable with effects: a replayed handler would run its effect again.
setup({ use: [durable, effects], states, events });
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly [typeof durable, typeof effects]; states: typeof states; events: typeof events }>,
    "use lists durable and effects: a durable run replays its handlers, so an effect would run again; make the work a task"
  >
>();
const feed = setup({ states: { live: types<{}>(), over: types<{}>() }, events: { end: types<{}>() } }).machine({
  start: ({ to }) => to("live"),
  states: { live: { on: { end: ({ to }) => to("over") } }, over: { final: true } },
});
const updates = setup({ use: [durable, children], states, events, children: { feed } }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      children: { feed: { done: ({ to }) => to("done"), update: () => null } },
      on: { go: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof updates,
    MachineError<`state "idle"'s child "feed" has update, which a durable run can't replay: send the child's events to the parent with sendBack, and handle them in on`>
  >
>();
// @ts-expect-error M556. A child's update on a durable machine: the host doesn't run it.
durable(updates, host as never);
const run = durable(journaled, host);
// @ts-expect-error M558. A snapshot typed any (JSON.parse): migrate it first, or type it.
run.resume(JSON.parse("{}"));
import type { MachineError, ShapeCheck } from "@reactre/state";
import { children } from "@reactre/state/children";
import { effects } from "@reactre/state/effects";
