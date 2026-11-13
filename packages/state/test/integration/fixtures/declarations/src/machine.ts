// A machine as the plugin compiles one, checked against the packed declarations: the contracts
// must reach a user's project, so a misspelled target is still a type error there.

import { createActor, setup, types } from "@reactre/state";

const door = setup({
  version: 1,
  states: { closed: types<{}>(), open: types<{ by: string }>() },
  events: { push: types<{ by: string }>(), close: types<{}>() },
});

export const doorMachine = door.machine({
  start: ({ to }) => to("closed"),
  states: {
    closed: { on: { push: ({ event, to }) => to("open", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

door.machine({
  start: ({ to }) => to("closed"),
  states: {
    // @ts-expect-error: "opened" is not a state of the shape.
    closed: { on: { push: ({ event, to }) => to("opened", { by: event.by }) } },
    open: { on: { close: ({ to }) => to("closed") } },
  },
});

const actor = createActor(doorMachine);
actor.send({ type: "push", by: "ann" });
// The snapshot narrows on its state: only "open" has `by`.
const snapshot = actor.snapshot();
const by: string | undefined = snapshot.state === "open" ? snapshot.data.by : undefined;

export const checked: string | undefined = by;
