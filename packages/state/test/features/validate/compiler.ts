// validate's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error"). A schema's types are the type checker's (./mistakes.ts); what
// compiler/features/validate.ts checks is the callbacks written in it, which run inside the step.

import { type Case, change, FORM } from "../../sources.ts";

/** FORM with a schema library's `refine` and `default` (declared: their types are all that matter here). */
export const NAMED = change(
  FORM,
  'import { object, string } from "../fixtures/standard-schema.ts";\n',
  `import { object, type StandardSchemaV1, string } from "../fixtures/standard-schema.ts";

declare const name: {
  default(make: () => string): StandardSchemaV1<string>;
  refine(check: (value: string) => boolean | Promise<boolean>): StandardSchemaV1<string>;
};
`,
);

export const cases: Case[] = [
  [
    "M549: a schema's default draws a random id",
    change(
      NAMED,
      "rename: object({ name: string() })",
      "rename: object({ name: name.default(() => crypto.randomUUID()) })",
    ),
    14,
    "the schema's default calls crypto.randomUUID, which a transition can't: make the id in the event",
  ],
  [
    "M550: an async refine in a schema",
    change(NAMED, "rename: object({ name: string() })", 'rename: object({ name: name.refine(async (n) => n !== "") })'),
    14,
    "an async refine in setup: check it in a task",
  ],
];
