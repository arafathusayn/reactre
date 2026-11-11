// timeout's compiler cases, collected by ../compiler.ts into test/compiler.test.ts (which holds
// each to "no case is a type error"). What the types can't see: that a timeout is written in place,
// so the compiler can compile it, and that a timeout function is pure.

import { type Case, change, JOB, withUse } from "../../sources.ts";

/** JOB with timeout in use, and saving's timer as a timeout written as `value`. */
const job = (value: string, before = ""): string =>
  change(
    change(
      withUse(["timeout"], JOB),
      'after: { "1.5s": ({ to }) => to("failed", { error: "timed out" }) },',
      `timeout: ${value},\n      onTimeout: ({ to }) => to("failed", { error: "timed out" }),`,
    ),
    "const job = setup",
    `${before}const job = setup`,
  );

export const cases: Case[] = [
  [
    // A `let` is mutable, so the evaluator fails closed: only a const or an import is read.
    "a timeout given by a name",
    job("LIMIT", "let LIMIT = 1500;\n"),
    22,
    `state "saving"'s timeout is written in place`,
  ],
  [
    "a timeout given by a call the compiler can't run",
    job("LIMIT()", "const LIMIT = () => 1500;\n"),
    22,
    `state "saving"'s timeout is written in place`,
  ],
  ["a timeout function reads the clock", job("() => Date.now() % 1000"), 21, "Date reads the clock"],
];
