// wildcards's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. The opt-in first.

import { type MachineError, setup, types } from "@reactre/state";
import { wildcards } from "@reactre/state/wildcards";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { idle: types<{}>(), busy: types<{ x: number }>() };
const events = { "pointer.down": types<{ x: number }>(), "pointer.up": types<{}>(), reset: types<{}>() };

// The correct machine: "*" covers reset, "pointer.*" both pointer events.
export const canvasOk = setup({ use: [wildcards], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: { "pointer.*": ({ event, to }) => (event.type === "pointer.down" ? to("busy", { x: event.x }) : null) },
    },
    busy: { on: { "*": ({ to }) => to("idle") } },
  },
});

// A wildcard key without the opt-in.
const off = setup({ states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { "pointer.down": ({ event, to }) => to("busy", { x: event.x }), "*": ({ to }) => to("idle") } },
    busy: { on: { "pointer.up": ({ to }) => to("idle"), reset: ({ to }) => to("idle") } },
  },
});
expect<
  Equal<
    typeof off,
    MachineError<`state "idle" handles "*": add wildcards to setup's use (import { wildcards } from "@reactre/state/wildcards")`>
  >
>();

setup({ use: [wildcards], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        // @ts-expect-error A wildcard's event is the union it matches: "pointer.up" has no x.
        "pointer.*": ({ event, to }) => to("busy", { x: event.x }),
      },
    },
    busy: { on: { "*": ({ to }) => to("idle") } },
  },
});

setup({ use: [wildcards], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        // @ts-expect-error A prefix no event has: "key.*" matches nothing.
        "key.*": ({ to }) => to("busy", { x: 0 }),
      },
    },
    busy: { on: { "*": ({ to }) => to("idle") } },
  },
});

// The second round's rows, by their M#.
const saver = setup({
  use: [wildcards],
  states: { idle: types<{}>(), saving: types<{}>() },
  events: { save: types<{}>(), cancel: types<{}>() },
  internal: { stored: types<{}>() },
});
const byWildcard = saver.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { save: ({ to }) => to("saving") } },
    saving: {
      task: { run: ({ signal }) => posted(signal, "stored"), error: ({ to }) => to("idle") },
      on: { "*": ({ to }) => to("idle") },
    },
  },
});
expect<
  Equal<
    typeof byWildcard,
    MachineError<`the task's result "stored" in "saving" is handled only by a wildcard: handle it by name`>
  >
>();
// @ts-expect-error M528. A task's result caught by "*": a rename would still match it.
createActor(byWildcard);
const forms = setup({
  use: [wildcards, nested],
  states: { "form.a": types<{}>(), done: types<{}>() },
  events: { next: types<{}>(), submit: types<{}>() },
});
const shadowing = forms.machine({
  start: ({ to }) => to("form.a"),
  states: {
    form: { on: { submit: ({ to }) => to("done") } },
    "form.a": { on: { "*": ({ to }) => to("form.a") } },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof shadowing,
    MachineError<`the * of "form.a" never declines, so its parent's handlers never run: decline with null for the events it doesn't handle`>
  >
>();
// @ts-expect-error M529. A leaf's * that never declines hides its parent's handlers.
createActor(shadowing);
import { createActor } from "@reactre/state";
import { nested } from "@reactre/state/nested";

// What the tasks above call (M461: a task does its work, so none is a stub).
import { posted } from "../../fixtures/service.ts";
