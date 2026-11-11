// output's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each
// to "no case is a type error"). A parent's done is a transition: held to the core's purity.

import { readFileSync } from "node:fs";

import { type Case, change } from "../../sources.ts";

const UPLOAD = readFileSync(new URL("./machines.ts", import.meta.url), "utf8");

export const cases: Case[] = [
  [
    "a parent's done that reads the clock",
    change(UPLOAD, 'state === "upload.sent"\n', 'state === "upload.sent" && Date.now() > 0\n'),
    UPLOAD.split("\n").findIndex((l) => l.endsWith('state === "upload.sent"')) + 1,
    "Date reads the clock",
  ],
];
