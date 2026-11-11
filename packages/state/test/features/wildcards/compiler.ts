// wildcards's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error"). The keys are the types'; a wildcard's handler is a
// transition, held to the core's purity.

import { readFileSync } from "node:fs";

import { type Case, change } from "../../sources.ts";

const CANVAS = readFileSync(new URL("./machines.ts", import.meta.url), "utf8");

export const cases: Case[] = [
  [
    "a * handler that draws at random",
    change(
      CANVAS,
      '"*": ({ event, to }) => to("idle", { last: event.type })',
      '"*": ({ event, to }) => to("idle", { last: `${event.type} ${Math.random()}` })',
    ),
    CANVAS.split("\n").findIndex((l) => l.includes('"*": ({ event, to }) => to("idle"')) + 1,
    "Math.random makes a transition give different results",
  ],
];
