// The rewrite of @reactre/core/features/memo's calls (src/observed.ts): a call of `memo` or
// `signal` that passes `lazy` or `unobserved`, or options the compiler cannot read, goes to the
// module's reader-counting entry; every other call, and every file without the import, compiles
// as it did. What the entries do at runtime is tested with @reactre/core (lazyMemo.test.ts, and
// the lazyMemo profile of features.test.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileJs, compileJsWithMap, compileSource, reactreCompiler, transpileSource } from "../src/index.ts";
import { remark } from "../src/map.ts";
import { observedCalls } from "../src/observed.ts";
import { Program, type Resolved, scanModule } from "../src/program.ts";

const IMPORT = `import { memo, signal } from "@reactre/core/features/memo";\n`;

/** A TSX module body compiled alone, after the module's import. */
const compiled = (body: string, head = IMPORT): string => compileSource(head + body);

/**
 * A version 3 map's segments, decoded: [line, column, source line, source column], 0-based, the
 * last segment at or before each place in the code.
 */
function segments(mappings: string): [number, number, number, number][] {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: [number, number, number, number][] = [];
  let sl = 0,
    sc = 0;
  mappings.split(";").forEach((line, l) => {
    let col = 0;
    for (const seg of line.split(",").filter(Boolean)) {
      const v: number[] = [];
      for (let i = 0, n = 0, shift = 0; i < seg.length; i++) {
        const d = B64.indexOf(seg[i]!);
        n += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          v.push(n & 1 ? -(n >> 1) : n >> 1);
          n = shift = 0;
        }
      }
      col += v[0]!;
      sl += v[2]!;
      sc += v[3]!;
      out.push([l, col, sl, sc]);
    }
  });
  return out;
}

/** Where code position (line, column), 0-based, came from by the map: the segment at or before it. */
function origin(segs: readonly [number, number, number, number][], line: number, column: number): [number, number] {
  const s = segs.filter(([l, c]) => l === line && c <= column).at(-1)!;
  return [s[2], s[3]];
}

/** What a body's calls become: the compiled code past its imports. */
const calls = (body: string, head = IMPORT): string =>
  compiled(body, head)
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n")
    .trim();

describe("calls with options the reader count needs", () => {
  test("an object literal with lazy or unobserved goes to the reader-counting entry", () => {
    expect(calls(`export const m = memo(() => 1, { lazy: true });`)).toBe(
      `export const m = __rrObsMemo(() => 1, { lazy: true });`,
    );
    expect(calls(`export const m = memo(() => 1, { equals: false, unobserved: () => {} });`)).toContain("__rrObsMemo(");
    expect(calls(`export const [s] = signal(0, { unobserved: () => {} });`)).toBe(
      `export const [s] = __rrObsSignal(0, { unobserved: () => {} });`,
    );
    // Keys however they are written: shorthand, quoted, a method, a getter.
    for (const o of [`{ lazy }`, `{ "lazy": true }`, `{ unobserved() {} }`, `{ get lazy() { return true; } }`])
      expect(calls(`const lazy = true; export const m = memo(() => 1, ${o});`)).toContain("__rrObsMemo(");
    // The import names what each call needs.
    expect(compiled(`export const m = memo(() => 1, { lazy: true });`)).toContain(
      `import { __observedMemo as __rrObsMemo } from "@reactre/core/features/memo";`,
    );
    expect(compiled(`memo(f, { lazy: true }); signal(1, { unobserved: g });`)).toContain(
      `import { __observedMemo as __rrObsMemo, __observedSignal as __rrObsSignal } from "@reactre/core/features/memo";`,
    );
  });

  test("other calls stay as they are, and so does the file", () => {
    const plain = `export const m = memo(() => 1, { equals: false });
      export const n = memo(() => 1);
      export const o = memo(() => 1, undefined);
      export const [s] = signal(() => 1, { equals: (a, b) => a === b });
      export const [t] = signal(1, { lazy: true });`;
    // No rewrite at all: the same code as a file the compiler leaves alone.
    expect(observedCalls(transpileSource(IMPORT + plain))).toBeNull();
    expect(compiled(plain)).toBe(transpileSource(IMPORT + plain));
    // A file that does not import the module.
    const other = `import { memo } from "@reactre/core"; export const m = memo(() => 1, { lazy: true });`;
    expect(compileSource(other)).toBe(transpileSource(other));
  });

  test("options it cannot read take the reader-counting entry, which is right for any", () => {
    for (const args of [`f, opts`, `f, { ...opts }`, `f, { [key]: true }`, `f, make()`, `...args`])
      expect(calls(`export const m = memo(${args});`)).toContain(`__rrObsMemo(${args})`);
    // Keys Bun does not print, as another transpiler may: in single quotes, or with an escape.
    for (const o of [`{ 'equals': 1 }`, `{ "\\x65quals": 1 }`])
      expect(observedCalls(`${IMPORT}memo(f, ${o});`)!.code).toContain(`__rrObsMemo(f, ${o})`);
    expect(observedCalls(`${IMPORT}memo(f, { "equals": 1 });`)).toBeNull();
  });
});

