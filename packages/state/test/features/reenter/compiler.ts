// reenter's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error").

import { readFileSync } from "node:fs";

import { type Case, change, JOB, withUse } from "../../sources.ts";

const FETCHER = readFileSync(new URL("./machines.ts", import.meta.url), "utf8");

/** JOB whose saving POSTs, and a second `save` while saving reenters it (M478). */
const RESAVE = change(
  change(
    withUse(["reenter"], JOB),
    'run: async ({ data }) => ({ type: "stored", id: data.text }),',
    'run: async ({ data, signal }) => {\n          const res = await fetch("/save", { method: "POST", body: data.text, signal });\n          if (!res.ok) throw new Error(`HTTP ${res.status}`);\n          return { type: "stored", id: await res.text() };\n        },',
  ),
  'on: { stored: ({ event, to }) => to("saved", { id: event.id }) },',
  'on: {\n        stored: ({ event, to }) => to("saved", { id: event.id }),\n        save: ({ event, reenter }) => reenter("saving", { text: event.text }),\n      },',
);

export const cases: Case[] = [
  [
    "M478: an event that reenters a leaf whose task POSTs",
    RESAVE,
    RESAVE.split("\n").findIndex((l) => l.includes('reenter("saving"')) + 1,
    '`save` restarts the POST in "saving": decline it there (or keep the running one)',
  ],
  [
    "reenter's state in a variable",
    change(
      change(FETCHER, 'reenter("loading", {', "reenter(LOADING, {"),
      "export const fetcherMachine",
      'const LOADING = "loading";\nexport const fetcherMachine',
    ),
    // The reenter's line, one down for the variable above the machine.
    FETCHER.split("\n").findIndex((l) => l.includes('reenter("loading", {')) + 2,
    "reenter's first argument is a state's name written in place",
  ],
];
