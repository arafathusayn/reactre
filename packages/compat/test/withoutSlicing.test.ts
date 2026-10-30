// stripSlicing: what @reactre/compat's builds compile core.ts from. That the result builds byte for
// byte as before is checked by the size budgets (size.test.ts) and by diffing dist against a build
// of the last release; here, its marker rules.

import { expect, test } from "bun:test";

import { stripSlicing } from "../src/withoutSlicing.ts";

test("core.ts without time slicing keeps none of its code", async () => {
  const core = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
  const out = stripSlicing(core);
  expect(core).toContain("__REACTRE_SLICING__");
  for (const name of ["__REACTRE_SLICING__", "slicing.ts", "#if SLICING", "#else", "#endif", "runUnits", "sliceEnd"])
    expect(out).not.toContain(name);
});

test("a marked block's #else part is uncommented in its place; the rest is left as it is", () => {
  const source = [
    "a();",
    "  // #if SLICING",
    "  slice();",
    "  // #else",
    "  // whole();",
    "  //",
    "  // // a comment",
    "  // #endif",
    "  // #if SLICING",
    "  only();",
    "  // #endif",
    "b();",
  ].join("\n");
  expect(stripSlicing(source)).toBe(["a();", "  whole();", "", "  // a comment", "b();"].join("\n"));
});

test("stray or unclosed markers fail", () => {
  expect(() => stripSlicing("// #else")).toThrow('a stray "// #else"');
  expect(() => stripSlicing("// #endif")).toThrow('a stray "// #endif"');
  expect(() => stripSlicing("// #if SLICING\n// #if SLICING")).toThrow('a stray "// #if SLICING"');
  expect(() => stripSlicing("// #if SLICING\n// #else\n// #else")).toThrow('a stray "// #else"');
  expect(() => stripSlicing("// #if SLICING\nx();")).toThrow("without");
});
