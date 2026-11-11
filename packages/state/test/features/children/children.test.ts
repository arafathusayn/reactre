// children, compiled: a node's children in `c`, run by the import's runner on the general
// lifecycle. The runtime is tested on hand-written tables in test/actors.test.ts.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { PAGE } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

describe("children", () => {
  optIn("children");

  test("a node's children go in c, and the import's runner runs them", () => {
    const code = compile("page.ts", PAGE)?.code ?? "";
    expect(code).toContain('c: { "busy": { "job": { m: childMachine, ');
    expect(code).toContain("r: __reactreStateRun([children.r])");
  });
});
