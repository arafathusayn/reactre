// What validate costs an app that uses it: a form whose input, event and state are Standard Schemas
// (the schemas' own code, ../standard-schema.ts, is counted too, as a schema library's would be).

import { createActor, setup, types } from "@reactre/state";
import { validate } from "@reactre/state/validate";

import { object, string } from "../standard-schema.ts";

const form = setup({
  use: [validate],
  input: object({ name: string() }),
  states: { editing: object({ name: string() }), done: types<{}>() },
  events: { rename: object({ name: string() }), finish: types<{}>() },
});

export const formMachine = form.machine({
  start: ({ input, to }) => to("editing", { name: input.name }),
  states: {
    editing: {
      on: { rename: ({ event, to }) => to("editing", { name: event.name }), finish: ({ to }) => to("done") },
    },
    done: { final: true },
  },
});

export function run(): string[] {
  const actor = createActor(formMachine, { input: { name: "ann" } });
  actor.send({ type: "rename", name: "bob" });
  actor.send({ type: "finish" });
  return [actor.snapshot().state];
}
