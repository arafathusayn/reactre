// The oxc step of @reactre/preact/plugin (src/transpile.ts): oxc's output, named as Bun names the
// runtime's helpers, compiles to what Bun's output compiles to.

import { expect, test } from "bun:test";

import { compileJs, compileSource } from "../src/compiler.ts";
import { transpile } from "../src/transpile.ts";

test("oxc's output compiles as Bun's does", () => {
  const src = `export const A = ({ n }: { n: number }) => <p class="x" title={"jsx"}>{n}<b>b</b></p>;`;
  const viaOxc = compileJs(transpile("a.tsx", src, "preact"));
  const viaBun = compileSource(src, "tsx");
  const templates = (code: string) => code.match(/__hrTemplate\(.*\)/g);
  expect(templates(viaOxc)).toEqual(templates(viaBun));
});

test("helpers are renamed outside strings, and comments inside a call are dropped", () => {
  const code = transpile(
    "a.jsx",
    `// kept\nconst s = "_jsx(";\nexport const A = () => <p a={/* gone */ 1} b={x._jsx}>{s}</p>;`,
    "react",
  );
  expect(code).toContain("// kept");
  expect(code).not.toContain("gone");
  expect(code).toContain('"_jsx("');
  expect(code).toContain("x._jsx");
  expect(code).toContain("jsx_reactre0(");
  // TypeScript without JSX has no helpers to rename.
  expect(transpile("a.ts", "export const n: number = 1;", "preact")).toContain("export const n = 1;");
});

test("a file that does not parse throws oxc's message, naming the file", () => {
  expect(() => transpile("bad.jsx", "export const A = <p>;", "preact")).toThrow("bad.jsx:");
});
