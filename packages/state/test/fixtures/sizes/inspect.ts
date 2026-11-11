// What inspect costs an app that uses it: a light with an inspector and a logger.

import { createActor, setup, types } from "@reactre/state";
import { inspect } from "@reactre/state/inspect";

const light = setup({
  use: [inspect],
  states: { off: types<{}>(), on: types<{}>() },
  events: { flip: types<{}>() },
});
export const lightMachine = light.machine({
  start: ({ to }) => to("off"),
  states: { off: { on: { flip: ({ to }) => to("on") } }, on: { on: { flip: ({ to }) => to("off") } } },
});

export function run(): number {
  let seen = 0;
  const actor = createActor(lightMachine, { inspect: () => seen++, logger: console.log });
  actor.send({ type: "flip" });
  return seen;
}
