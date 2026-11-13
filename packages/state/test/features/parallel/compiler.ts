// parallel's compiler cases: regions' steps and setup's `parallel` written in place, and purity in
// a parallel node's `done`. Collected by ../compiler.ts into test/compiler.test.ts.

import { type Case, change, PLAYER } from "../../sources.ts";

export const cases: Case[] = [
  [
    "a region's step built elsewhere",
    change(
      PLAYER,
      'power: ({ to }) => to("on", { a: to("on.a.x"), b: to("on.b.z") })',
      'power: ({ to }) => { const a = to("on.a.x"); return to("on", { a, b: to("on.b.z") }); }',
    ),
    15,
    'write region "a"\'s step as to(...) in place',
  ],
  [
    "setup's parallel in a variable",
    change(
      change(PLAYER, 'parallel: ["on"],', "parallel: PARALLEL,"),
      "const player",
      'const PARALLEL = ["on"] as const;\nconst player',
    ),
    8,
    "setup's parallel is an array of names written in place",
  ],
  [
    "the clock in a parallel node's done",
    change(PLAYER, '? to("off") : to("off")', '? to("off") : Date.now() > 0 ? to("off") : to("off")'),
    16,
    "Date reads the clock",
  ],
];
