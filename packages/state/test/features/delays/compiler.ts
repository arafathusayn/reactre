// delays's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds each
// to "no case is a type error"). What the types can't see: that setup's delays are written in place,
// so the compiler can compile them, and that a delay function is pure.

import { type Case, change, JOB, withUse } from "../../sources.ts";

/** JOB with delays in use, a named delay `patience` written as `value`, and saving's timer using it. */
const job = (value: string, before = ""): string =>
  change(
    change(
      change(withUse(["delays"], JOB), "use: [delays],", `use: [delays],\n  delays: { patience: ${value} },`),
      '"1.5s"',
      "patience",
    ),
    "const job = setup",
    `${before}const job = setup`,
  );

export const cases: Case[] = [
  [
    // A `let` is mutable, so the evaluator fails closed: only a const or an import is read.
    "a delay given by a name the compiler can't read",
    job("PATIENCE", "let PATIENCE = 2000;\n"),
    7,
    'delay "patience" is written in place',
  ],
  [
    "a delay given by a call the compiler can't run",
    job("PATIENCE()", "const PATIENCE = () => 2000;\n"),
    7,
    'delay "patience" is written in place',
  ],
  ["a delay function reads the clock", job("() => Date.now() % 1000"), 6, "Date reads the clock"],
];
