// Unit tests for @reactre/compiler's own surface: the Bun plugin's load hook, the constructs it
// refuses with a compile error, and the scanner's handling of literals that never end. What
// compiled code does at runtime is tested with @reactre/core (packages/core/test).

import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileJs, compileSource, ReactreCompileError, reactreCompiler } from "../src/index.ts";
import { skipToken } from "../src/scan.ts";

// #region The Bun plugin

/** The plugin's load hook and filter, from a stand-in for Bun's build object. */
function loadHook(options?: { filter?: RegExp }) {
  let hook!: (args: { path: string }) => Promise<{ contents: string; loader: string } | undefined>;
  let filter!: RegExp;
  reactreCompiler(options).setup({
    onLoad: (opts: { filter: RegExp }, cb: typeof hook) => ((filter = opts.filter), (hook = cb)),
  } as never);
  return { hook, filter };
}

const files: string[] = [];
afterAll(() => files.forEach((f) => unlinkSync(f)));
/** Write `source` to a fresh file named `name` in the temp directory. */
async function temp(name: string, source: string): Promise<string> {
  const path = join(tmpdir(), `reactre-compiler-${process.pid}-${name}`);
  await Bun.write(path, source);
  files.push(path);
  return path;
}

describe("reactreCompiler", () => {
  test("compiles .tsx and .jsx files to JavaScript, by default and with a filter of the caller's", async () => {
    const { hook, filter } = loadHook();
    expect(filter.test("a.tsx") && filter.test("a.jsx") && !filter.test("a.ts")).toBe(true);
    const tsx = await hook({ path: await temp("a.tsx", `export const A = (p: { n: number }) => <b>{p.n}</b>;`) });
    expect(tsx!.loader).toBe("js");
    expect(tsx!.contents).not.toContain(": { n: number }");
    const jsx = await hook({ path: await temp("b.jsx", `export const B = () => <i>x</i>;`) });
    expect(jsx!.contents).toContain("export");
    expect(loadHook({ filter: /\.view\.tsx$/ }).filter.source).toBe("\\.view\\.tsx$");
  });

  test("leaves files under node_modules to Bun", async () => {
    const { hook } = loadHook();
    expect(await hook({ path: "/app/node_modules/pkg/index.jsx" })).toBeUndefined();
  });
});

// #endregion

// #region Compile errors

describe("compile errors", () => {
  const fails = (src: string, message: RegExp) => {
    expect(() => compileSource(src)).toThrow(ReactreCompileError);
    expect(() => compileSource(src)).toThrow(message);
  };

  test("a <For> needs props written out, each, key and a row function", () => {
    // Bun always writes props as an object literal; other tools' output may pass a variable.
    expect(() => compileJs(`const x = jsx_aaaaaaaa("ul", { children: jsx_aaaaaaaa(For, p, (r) => r) });`)).toThrow(
      /props must be an object literal/,
    );
    fails(`const p = {}; export const x = <ul><For {...p} /></ul>;`, /spread props are not supported/);
    fails(`export const x = <ul><For each={[]}>{(r) => <li />}</For></ul>;`, /needs each, key and a row function/);
  });

  test("a <For> row is one element with no components, lists or JSX expressions in it", () => {
    fails(`export const x = <ul><For each={[]} key={(r) => r}>{(r) => <Row />}</For></ul>;`, /row must be one element/);
    fails(
      `const C = () => null; export const x = <ul><For each={[]} key={(r) => r}>{(r) => <li><C /></li>}</For></ul>;`,
      /cannot hold components, lists or JSX expressions/,
    );
  });

  test("a <For> beside other children inserts its rows before its anchor", () => {
    const out = compileSource(
      `export const x = (rows) => <ul><li>head</li><For each={rows} key={(r) => r}>{(r) => <li>{r}</li>}</For></ul>;`,
    );
    expect(out).toContain(".parentNode, ");
    expect(out).not.toContain("__p.removeChild");
  });
});

// #endregion

// #region Scanning

describe("skipToken", () => {
  test("a string or template that never closes runs to the end of the source", () => {
    expect(skipToken(`"abc`, 0, "", "")).toBe(4);
    expect(skipToken("`a${b}c", 0, "", "")).toBe(7);
  });
});

// #endregion
