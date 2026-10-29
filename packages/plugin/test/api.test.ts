// Unit tests of the per-API options (src/api.ts): what the scan finds a module using, and the
// module written for the options. Building with them is tested in ./bundlers.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BEHAVIOURS, KEYS } from "@reactre/compat/api";

import { entrySource, offError, usedApis, writeEntry } from "../src/api.ts";

const uses = (code: string, file = "app.jsx"): string[] => [...usedApis(code, file)].sort();

describe("usedApis: what a module reads from React's client modules", () => {
  test("named imports and re-exports, not types, and not the server's", () => {
    expect(
      uses(
        `import { useState, useEffect as fx, type FC } from "react";
         import type { Ref } from "react";
         import { createRoot } from "react-dom/client";
         import { renderToString } from "react-dom/server";
         import { other } from "not-react";
         export { useId, type ReactNode } from "react";
         export { x } from "./x";
         export const local = 1;`,
        "app.tsx",
      ),
    ).toEqual(["createRoot", "useEffect", "useId", "useState"]);
  });

  test("members of a default or namespace import, and names destructured from it", () => {
    expect(
      uses(`import React from "react";
            import * as ReactDOM from "react-dom";
            const { useRef, ["computed"]: c, ...rest } = React;
            const { y } = other;
            React.useMemo(); ReactDOM.flushSync(); React["lazy"]; other.useCallback; React.a.b;`),
    ).toEqual(["a", "flushSync", "useMemo", "useRef"]);
  });

  test("require: a binding's members, a destructuring, and a member of the call", () => {
    expect(
      uses(`const R = require("react");
            const { useReducer } = require("react");
            const { x } = require("other");
            let s; const t = require(s);
            R.useContext(); require("react-dom").createPortal(); require("react-dom/server").renderToString();`),
    ).toEqual(["createPortal", "useContext", "useReducer"]);
  });

  test("TypeScript by extension, and code that does not parse reads nothing", () => {
    expect(uses(`import { use } from "react"; const f = <T,>(x: T) => x;`, "app.ts")).toEqual(["use"]);
    expect(uses(`import { use } from "react"; const = ;`)).toEqual([]);
  });
});

describe("the module written for the options", () => {
  const on = new Set([...KEYS, ...BEHAVIOURS].filter((k) => k !== "useEffect" && k !== "lazy"));

  test("imports what is on, stubs what is off, and keeps every name in the default object", () => {
    const src = entrySource(on);
    expect(src).toContain(
      'import "@reactre/compat/features/classes";\nimport "@reactre/compat/features/stacks";\n' +
        'import "@reactre/compat/features/keys";\nimport "@reactre/compat/features/retry";\n' +
        'import "@reactre/compat/features/concurrent";\nimport "@reactre/compat/features/viewTransitions";\n' +
        'export * from "@reactre/compat/core";',
    );
    expect(src).toContain('export const useEffect = /* @__PURE__ */ off("useEffect");');
    expect(src).toContain('export const lazy = /* @__PURE__ */ off("lazy");');
    expect(src).not.toMatch(/import \{[^}]*\buseEffect\b/);
    expect(src).toContain("useEffect, useLayoutEffect");
    expect(src).toContain("Switched off: lazy, useEffect.");
  });

  test("class support off leaves its module out and keeps core's Component", () => {
    const src = entrySource(new Set([...on].filter((k) => k !== "Component" && k !== "PureComponent")));
    expect(src).not.toContain("features/classes");
    expect(src).toContain("Switched off: Component, PureComponent, lazy, useEffect.");
    expect(src).toMatch(/import \{[^}]*\bComponent, PureComponent\b/);
    expect(src).not.toContain('off("Component")');
  });

  test("runs: a stub throws naming the fix, and the default object holds the stub", async () => {
    // Written under the plugin's own folder, whose node_modules has @reactre/compat.
    const file = writeEntry(new URL("..", import.meta.url).pathname, entrySource(on));
    const m = (await import(file)) as Record<string, unknown> & { default: Record<string, unknown> };
    expect(m["useEffect"]).toThrow(
      `React's useEffect is switched off by @reactre/plugin's compat options. Add "useEffect" to compat.apis, or remove it from compat.exclude.`,
    );
    expect(m.default["useEffect"]).toBe(m["useEffect"]);
    expect(typeof m["useState"]).toBe("function");
    expect(m.default["useState"]).toBe(m["useState"]);
  });

  test("is written once per content, under node_modules/.cache/reactre", () => {
    const root = mkdtempSync(join(tmpdir(), "reactre-entry-"));
    try {
      const file = writeEntry(root, "export {};\n");
      expect(file).toMatch(/node_modules\/\.cache\/reactre\/compat-[0-9a-f]{12}\.js$/);
      const written = statSync(file).mtimeMs;
      expect(writeEntry(root, "export {};\n")).toBe(file);
      expect(statSync(file).mtimeMs).toBe(written);
      expect(writeEntry(root, "export { };\n")).not.toBe(file);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the build error names the file, the API and the fix", () => {
    expect(offError("/app/a.jsx", "useEffect").message).toBe(
      `/app/a.jsx: uses React's useEffect, which @reactre/plugin's compat options switch off. ` +
        `Add "useEffect" to compat.apis, or remove it from compat.exclude.`,
    );
  });
});
