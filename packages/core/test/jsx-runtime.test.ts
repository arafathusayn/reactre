// Tests of @reactre/core/jsx-runtime's functions: reactre's TSX compiles to templates, so a call
// to the automatic runtime means a file skipped the compiler, and it throws, naming the fix. The
// JSX namespace's types are tested by `bun check`, in jsx-types.tsx.

import { describe, expect, test } from "bun:test";

import * as dev from "../src/jsx-dev-runtime.ts";
import { jsx, jsxDEV, jsxs } from "../src/jsx-runtime.ts";

describe("the JSX runtime", () => {
  test("each element call throws, naming the element and the compiler", () => {
    expect(() => jsx("div", {})).toThrow("reactre: <div> must be compiled by @reactre/plugin or @reactre/compiler");
    expect(() => jsxs(() => null, { children: [] })).toThrow("reactre: <component> must be compiled");
    expect(() => jsxDEV("p", {}, undefined)).toThrow("reactre: <p> must be compiled");
  });

  test("the dev runtime is the same runtime", () => {
    expect(dev.jsx).toBe(jsx);
    expect(dev.jsxDEV).toBe(jsx);
    expect(dev.jsxs).toBe(jsx);
  });
});
