// The compiler (src/compiler.ts): what it makes a template, what it leaves a jsx call, and the
// Bun plugin around it. What the compiled code renders is checked against Preact in blocks.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileJs, compileSource, reactrePreactCompiler } from "../src/compiler.ts";

/** The templates `src` (JSX) compiles to, as their JSON. */
const templates = (src: string, source: "preact" | "react" = "preact") =>
  [...compileSource(src, "jsx", { source }).matchAll(/__hrTemplate\((.*)\);/g)].map((m) => m[1]);

describe("templates", () => {
  test("literal props are statics; a prop after a hole is a hole, so attributes keep their order", () => {
    expect(templates(`export const a = (x) => <p id="a" title={x} class="c" n={1} u={undefined} />;`)).toEqual([
      '["p",{"id":"a","title":{"h":0},"class":{"h":1},"n":{"h":2},"u":{"h":3}}]',
    ]);
    // An uncloned DOM property is always a hole.
    expect(templates(`export const a = <video muted={true} src="s" />;`)).toEqual([
      '["video",{"muted":{"h":0},"src":{"h":1}}]',
    ]);
  });

  test("static children are inlined; anything else is one children hole", () => {
    expect(templates(`export const a = <p>a<b>c</b>{1}{null}{true}{undefined}</p>;`)).toEqual([
      '["p",0,"a",["b",0,"c"],"1"]',
    ]);
    expect(templates(`export const a = (x) => <p>a{x}</p>;`)).toEqual(['["p",0,0]']);
    expect(compileSource(`export const a = (x) => <p>a{x}</p>;`, "jsx")).toContain('[["a", x]]');
    expect(compileSource(`export const a = (x) => <p>{x}</p>;`, "jsx")).toContain("[x]");
    // Identical templates are declared once.
    expect(templates(`export const a = [<i />, <i />];`)).toEqual(['["i",0]']);
  });

  test("compat's order: class and className after every other prop", () => {
    expect(templates(`export const a = <p className="c" id="i" />;`, "react")).toEqual([
      '["p",{"id":"i","className":"c"}]',
    ]);
    expect(compileSource(`export const a = <p />;`, "jsx", { source: "react" })).toContain('from "react"');
  });

  test("what stays a jsx call", () => {
    const stays = [
      `<input value="v" />`,
      `<x-el a="1" />`,
      `<p ref={r} />`,
      `<p {...o} />`,
      `<p dangerouslySetInnerHTML={{ __html: "" }} />`,
      `<p class="a" className="b" />`,
      `<p {...{ ["k" + 1]: 1 }} />`,
      `<C a="1" />`,
    ];
    for (const s of stays)
      expect(templates(`const r = {}, o = {}, C = () => null; export const a = ${s};`)).toEqual([]);
    // A keyed child keeps the parent's children a hole, and the child its own block.
    const keyed = compileSource(`export const a = <ul>{[<li key="k">x</li>]}</ul>;`, "jsx");
    expect(keyed).toContain('__hrBlock(__hrT0, "k", [])');
    expect(templates(`export const a = <p style={{ a: 1 }} data-q="x" />;`)).toEqual([
      '["p",{"style":{"h":0},"data-q":{"h":1}}]',
    ]);
    expect(templates(`const k = 1; export const a = <p k={k} {...{ "q-q": 1 }} />;`)).toEqual([]);
  });

  test("code without JSX is left as it is; JSX with no host trees only gets its imports", () => {
    expect(compileJs("const a = 1;")).toBe("const a = 1;");
    const out = compileSource(`const C = () => null; export const a = <C />;`, "jsx");
    expect(out).toContain('from "preact/jsx-runtime"');
    expect(out).not.toContain("__hrTemplate");
    expect(compileSource(`export const a = <p a="1" />;`)).toContain("__hrBlock(__hrT0, undefined, [])");
  });
});

describe("plugin", () => {
  test("compiles .jsx and .tsx outside node_modules, and skips excluded files", async () => {
    let onLoad: (a: { path: string }) => Promise<unknown> = async () => undefined;
    let filter: RegExp | undefined;
    const setup = (options = {}) =>
      reactrePreactCompiler(options).setup({
        onLoad: (o: { filter: RegExp }, f: typeof onLoad) => ((filter = o.filter), (onLoad = f)),
      } as never);
    setup({ exclude: (p: string) => p.endsWith("skip.jsx") });
    expect(filter!.test("a.tsx")).toBe(true);
    const file = `${import.meta.dir}/scenarios/blocks.tsx`;
    const res = (await onLoad({ path: file })) as { contents: string; loader: string };
    expect(res.loader).toBe("js");
    expect(res.contents).toContain("__hrTemplate(");
    expect(await onLoad({ path: "/x/node_modules/y.jsx" })).toBeUndefined();
    expect(await onLoad({ path: "/x/skip.jsx" })).toBeUndefined();
    setup({ filter: /\.jsx$/ });
    expect(filter!.test("a.tsx")).toBe(false);
    const jsx = join(mkdtempSync(join(tmpdir(), "reactre-plugin-preact-")), "a.jsx");
    await Bun.write(jsx, "export const a = <i />;");
    expect(((await onLoad({ path: jsx })) as { contents: string }).contents).toContain("__hrTemplate(");
  });
});
