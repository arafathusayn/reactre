// history's compiler cases: what codegen needs written in place in `back`. Collected by
// ../compiler.ts into test/compiler.test.ts, which also holds each to "no case is a type error".

import { readFileSync } from "node:fs";

import { type Case, change, EDITOR } from "../../sources.ts";

const FORM_SOURCE = readFileSync(new URL("./machines.ts", import.meta.url), "utf8");

export const cases: Case[] = [
  [
    "back's parent in a variable",
    change(
      change(EDITOR, 'back("edit", to(', "back(EDIT, to("),
      "export const editorMachine",
      'const EDIT = "edit";\nexport const editorMachine',
    ),
    15,
    "back's first argument is a parent's name written in place",
  ],
  [
    "back's fallback built elsewhere",
    change(
      EDITOR,
      'resume: ({ back, to }) => back("edit", to("edit.draft", { text: "" }))',
      'resume: ({ back, to }) => { const fallback = to("edit.draft", { text: "" }); return back("edit", fallback); }',
    ),
    14,
    "back's fallback is to(...) written in place",
  ],
  [
    "back's shallow steps in a variable",
    change(
      change(FORM_SOURCE, '{ details: to("form.details.name", { name: "again" }) }', "steps"),
      "export const formMachine",
      'const steps = { details: { state: "form.details.name" } } as never;\nexport const formMachine',
    ),
    // The line of the shallow `back`, one down for the variable above the machine.
    FORM_SOURCE.split("\n").findIndex((l) => l.includes("{ details: to(")) + 2,
    "back's shallow steps are an object literal written in place",
  ],
  [
    "a shallow step built elsewhere",
    change(
      change(FORM_SOURCE, 'details: to("form.details.name", { name: "again" })', "details: again"),
      "export const formMachine",
      "const again = null as never;\nexport const formMachine",
    ),
    FORM_SOURCE.split("\n").findIndex((l) => l.includes("{ details: to(")) + 2,
    `write child "details"'s step as to(...) in place`,
  ],
];
