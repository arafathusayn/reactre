// reenter's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. The opt-in first.

import { createActor, type MachineError, setup, types } from "@reactre/state";
import { reenter } from "@reactre/state/reenter";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { loading: types<{ attempt: number }>(), failed: types<{}>() };
const events = { retry: types<{}>(), fail: types<{}>() };

// The correct machine.
export const fetcherOk = setup({ use: [reenter], states, events }).machine({
  start: ({ to }) => to("loading", { attempt: 1 }),
  states: {
    loading: {
      on: {
        retry: ({ data, reenter }) => reenter("loading", { attempt: data.attempt + 1 }),
        fail: ({ to }) => to("failed"),
      },
    },
    failed: { final: true },
  },
});

setup({ states, events }).machine({
  start: ({ to }) => to("loading", { attempt: 1 }),
  states: {
    loading: {
      on: {
        // @ts-expect-error reenter without the opt-in: its only parameter is the fix, naming the import.
        retry: ({ data, reenter }) => reenter("loading", { attempt: data.attempt + 1 }),
        fail: ({ to }) => to("failed"),
      },
    },
    failed: { final: true },
  },
});

setup({ use: [reenter], states, events }).machine({
  start: ({ to }) => to("loading", { attempt: 1 }),
  states: {
    loading: {
      on: {
        // @ts-expect-error reenter takes the leaf's data, as to does.
        retry: ({ reenter }) => reenter("loading", {}),
        fail: ({ to }) => to("failed"),
      },
    },
    failed: { final: true },
  },
});

// The catalog's rows (../../../compare/MISTAKES.md), by their M#.
const search = setup({
  use: [reenter],
  states: { idle: types<{}>(), loading: types<{ q: string }>(), failed: types<{}>() },
  events: { type: types<{ q: string }>() },
  internal: { found: types<{}>() },
});
setup({ use: [reenter], states, events }).machine({
  start: ({ to }) => to("loading", { attempt: 1 }),
  states: {
    loading: {
      on: {
        retry: ({ data, reenter }) => reenter("loading", { attempt: data.attempt + 1 }),
        // @ts-expect-error M196. reenter to a sibling: reenter restarts the state the handler runs in; another is to's.
        fail: ({ reenter }) => reenter("failed"),
      },
    },
    failed: { final: true },
  },
});
// The stay, with reenter in use: the problem names both moves, and no import.
const stays = search.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
    loading: {
      task: { run: ({ signal }) => posted(signal, "found"), error: ({ to }) => to("failed") },
      on: { type: ({ event, to }) => to("loading", { q: event.q }), found: ({ to }) => to("idle") },
    },
    failed: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
  },
});
expect<
  Equal<
    typeof stays,
    MachineError<`state "loading" goes to itself with to(...), and its task keeps running with the data it started with: write reenter("loading", ...) to restart it with the new data, or keep("loading", data), with the data it started with, to leave it running`>
  >
>();
// @ts-expect-error M87. The typeahead's stay, with reenter in use.
createActor(stays);
// The typeahead, right: each query restarts the task, whose old result is dropped.
export const typeaheadOk = search.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
    loading: {
      task: { run: ({ signal }) => posted(signal, "found"), error: ({ to }) => to("failed") },
      on: { type: ({ event, reenter }) => reenter("loading", { q: event.q }), found: ({ to }) => to("idle") },
    },
    failed: { on: { type: ({ event, to }) => to("loading", { q: event.q }) } },
  },
});
createActor(typeaheadOk);

// The second round's rows, by their M#.
const saver = setup({
  use: [reenter],
  states: { idle: types<{}>(), saving: types<{ text: string }>(), done: types<{}>() },
  events: { save: types<{ text: string }>(), cancel: types<{}>() },
  internal: { stored: types<{}>() },
});
const forever = saver.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ event, to }) => to("saving", { text: event.text }) } },
    saving: {
      task: { run: ({ signal }) => posted(signal, "stored"), error: ({ data, reenter }) => reenter("saving", data) },
      on: { stored: ({ to }) => to("done"), cancel: ({ to }) => to("idle") },
    },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof forever,
    MachineError<`error in "saving" only reenters "saving", which retries at once and forever: go to a failed state with after, the attempt in its data`>
  >
>();
// @ts-expect-error M475. A task's error that only reenters: a retry loop with no wait and no end.
createActor(forever);

// What the tasks above call (M461: a task does its work, so none is a stub).
import { posted } from "../../fixtures/service.ts";
