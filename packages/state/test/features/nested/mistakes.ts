// nested's mistakes, each a type error (`bun check` fails if one stops being one); ../../explain.ts
// prints what each says. Cases 40–46 (44 is history's) and the opt-in, 58.

import { createActor, type MachineError, setup, type ShapeCheck, type Type, types } from "@reactre/state";
import { nested } from "@reactre/state/nested";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

// @ts-expect-error 58. Dotted states without nested in use: the error names the import.
setup({ states: { idle: types<{}>(), "edit.draft": types<{}>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{ states: { idle: Type<{}>; "edit.draft": Type<{}> }; events: {} }>,
    `state "edit.draft" is nested: add nested to setup's use (import { nested } from "@reactre/state/nested")`
  >
>();

// "edit" is the parent of two leaves.
const editor = setup({
  use: [nested],
  states: {
    idle: types<{}>(),
    "edit.draft": types<{ text: string }>(),
    "edit.review": types<{ text: string; by: string }>(),
    sent: types<{ text: string }>(),
  },
  events: { open: types<{}>(), submit: types<{ by: string }>(), approve: types<{}>(), cancel: types<{}>() },
});

// The correct machine: a leaf with no handlers of its own leaves through its parent's, and an event
// only the parent handles counts as handled.
export const editorOk = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: {
      on: {
        cancel: ({ state, data, to }) => (state === "edit.review" ? to("edit.draft", { text: data.text }) : to("idle")),
      },
    },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": { on: { approve: ({ data, to }) => to("sent", { text: data.text }) } },
    sent: { final: true },
  },
});
const editorActor = createActor(editorOk);

// @ts-expect-error 40. A state that is also a parent: a parent has no data.
setup({ use: [nested], states: { edit: types<{}>(), "edit.draft": types<{}>() }, events: {} });

editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    // @ts-expect-error 41. A parent as a target: say which leaf, with its data.
    idle: { on: { open: ({ to }) => to("edit") } },
    edit: {
      on: {
        // @ts-expect-error 42. A parent's data read before narrowing: only "edit.review" has `by`.
        cancel: ({ data, to }) => to("sent", { text: data.by }),
        // @ts-expect-error 43. A parent's data spread into another leaf: "edit.review"'s `by` would come along.
        approve: ({ data, to }) => to("sent", { ...data }),
      },
    },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": { on: { approve: ({ data, to }) => to("sent", { text: data.text }) } },
    sent: { final: true },
  },
});

// 45–46. A key that is neither a leaf nor a parent, and a parent marked final.
const misnested = editor.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { open: ({ to }) => to("edit.draft", { text: "" }) } },
    edit: { final: true },
    // @ts-expect-error 45. A key the shape lacks: its handler's `to` is implicitly any, here.
    edt: { on: { cancel: ({ to }) => to("idle") } },
    "edit.draft": { on: { submit: ({ data, event, to }) => to("edit.review", { text: data.text, by: event.by }) } },
    "edit.review": { on: { approve: ({ data, to }) => to("sent", { text: data.text }) } },
    sent: { final: true },
  },
});
expect<
  Equal<
    typeof misnested,
    MachineError<
      | 'state "edt" is not in the shape: add it to setup\'s states, or remove it'
      | 'state "edit" is a parent, and only leaves are final: mark the leaves it ends in { final: true }'
    >
  >
>();
// @ts-expect-error 45–46. Using the machine quotes both.
createActor(misnested);

// The catalog's rows (../../../compare/MISTAKES.md), by their M#, with the helper's import.
import { matches } from "@reactre/state/utils";

matches(editorActor.snapshot(), "edit");
// @ts-expect-error M184. A misspelled state in matches.
matches(editorActor.snapshot(), "edt");

// @ts-expect-error M41. A flag repeating a parent: under "edit", isEdit is always true.
setup({ use: [nested], states: { idle: types<{}>(), "edit.draft": types<{ isEdit: boolean }>() }, events: {} });
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof nested];
      states: { idle: Type<{}>; "edit.draft": Type<{ isEdit: boolean }> };
      events: {};
    }>,
    `state "edit.draft" has "isEdit", a flag that repeats its parent "edit": the state is the flag. Remove the field, and read isIn(snapshot, "edit")`
  >
>();

// The second round's rows, by their M#.
const jobs = setup({
  use: [nested],
  states: { idle: types<{}>(), "job.upload": types<{}>(), done: types<{}>() },
  events: { start: types<{}>(), cancel: types<{}>() },
  internal: { finished: types<{}>() },
});
const twice = jobs.machine({
  start: ({ to }) => to("idle"),
  states: {
    idle: { on: { start: ({ to }) => to("job.upload") } },
    job: {
      task: { run: ({ signal }) => posted(signal, "finished"), error: ({ to }) => to("idle") },
      on: { finished: ({ to }) => to("done"), cancel: ({ to }) => to("idle") },
    },
    "job.upload": { task: { run: ({ signal }) => posted(signal, "finished"), error: ({ to }) => to("idle") } },
    done: { final: true },
  },
});
expect<
  Equal<
    typeof twice,
    MachineError<`the tasks of "job" and "job.upload" both resolve to "finished", and run together: give each its own event`>
  >
>();
// @ts-expect-error M523. A parent's task and its leaf's, one event: the first result moves for both.
createActor(twice);

// What the tasks above call (M461: a task does its work, so none is a stub).
import { posted } from "../../fixtures/service.ts";
