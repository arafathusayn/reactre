// Tests of the plugin's first step, oxc in place of Bun's transpiler: every
// JSX source in the repository compiles to the same program through oxc as
// through Bun, with both compilers, and the rewrite of oxc's output leaves
// code outside the jsx calls alone.
//
// "The same program" is checked by minifying both outputs with oxc's
// minifier, which prints equal programs the same way whatever their
// formatting (Bun prints `main()` where oxc keeps `void main()`, and
// numbers and strings each its own way).

import { describe, expect, test } from "bun:test";

import { compileJs as compatJs, compileSource as compatSource } from "@reactre/compat/compiler";
import { compileJs as coreJs, compileSource as coreSource, ReactreCompileError } from "@reactre/compiler";
import { minifySync } from "oxc-minify";

import { transpile } from "../src/transpile.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** Sources to compile both ways: whole files, and each JSX test source of the two compilers. */
async function corpus(): Promise<{ name: string; id: string; source: string }[]> {
  const out = [];
  for (const pattern of ["apps/*/*.{jsx,tsx}", "apps/*/app/*.{jsx,tsx}"]) {
    for (const id of new Bun.Glob(pattern).scanSync(ROOT)) {
      out.push({ name: id, id, source: await Bun.file(ROOT + id).text() });
    }
  }
  for (const file of ["packages/compat/test/compiler.test.ts", "packages/core/test/index.test.ts"]) {
    const text = await Bun.file(ROOT + file).text();
    let n = 0;
    // Template literals with JSX in them and no substitutions: the sources the tests compile.
    for (const m of text.matchAll(/`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)) {
      if (!/<[A-Za-z>]/.test(m[1]!)) continue;
      const source = new Function(`return \`${m[1]}\`;`)() as string;
      out.push({ name: `${file} #${n++}`, id: "test.tsx", source });
    }
  }
  return out.concat(EDGES.map((source, i) => ({ name: `edge case #${i}`, id: "edge.tsx", source })));
}

/** Sources where Bun's and oxc's output differ in form. */
const EDGES = [
  // Comments between and inside props, and a comment as the only child.
  `export const A = ({ x }) => <a title={/* c */ "t"} b={x /* after */}>{/* nothing */}text</a>;`,
  `export const A = ({ x }) => <div
    // a line comment between props
    className="c" /* block */ id={x}
  >
    {x}
  </div>;`,
  // Entities, JSX whitespace, and numbers oxc prints in short form (.5, 1e3).
  `export const A = () => <p title="a &amp; b &quot;q&quot; &#169; &nbsp;" data-n={-0.25} tabIndex={-1} x={1e3} y={0x10} z={1_000} o={0.5}>  lead &lt;tag&gt;   trail  </p>;`,
  // Quotes of every kind.
  `export const A = ({ s }) => <p title={\`t\${s}\`} alt={\`plain\`} lang={'single'} dir={"é ünïcode ☃ \\u00e9"}>{"str"}{'single'}{\`tmpl\`}</p>;`,
  `export const A = ({ rows }) => <ul>{rows.map((r) => <li key={r.id} onClick={() => r.f(r.id / 2)}>{r.a / r.b}</li>)}</ul>;`,
  `export const A = () => <><b /><i>x</i></>;`,
  `export const A = ({ x }) => x ? <b>{x}</b> : <i>none</i>;`,
  `export function A({ el = <hr />, ...rest }) { const re = /<b>/g; return <section {...rest}>{el}{"<b>".replace(re, "")}</section>; }`,
  `const lazy = () => import(/* @vite-ignore */ "./x.js"); export const A = () => <button onClick={lazy}>go</button>;`,
];

/** The program, printed by the minifier, with the helpers' suffixes (Bun's and the plugin's) made equal. */
const program = (js: string): string =>
  minifySync("x.js", js.replace(/\b(jsxs|jsx|jsxDEV|Fragment)_[a-z0-9]{8}\b/g, "$1_x"), {
    module: true,
    compress: true,
    mangle: false,
  }).code;

/**
 * The compiled program, or the compile error, whose quoted source is spaced as each transpiler
 * prints it. A source that does not parse is a syntax error either way; Bun and oxc word it
 * differently.
 */
function outcome(compile: () => string): string {
  try {
    return program(compile());
  } catch (e) {
    return e instanceof ReactreCompileError ? `compile error: ${e.message.replace(/\s+/g, " ")}` : "syntax error";
  }
}

describe("oxc in place of Bun's transpiler", async () => {
  const sources = await corpus();

  test("the corpus has the apps' sources and the compilers' test sources", () => {
    expect(sources.filter((s) => s.name.startsWith("apps/")).length).toBeGreaterThanOrEqual(6);
    expect(sources.filter((s) => s.name.startsWith("packages/")).length).toBeGreaterThanOrEqual(10);
  });

  for (const { name, id, source } of sources) {
    const loader = id.endsWith(".jsx") ? "jsx" : "tsx";
    test(`@reactre/compiler: ${name}`, () => {
      expect(outcome(() => coreJs(transpile(id, source, "@reactre/core").code))).toBe(
        outcome(() => coreSource(source, loader)),
      );
    });
    test(`@reactre/compat/compiler: ${name}`, () => {
      expect(outcome(() => compatJs(transpile(id, source, "react").code))).toBe(
        outcome(() => compatSource(source, loader)),
      );
    });
  }
});

describe("transpile", () => {
  test("names the helpers as Bun does and drops the runtime import", () => {
    const { code } = transpile("a.tsx", `export const A = (p: { n: number }) => <><p>{p.n}</p><b /></>;`, "react");
    expect(code).not.toContain("jsx-runtime");
    expect(code).toContain(`jsxs_reactre0(Fragment_reactre0, {`);
    expect(code).toContain(`jsx_reactre0("p", { children: p.n })`);
    expect(code).not.toContain(": number");
  });

  test("leaves a helper's name alone in strings, templates and property names", () => {
    const { code } = transpile(
      "a.jsx",
      `export const A = () => <p title="_jsx">{"_jsx"}{\`_jsx\`}</p>; export const o = { _jsx: 1 }.  _jsx;`,
      "react",
    );
    expect(code).toContain(`"_jsx"`);
    expect(code).toContain("`_jsx`");
    expect(code).toContain("{ _jsx: 1 }");
  });

  test("drops comments inside jsx calls and keeps the others", () => {
    const { code } = transpile(
      "a.jsx",
      `// file comment
const load = () => import(/* @vite-ignore */ "./x.js");
export const A = () => <a
  // between props
  title={/* in a value */ "t"}>x</a>;`,
      "react",
    );
    expect(code).toContain("// file comment");
    expect(code).toContain("/* @vite-ignore */");
    expect(code).not.toContain("between props");
    expect(code).not.toContain("in a value");
  });

  test("reports an element that needs the classic runtime", () => {
    expect(transpile("a.jsx", `export const A = (p) => <b {...p} key="k" />;`, "react").classic).toBe(true);
    expect(transpile("a.jsx", `export const A = (p) => <b key="k" {...p} />;`, "react").classic).toBe(false);
  });

  test("throws oxc's message for source that does not parse", () => {
    expect(() => transpile("bad.tsx", `export const A = () => <p>;`, "react")).toThrow(/^bad\.tsx: /);
  });
});
