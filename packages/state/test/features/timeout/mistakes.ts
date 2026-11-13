// timeout's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. The opt-in case first.

import { createActor, type MachineError, setup, types } from "@reactre/state";
import { timeout } from "@reactre/state/timeout";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const plain = setup({
  states: { waiting: types<{ ms: number }>(), late: types<{}>() },
  events: { answer: types<{}>() },
});
const off = plain.machine({
  start: ({ to }) => to("waiting", { ms: 1 }),
  states: {
    waiting: { timeout: "5s", onTimeout: ({ to }) => to("late"), on: { answer: ({ to }) => to("late") } },
    late: { final: true },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<
      | `state "waiting" has "timeout": add timeout to setup's use (import { timeout } from "@reactre/state/timeout")`
      | `state "waiting" has "onTimeout": add timeout to setup's use (import { timeout } from "@reactre/state/timeout")`
    >
  >
>();
// @ts-expect-error The opt-in: timeout (and onTimeout) without timeout in use names the import.
createActor(off);

const sla = setup({
  use: [timeout],
  states: { waiting: types<{ ms: number }>(), late: types<{}>(), done: types<{}>() },
  events: { answer: types<{}>() },
});

// The correct machine: a duration, and a deadline from the data.
export const slaOk = sla.machine({
  start: ({ to }) => to("waiting", { ms: 1 }),
  states: {
    waiting: {
      timeout: ({ data }) => data.ms,
      onTimeout: ({ to }) => to("late"),
      on: { answer: ({ to }) => to("done") },
    },
    late: { timeout: "PT0S" as "5s", onTimeout: ({ to }) => to("done") },
    done: { final: true },
  },
});
createActor(slaOk);

const halves = sla.machine({
  start: ({ to }) => to("waiting", { ms: 1 }),
  states: {
    waiting: { timeout: "5s", on: { answer: ({ to }) => to("late") } },
    late: { onTimeout: ({ to }) => to("done") },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof halves,
    MachineError<
      | `state "waiting" has a timeout and no onTimeout: add onTimeout: ({ to }) => to(...), where to go when it expires`
      | `state "late" has onTimeout and no timeout: add timeout: "30s" (or milliseconds), when it expires`
    >
  >
>();
// @ts-expect-error A timeout without onTimeout, and onTimeout without a timeout.
createActor(halves);

const iso = sla.machine({
  start: ({ to }) => to("waiting", { ms: 1 }),
  states: {
    waiting: { timeout: "PT1M", onTimeout: ({ to }) => to("late"), on: { answer: ({ to }) => to("done") } },
    late: { timeout: 10, onTimeout: ({ to }) => to("done") },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof iso,
    MachineError<`state "waiting"'s timeout is "PT1M": an ISO 8601 duration needs delays: add delays to setup's use (import { delays } from "@reactre/state/delays")`>
  >
>();
// @ts-expect-error An ISO 8601 timeout without delays names the import.
createActor(iso);

sla.machine({
  start: ({ to }) => to("waiting", { ms: 1 }),
  states: {
    // @ts-expect-error A timeout that isn't a duration.
    waiting: { timeout: "5 sec", onTimeout: ({ to }) => to("late"), on: { answer: ({ to }) => to("done") } },
    late: { final: true },
    done: { final: true },
  },
});

sla.machine({
  start: ({ to }) => to("waiting", { ms: 1 }),
  states: {
    waiting: {
      // @ts-expect-error A deadline from data the state doesn't have.
      timeout: ({ data }) => data.seconds,
      onTimeout: ({ to }) => to("late"),
      on: { answer: ({ to }) => to("done") },
    },
    late: { final: true },
    done: { final: true },
  },
});