describe("how the functions are imported and used", () => {
  test("under another local name", () => {
    const head = `import { memo as m, signal as s } from "@reactre/core/features/memo";\n`;
    expect(
      calls(`export const a = m(() => 1, { lazy: true }), b = m(() => 2), [c] = s(1, { unobserved: f });`, head),
    ).toBe(
      `export const a = __rrObsMemo(() => 1, { lazy: true }), b = m(() => 2), [c] = __rrObsSignal(1, { unobserved: f });`,
    );
  });

  test("through a namespace import", () => {
    const head = `import * as M from "@reactre/core/features/memo";\n`;
    expect(
      calls(`export const a = M.memo(() => 1, { lazy: true }), b = M.memo(() => 2), c = M.signal(1, o);`, head),
    ).toBe(
      `export const a = M.__observedMemo(() => 1, { lazy: true }), b = M.memo(() => 2), c = M.__observedSignal(1, o);`,
    );
    // Used as a value, the member is the reader-counting entry; the namespace itself stays.
    expect(calls(`export const f = M.memo, g = M;`, head)).toBe(`export const f = M.__observedMemo, g = M;`);
  });

  test("a use that is not a call is the reader-counting entry: a value, a shorthand, an export", () => {
    expect(calls(`export const make = memo; const o = { memo, x: 1 }; [memo].map((f) => f(g, h));`)).toBe(
      `export const make = __rrObsMemo;\nconst o = { memo: __rrObsMemo, x: 1 };\n[__rrObsMemo].map((f) => f(g, h));`,
    );
    expect(calls(`export { memo, signal as s };`)).toBe(`export { __rrObsMemo as memo, __rrObsSignal as s };`);
    expect(calls(`apply(...memo);`)).toBe(`apply(...__rrObsMemo);`);
    expect(calls(`export const o = { a: f(1), memo }; export function g() { return { signal }; }`)).toBe(
      `export const o = { a: f(1), memo: __rrObsMemo };\nexport function g() {\n  return { signal: __rrObsSignal };\n}`,
    );
  });

  test("a re-export by name hands on the reader-counting entry", () => {
    expect(compileSource(`export { memo, signal as s } from "@reactre/core/features/memo";`)).toBe(
      `export { __observedMemo as memo, __observedSignal as s } from "@reactre/core/features/memo";\n`,
    );
    const star = `export * from "@reactre/core/features/memo";`;
    expect(compileSource(star)).toBe(transpileSource(star));
  });

  test("names that are not the import: members, keys, methods, literals, other modules' lists", () => {
    const body = `import { memo as other } from "./other";
      export const a = x.memo(f, opts), b = { memo: 1 }, c = "memo(f, opts)", d = other(f, opts);
      export class K { memo(f, opts) { return f; } }
      export const e = cond ? 1 : 2;`;
    expect(observedCalls(transpileSource(IMPORT + body))).toBeNull();
  });

  test("a name bound again is not the import where that binding is in scope", () => {
    const body = `export function a(memo) { return memo(f, opts); }
      export const b = (signal) => signal(1, opts);
      export const c = signal => signal(1, opts);
      export function d() { const memo = mk(); return memo(f, opts); }
      export function e() { const { signal } = mk(); return signal(1, opts); }
      export function g() { try { x(); } catch (memo) { return memo(f, opts); } }
      export function h() { function memo(a, b) { return a; } return memo(f, opts); }
      export function k() { class signal {} return new signal(1, opts); }
      export const l = memo(f, { lazy: true });`;
    expect(calls(body).match(/__rrObs\w+/g)).toEqual(["__rrObsMemo"]);
    expect(calls(body)).toContain("const l = __rrObsMemo(f, { lazy: true })");
    // A lone parameter, as a transpiler other than Bun may print it.
    expect(observedCalls(`${IMPORT}const b = signal => signal(1, opts), c = memo(f, opts);`)!.code).toContain(
      "const b = signal => signal(1, opts), c = __rrObsMemo(f, opts);",
    );
    // Code cut short: a call that never closes is read to the end.
    expect(observedCalls(`${IMPORT}memo(f, { lazy: true }`)!.code).toContain("__rrObsMemo(f, { lazy: true }");
    // A condition's parentheses are no parameter list.
    expect(calls(`if (memo) { memo(f, opts); }`)).toBe(`if (__rrObsMemo) {\n  __rrObsMemo(f, opts);\n}`);
  });

  test("calls in a template literal's substitutions, and in JSX", () => {
    expect(calls("export const t = `${memo(f, { lazy: true })()}`;")).toBe(
      "export const t = `${__rrObsMemo(f, { lazy: true })()}`;",
    );
    const out = compiled(`const total = memo(() => 1, { lazy: true }); export const A = () => <p>{total()}</p>;`);
    expect(out).toContain("const total = __rrObsMemo(() => 1, { lazy: true });");
    expect(out).toContain(`import { __template as __rrT`);
  });
});

