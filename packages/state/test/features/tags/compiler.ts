// tags' compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each to
// "no case is a type error"). Types see that meta is JSON; only the compiler sees how it was built.

import { type Case, change, DOOR, withUse } from "../../sources.ts";

const TAGGED = change(withUse(["tags"], DOOR), "open: { on:", 'open: { tags: ["busy"], meta: { by: "door" }, on:');

export const cases: Case[] = [
  [
    "meta computed when the module loads",
    change(TAGGED, 'meta: { by: "door" }', "meta: { at: Date.now() }"),
    24,
    `state "open"'s meta is JSON written in place`,
  ],
  [
    "meta in a variable",
    change(
      change(TAGGED, 'meta: { by: "door" }', "meta: OPEN_META"),
      "export const doorMachine",
      'const OPEN_META = { by: "door" };\nexport const doorMachine',
    ),
    25,
    `state "open"'s meta is JSON written in place`,
  ],
];
