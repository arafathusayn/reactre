// choice's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each
// to "no case is a type error"). A choice is a transition: held to the core's purity.

import { readFileSync } from "node:fs";

import { type Case, change } from "../../sources.ts";

const ORDER = readFileSync(new URL("./machines.ts", import.meta.url), "utf8");

/** Two choices: `a` goes to `b` (or back to idle), and `b` back to `a`, each with the data it has. */
const FLIP = `import { setup, types } from "@reactre/state";
import { choice } from "@reactre/state/choice";

const flip = setup({
  use: [choice],
  states: { idle: types<{ n: number }>(), a: types<{ n: number }>(), b: types<{ n: number }>() },
  events: { go: types<{}>() },
});

export const flipMachine = flip.machine({
  start: ({ to }) => to("idle", { n: 0 }),
  states: {
    idle: { on: { go: ({ data, to }) => to("a", { n: data.n + 1 }) } },
    a: { choice: ({ data, to }) => (data.n > 0 ? to("b", data) : to("idle", { n: data.n })) },
    b: { choice: ({ data, to }) => to("a", data) },
  },
});
`;

export const cases: Case[] = [
  [
    "M527: two choices that go to each other with the same data",
    FLIP,
    15,
    'the choices "a" and "b" go to each other with the same data, forever: make one decide',
  ],
  [
    "M527: a choice that goes to itself with the same data",
    change(FLIP, 'b: { choice: ({ data, to }) => to("a", data) }', 'b: { choice: ({ data, to }) => to("b", data) }'),
    15,
    'the choice "b" goes to itself with the same data, forever: make it decide',
  ],
  [
    "a choice that draws at random",
    change(ORDER, "data.vip\n", "data.vip || Math.random() > 0.5\n"),
    ORDER.split("\n").findIndex((l) => l.endsWith("data.vip")) + 1,
    "Math.random makes a transition give different results",
  ],
];
