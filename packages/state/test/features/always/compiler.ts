// always's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each
// to "no case is a type error"). always's handlers are transitions: held to the core's purity.

import { type Case, change, DOOR, withUse } from "../../sources.ts";

export const cases: Case[] = [
  [
    "an always that reads the clock",
    change(
      withUse(["always"], DOOR),
      "open: { on:",
      'open: { always: ({ to }) => (Date.now() > 0 ? to("closed") : null), on:',
    ),
    24,
    "Date reads the clock",
  ],
  [
    "M524: an always that goes to its own state with the same data",
    change(
      withUse(["always"], DOOR),
      "locked: { on:",
      'locked: { always: ({ data, to }) => (data.code === "" ? to("locked", data) : null), on:',
    ),
    25,
    'the `always` of "locked" goes to "locked" with the same data, forever: decline with null',
  ],
  [
    "M524: an always that goes to its own state with a copy of its data",
    change(
      withUse(["always"], DOOR),
      "locked: { on:",
      'locked: { always: ({ data, to }) => (data.code === "" ? to("locked", { ...data }) : null), on:',
    ),
    25,
    'the `always` of "locked" goes to "locked" with the same data, forever: decline with null',
  ],
  [
    "M524: two alwayses that go to each other, without data",
    `import { setup, types } from "@reactre/state";
import { always } from "@reactre/state/always";

const pair = setup({ use: [always], states: { a: types<{}>(), b: types<{}>() }, events: {} });

export const pairMachine = pair.machine({
  start: ({ to }) => to("a"),
  states: {
    a: { always: ({ to }) => to("b") },
    b: { always: ({ to }) => to("a") },
  },
});
`,
    10,
    'the `always` of "a" and "b" go to each other with the same data, forever: decline with null in one',
  ],
];
