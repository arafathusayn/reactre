// Switching APIs off (@reactre/preact/compiler's `off` option, src/api.ts): small apps bundled
// with Bun through the plugin. A switched-off import fails the build; a use the scan cannot see
// meets a function that throws; class support off leaves the class code out and a class that
// renders throws.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { offKeys, usedApis } from "../src/api.ts";
import { reactrePreactCompiler } from "../src/compiler.ts";
import * as dom from "../src/dom.ts";
import { container, html, installDom } from "./dom.ts";

// The coverage settings skip folders named reactre-plugin-*: these bundles are not sources.
const dir = mkdtempSync(join(tmpdir(), "reactre-plugin-preact-off-"));
const src = join(import.meta.dir, "../src");

/** Bundle `files` (the first is the entry) with the plugin and `off`; the bundle's code, or the build's error. */
async function bundle(files: Record<string, string>, off: string[], source: "preact" | "react" = "preact") {
  const sub = mkdtempSync(join(dir, "app-"));
  for (const [name, code] of Object.entries(files)) await Bun.write(join(sub, name), code);
  try {
    const r = await Bun.build({
      entrypoints: [join(sub, Object.keys(files)[0]!)],
      format: "esm",
      // Minified, as an app's build is: the class code goes only where dead code is dropped.
      minify: true,
      plugins: [
        reactrePreactCompiler({ source, off }),
        {
          // The aliases an app sets; with APIs off, the plugin resolves preact and react first.
          name: "alias",
          setup(b) {
            b.onResolve({ filter: /^(preact|react)\/jsx-(dev-)?runtime$/ }, () => ({ path: `${src}/jsx-runtime.ts` }));
            b.onResolve({ filter: /^preact(\/hooks)?$/ }, () => ({ path: `${src}/core.ts` }));
            b.onResolve({ filter: /^(react|preact\/compat)$/ }, () => ({ path: `${src}/compat.ts` }));
          },
        },
      ],
    });
    return { code: await r.outputs[0]!.text(), error: "" };
  } catch (e) {
    return { code: "", error: String((e as AggregateError).errors?.[0]?.message ?? e) };
  }
}

/** Run a bundle's code as a module and return its exports. */
async function run(code: string): Promise<Record<string, any>> {
  const file = join(mkdtempSync(join(dir, "run-")), "out.js");
  await Bun.write(file, code);
  return import(file);
}

describe("keys", () => {
  test("groups expand, what needs a switched-off key goes too, and an unknown key is an error", () => {
    const known = new Set(["Component", "PureComponent", "Suspense", "useEffect"]);
    expect([...offKeys(["@classes"], known)].sort()).toEqual(["Component", "PureComponent", "Suspense"]);
    expect([...offKeys(["useEffect"], known)]).toEqual(["useEffect"]);
    expect(() => offKeys(["useNothing"], known)).toThrow('"useNothing" is not an API key');
  });

  test("the scan reads named imports, re-exports, namespaces, defaults and require", () => {
    const code = `
      import { useState, type Ref } from "preact/hooks";
      import * as P from "preact";
      import React, { memo as m } from "react";
      export { useId } from "preact/compat";
      export * from "preact";
      const R = require("react-dom");
      const { createPortal } = require("react-dom");
      const { useRef: r } = React;
      import { other } from "./local";
      P.useEffect; React.useMemo; R.flushSync; require("react").useContext; P["computed"];
    `;
    expect([...usedApis(code, "a.ts")].sort()).toEqual(
      ["createPortal", "flushSync", "memo", "useContext", "useEffect", "useId", "useMemo", "useRef", "useState"].sort(),
    );
    expect([...usedApis("import { useState } from 'preact/hooks'; <a/>", "a.jsx")]).toEqual(["useState"]);
    expect([...usedApis("import { x } from 'react'; let a: number = 1;", "a.tsx")]).toEqual(["x"]);
    // Code that does not parse reads nothing.
    expect(usedApis("import {", "a.js").size).toBe(0);
  });
});

describe("builds", () => {
  test("an import of a switched-off API fails the build, naming the file and the key", async () => {
    const { error } = await bundle(
      { "main.jsx": `import { useEffect } from "preact/hooks"; export const a = () => useEffect;` },
      ["useEffect"],
    );
    expect(error).toContain("main.jsx: uses useEffect");
  });

  test("a switched-off API the scan cannot see throws when called; the rest work, and JSX still compiles", async () => {
    const { code, error } = await bundle(
      {
        "main.jsx": `
          import * as P from "preact";
          import { useState } from "preact/hooks";
          export const call = () => P["useEffect"]();
          export const ok = typeof useState;
          export const view = <p class="x">{1}</p>;
        `,
      },
      ["useEffect", "@transitions"],
    );
    expect(error).toBe("");
    const m = await run(code);
    expect(m.ok).toBe("function");
    expect(() => m.call()).toThrow("useEffect is switched off");
    expect(code).toContain('["p",{class:"x"},"1"]');
  });

  test("class support off: a class that renders throws, and the class code is gone", async () => {
    const files = {
      "main.jsx": `
        import { Component, render } from "preact";
        class K extends Component { render() { return null; } }
        export const go = (c) => render(<K />, c);
        import { e } from "./engine.ts";
        export const fn = (c) => render(<p>{"f" + e}</p>, c);
      `,
      // The app's own engine.ts is left as it is.
      "engine.ts": `export const e: string = "!";`,
    };
    const off = await bundle(files, ["Component"]);
    const on = await bundle(files, []);
    expect(off.error).toBe("");
    expect(off.code).not.toContain("getSnapshotBeforeUpdate");
    expect(on.code).toContain("getSnapshotBeforeUpdate");
    installDom();
    const m = await run(off.code);
    const c = container();
    m.fn(c);
    expect(html(c)).toBe("<p>f!</p>");
    expect(() => m.go(container())).toThrow("is a class component, and class support is switched off");
  });

  test("compat with classes off drops its UNSAFE_ aliases", async () => {
    const files = { "main.jsx": `import { useState } from "react"; export const a = <b>{String(useState)}</b>;` };
    const off = await bundle(files, ["@classes"], "react");
    expect(off.error).toBe("");
    expect(off.code).not.toContain("UNSAFE_");
    expect((await bundle(files, ["useId"], "react")).code).toContain("UNSAFE_");
  });
});

test("the DOM-only build is @reactre/dom", () => {
  expect(typeof dom.html).toBe("function");
  expect(typeof dom.List).toBe("function");
});
