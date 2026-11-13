// validate's mistakes, each a type error (`bun check` fails if one stops being one);
// ../../explain.ts prints what each says. Cases 56–57, and the opt-in, 62.

import { createActor, setup, type ShapeCheck, types } from "@reactre/state";
import { validate } from "@reactre/state/validate";

import { object, type StandardSchemaV1, string } from "../../fixtures/standard-schema.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expect = <T extends true>(): T | undefined => undefined;

// @ts-expect-error 62. A Standard Schema without validate in use: the error names the import.
setup({ states: { editing: object({ name: string() }) }, events: {} });
const unchecked = { states: { editing: object({ name: string() }) }, events: {} };
expect<
  Equal<
    keyof ShapeCheck<typeof unchecked>,
    `state "editing" is a Standard Schema: add validate to setup's use (import { validate } from "@reactre/state/validate")`
  >
>();

// Standard Schemas in place of types<T>(): handlers get the output, `send` takes the input.
// A schema library's schema whose output is a Date (one that parses an ISO string, say).
declare const withDate: StandardSchemaV1<{ at: string }, { at: Date }>;
// @ts-expect-error 56. A schema whose output JSON can't hold.
setup({ use: [validate], states: { idle: withDate }, events: {} });
const form = setup({
  use: [validate],
  states: { editing: object({ name: string() }), done: types<{}>() },
  events: { rename: object({ name: string() }), finish: types<{}>() },
});
const formMachine = form.machine({
  start: ({ to }) => to("editing", { name: "" }),
  states: {
    editing: {
      on: { rename: ({ event, to }) => to("editing", { name: event.name }), finish: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});
// @ts-expect-error 57. A payload that isn't the schema's input.
createActor(formMachine).send({ type: "rename", name: 1 });

// The second round's rows, by their M#.
// A schema that parses a string into a number (z.string().transform(Number)).
declare const toNumber: StandardSchemaV1<{ n: string }, { n: number }>;
// @ts-expect-error M548. A state's schema that transforms: every transition and restore holds the output.
setup({ use: [validate], states: { idle: toNumber }, events: {} });
// An async schema (valibot's objectAsync).
declare const checked: StandardSchemaV1<{ name: string }> & { readonly async: true };
// @ts-expect-error M551. An async schema, which a transition can't wait for.
setup({ use: [validate], states: { editing: checked }, events: {} });
// A coerce's schema (z.coerce.number()): its input is unknown.
declare const coerced: StandardSchemaV1<unknown, { n: number }>;
// @ts-expect-error M552. An event whose schema takes anything: send takes anything.
setup({ use: [validate], states: { idle: types<{}>() }, events: { set: coerced } });
expect<
  Equal<
    keyof ShapeCheck<{
      use: readonly [typeof validate];
      states: { idle: typeof toNumber; editing: typeof checked };
      events: { set: typeof coerced };
    }>,
    | 'the schema of "idle" transforms `n` (its input and output differ): parse it at the edge, and keep the state\'s schema plain'
    | `the schema of state "editing" is async, which a transition can't wait for: check it in a task`
    | `the input of the event "set"'s schema is unknown (a coerce or preprocess): send the parsed value, typed`
  >
>();
// Item 7: a schema whose output has no type names the library, not the user's code.
declare const untyped: {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "x";
    readonly validate: (v: unknown) => { value: unknown };
  };
};
// @ts-expect-error A Standard Schema without ~standard.types: its output has no type.
setup({ use: [validate], states: { idle: untyped }, events: {} });
declare const anyOut: StandardSchemaV1<any, any>;
// @ts-expect-error A schema whose library types its output any (z.any(), z.custom()).
setup({ use: [validate], states: { idle: anyOut }, events: {} });
