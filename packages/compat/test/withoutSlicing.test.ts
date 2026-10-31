// stripBlocks: what @reactre/compat's builds compile core.ts from. That the result builds byte for
// byte as before is checked by the size budgets (size.test.ts) and by diffing dist against a build
// of the last release; here, its marker rules.

import { expect, test } from "bun:test";

import { stripBlocks, stripSlicing } from "../src/withoutSlicing.ts";

const core = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();

test("core.ts without time slicing keeps none of its code, and its Fast Refresh as it is", () => {
  const out = stripSlicing(core);
  expect(core).toContain("__REACTRE_SLICING__");
  for (const name of ["__REACTRE_SLICING__", "slicing.ts", "#if SLICING", "runUnits", "sliceEnd"])
    expect(out).not.toContain(name);
  for (const name of ["#if REFRESH", "scheduleRefresh", "refreshed(f)"]) expect(out).toContain(name);
});

test("core.ts without Fast Refresh keeps none of its code, and its time slicing as it is", () => {
  const out = stripBlocks(core, "REFRESH");
  for (const name of ["#if REFRESH", "scheduleRefresh", "__REACT_DEVTOOLS_GLOBAL_HOOK__", "refreshFamily", "devHook"])
    expect(out).not.toContain(name);
  expect(out).toContain("#if SLICING");
  // The production builds' source: neither, and no marker left.
  const production = stripSlicing(out);
  for (const name of ["#if ", "#else", "#endif", "__REACTRE_SLICING__", "scheduleRefresh"])
    expect(production).not.toContain(name);
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

test("another name's block passes through whole, its #else part included", () => {
  const source = ["a();", "// #if REFRESH", "dev();", "// #else", "// prod();", "// #endif", "b();"].join("\n");
  expect(stripSlicing(source)).toBe(source);
  expect(stripBlocks(source, "REFRESH")).toBe(["a();", "prod();", "b();"].join("\n"));
});

test("stray or unclosed markers fail", () => {
  expect(() => stripSlicing("// #else")).toThrow('a stray "// #else"');
  expect(() => stripSlicing("// #endif")).toThrow('a stray "// #endif"');
  expect(() => stripSlicing("// #if SLICING\n// #if SLICING")).toThrow('a stray "// #if SLICING"');
  expect(() => stripSlicing("// #if SLICING\n// #else\n// #else")).toThrow('a stray "// #else"');
  expect(() => stripSlicing("// #if SLICING\nx();")).toThrow("without");
});
