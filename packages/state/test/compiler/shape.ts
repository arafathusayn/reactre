// An exported shape, for ../compiler.test.ts: its machines belong in this file, so a `lamp.machine`
// call in another file is a build error (S4 at runtime).

import { setup, types } from "@reactre/state";

export const lamp = setup({
  states: { off: types<{}>(), on: types<{}>() },
  events: { flip: types<{}>() },
});

const dimmer = setup({
  states: { low: types<{}>(), high: types<{}>() },
  events: { turn: types<{}>() },
});

export { dimmer as knob };
