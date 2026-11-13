// route's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each
// to "no case is a type error"). A route is a transition: held to the core's purity.

import { readFileSync } from "node:fs";

import { type Case, change } from "../../sources.ts";

const SHOP = readFileSync(new URL("./machines.ts", import.meta.url), "utf8");

export const cases: Case[] = [
  [
    "a route that reads the clock",
    change(SHOP, "data.items > 0 ?", "data.items > Date.now() ?"),
    SHOP.split("\n").findIndex((l) => l.includes("data.items > 0 ?")) + 1,
    "Date reads the clock",
  ],
];