describe("the same code in every compile", () => {
  test("a file seen alone (a dev server) and in a whole program (a production build)", () => {
    const src = `${IMPORT}import { signal as base } from "@reactre/core";
      const [n] = base(1);
      const doubled = memo(() => n() * 2, { lazy: true }), [label] = signal("x", opts);
      export const App = () => <p>{doubled()}{label()}</p>;`;
    const code = transpileSource(src);
    const p = new Program(["main"]);
    p.add("main", code, new Map<string, Resolved>(scanModule(code).specs.map((s) => [s, false])));
    const whole = compileJs(code, { props: p.factsOf("main") });
    expect(whole).toBe(compileSource(src));
    expect(whole).toContain("__rrObsMemo(() => n() * 2");
    expect(whole).toContain('__rrObsSignal("x", opts)');
  });

  test("a server compile sends the calls to the same entries", () => {
    const out = compileSource(
      `${IMPORT}const m = memo(f, { lazy: true }); export const A = () => <p>{m()}</p>;`,
      "tsx",
      {
        server: true,
      },
    );
    expect(out).toContain(`import { __observedMemo as __rrObsMemo } from "@reactre/core/features/memo";`);
    expect(out).toContain("const m = __rrObsMemo(f, { lazy: true });");
  });

  test("a source map maps the rewritten code back to the input, with and without JSX", () => {
    for (const src of [
      `${IMPORT}export const m = memo(() => one(), { lazy: true }), z = zed();`,
      `${IMPORT}export const m = memo(() => one(), { lazy: true }), z = zed(); export const A = () => <p>{m()}</p>;`,
    ]) {
      const js = transpileSource(src);
      const { code, map } = compileJsWithMap(js);
      expect(code).toBe(compileJs(js));
      const segs = segments(map!.mappings);
      // Each token after the rewritten callee maps to its own place in the input.
      for (const name of ["__rrObsMemo", "one", "zed"]) {
        const at = code.indexOf(name + "(");
        const line = code.slice(0, at).split("\n").length - 1;
        const column = at - code.lastIndexOf("\n", at - 1) - 1;
        const [l, c] = origin(segs, line, column);
        expect(js.split("\n")[l]!.slice(c)).toStartWith(name === "__rrObsMemo" ? "memo(" : name + "(");
      }
    }
    // The marks of a compile of the rewrite, moved back: a mark in the added import goes to the start.
    const r = observedCalls(transpileSource(`${IMPORT}memo(f, { lazy: true });`))!;
    expect(remark(`3x`, r.back)).toBe(`0x`);
  });
});

describe("the Bun plugin", () => {
  const files: string[] = [];
  afterAll(() => files.forEach((f) => unlinkSync(f)));

  test("compiles a .ts file a filter of the caller's takes, as TypeScript", async () => {
    let hook!: (args: { path: string }) => Promise<{ contents: string } | undefined>;
    reactreCompiler({ filter: /\.[jt]sx?$/, wholeProgram: false }).setup({
      onLoad: (opts: { filter: RegExp }, cb: typeof hook) => {
        if (opts.filter.source === "\\.[jt]sx?$") hook = cb;
      },
    } as never);
    const path = join(tmpdir(), `reactre-observed-${process.pid}.ts`);
    files.push(path);
    await Bun.write(path, `${IMPORT}export const total = memo<number>(() => 1, { lazy: true } as const);`);
    const out = (await hook({ path }))!.contents;
    expect(out).toContain("__rrObsMemo(() => 1, { lazy: true })");
    expect(out).not.toContain("<number>");
  });
});
