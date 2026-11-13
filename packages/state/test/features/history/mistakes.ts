// history's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. Case 44, and the opt-in, 60.

import { setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { history } from "@reactre/state/history";
import { nested } from "@reactre/state/nested";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

const states = { idle: types<{}>(), "edit.draft": types<{ text: string }>(), away: types<{}>() };
const events = { open: types<{}>(), leave: types<{}>(), resume: types<{}>() };

// The correct machine: `back` returns to the leaf "edit" held when it was left.
export const editorOk = setup({ use: [nested, history], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("away") } },
    "edit.draft": {},
    away: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })) } },
  },
});

setup({ use: [nested, history], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("away") } },
    "edit.draft": {},
    // @ts-expect-error 44. back to a leaf: back goes to a parent's last leaf.
    away: { on: { resume: ({ back, to }) => back("idle", to("idle")) } },
  },
});

setup({ use: [nested], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("away") } },
    "edit.draft": {},
    // @ts-expect-error 60. back without history in use: its only parameter is the fix, naming the import.
    away: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })) } },
  },
});

// 60. history needs nested: a parent to go back to.
expect<
  Equal<
    keyof ShapeCheck<{ use: readonly [typeof history]; states: { idle: Type<{}> }; events: {} }>,
    `history needs nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`
  >
>();

// Shallow history: a step for each direct child of the parent that is a parent.
const form = setup({
  use: [nested, history],
  states: {
    idle: types<{}>(),
    "form.details.name": types<{}>(),
    "form.details.email": types<{}>(),
    "form.review": types<{}>(),
  },
  events: { open: types<{}>(), leave: types<{}>(), resume: types<{}>() },
});
form.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        open: ({ to }) => to("form.details.name"),
        resume: ({ back, to }) =>
          // @ts-expect-error A shallow step for a leaf child: only a child that is a parent takes one.
          back("form", to("form.details.name"), { review: to("form.review") }),
      },
    },
    form: { on: { leave: ({ to }) => to("idle") } },
    "form.details.name": {},
    "form.details.email": {},
    "form.review": {},
  },
});
form.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: {
      on: {
        open: ({ to }) => to("form.details.name"),
        resume: ({ back, to }) =>
          // @ts-expect-error A child's shallow step goes into that child: "details" steps to a leaf under it.
          back("form", to("form.details.name"), { details: to("form.review") }),
      },
    },
    form: { on: { leave: ({ to }) => to("idle") } },
    "form.details.name": {},
    "form.details.email": {},
    "form.review": {},
  },
});

// The catalog's rows (../../../compare/MISTAKES.md), by their M#.
setup({ use: [nested, history], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("away") } },
    "edit.draft": {},
    // @ts-expect-error M173. back without its fallback, for a parent never entered (XState's E60).
    away: { on: { resume: ({ back }) => back("edit") } },
  },
});

// The second round's rows, by their M#.
setup({ use: [nested, history], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("away") } },
    "edit.draft": {
      on: {
        // @ts-expect-error M520. back to the parent of the leaf it is in: it goes nowhere new, keep stays.
        resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })),
      },
    },
    away: { on: { resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" })) } },
  },
});
setup({ use: [nested, history], states, events }).machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { on: { leave: ({ to }) => to("away") } },
    "edit.draft": {},
    // @ts-expect-error M521. back's fallback outside the parent: go there with to(...).
    away: { on: { resume: ({ back, to }) => back("edit", to("idle")) } },
  },
});
