// Tests of @reactre/compiler/program: what a module scan finds (component definitions, call
// sites, imports, exports and uses as values), how a program links modules into each
// component's reactive props, when it gives up, the check that a module joining late leaves the
// facts compiled already true, the walk that reads a build from its entries, and the Bun plugin
// that reads a program before it compiles.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileJs, factsFor, ReactreCompileError, reactreCompiler, transpileSource } from "../src/index.ts";
import {
  analyze,
  callsOutsideJsx,
  findDefs,
  type Host,
  isExternal,
  moduleFacts,
  Program,
  readsOf,
  type Resolved,
  scanModule,
  touches,
  walk,
} from "../src/program.ts";

/** A TSX source as the compiler reads it. */
const js = (src: string): string => transpileSource(src);

/** A module's facts as plain data: each component's reactive props, sorted, or true. */
const plain = (facts: ReadonlyMap<string, ReadonlySet<string> | true>) =>
  Object.fromEntries([...facts].map(([k, v]) => [k, v === true ? true : [...v].sort()]));

/** A program of in-memory modules, resolved by their specifiers' names. */
function program(files: Record<string, string>, entries: string[] = ["main"]): Program {
  const p = new Program(entries);
  for (const [file, src] of Object.entries(files)) {
    const code = js(src);
    const resolved = new Map<string, Resolved>(
      scanModule(code).specs.map((s) => [s, s.startsWith("./") ? s.slice(2) : s === "?" ? null : false]),
    );
    p.add(file, code, resolved);
  }
  return p;
}

// #region Scanning

describe("scanning a module", () => {
  test("finds components by their definitions, with how each takes its props", () => {
    const defs = findDefs(
      js(`
      function A(props) {}
      const B = async (p = {}) => null;
      let C = function ({ a, b: c, "d-e": f, g = 1, ...rest }) {};
      var D = x => x;
      export default async function () {}
      function* lower() {}
      const E = function Named() {};
      const F = 1, G = wrap(1, (q) => q), H = memo(forward((r) => r)), I = wrap(1);
      const o = { J: (p) => p, K(p) { return p; } };
      o.L = (p) => p;
      if (A) A(1);
    `),
    );
    expect(defs.map((d) => [d.name, d.param.kind, d.open])).toEqual([
      ["A", "name", false],
      ["B", "name", false],
      ["C", "pattern", false],
      ["D", "name", false],
      ["input_default", "none", false],
      ["E", "none", false],
      ["Named", "none", false],
      ["G", "name", true],
      ["H", "name", true],
      ["J", "name", true],
      ["K", "name", true],
      ["L", "name", true],
    ]);
    const c = defs[2]!.param;
    expect(c.kind === "pattern" && [...c.locals]).toEqual([
      ["a", "a"],
      ["c", "b"],
      ["f", "d-e"],
      ["g", "g"],
    ]);
  });

  test("reads imports, exports and re-exports; dynamic imports make their module's exports escape", () => {
    const info = scanModule(
      js(`
      import Def, { a, b as c } from "./x";
      import * as ns from "./y";
      import "./side";
      export { a, c as d };
      export { e as f, default as g } from "./z";
      export * from "./star";
      export * as all from "./whole";
      export const h = 1, { i, j: k } = o;
      export function l() {}
      export async function* m() {}
      export class N {}
      const lazy = () => import("./lazy");
      const req = require("./req");
      const o = { import: 1, export: 2 };
      export default Def;
    `),
    );
    expect([...info.imports]).toEqual([
      ["Def", { spec: "./x", name: "default" }],
      ["a", { spec: "./x", name: "a" }],
      ["c", { spec: "./x", name: "b" }],
      ["ns", { spec: "./y", name: "*" }],
    ]);
    expect([...info.exports.keys()]).toEqual(["a", "d", "f", "g", "h", "i", "j", "k", "l", "m", "N", "default"]);
    expect(info.exports.get("f")).toEqual({ spec: "./z", name: "e" });
    expect(info.stars).toEqual(["./star"]);
    expect(info.whole).toEqual(["./whole", "./lazy", "./req"]);
    expect(info.specs).toEqual(["./x", "./y", "./side", "./z", "./star", "./whole", "./lazy", "./req"]);
    expect(info.opaque).toBe(false);
  });

  test("what cannot be known while compiling makes a module opaque", () => {
    for (const src of [`import(name);`, `require(name);`, `import.meta.glob("./*.tsx");`, `require.context("./")`])
      expect(scanModule(src).opaque).toBe(true);
    expect(scanModule(`import.meta.env;`).opaque).toBe(false);
  });

  test("a mention of a component other than as a jsx call's type is a use as a value", () => {
    const info = scanModule(
      js(`
      import { Imp } from "./x";
      import * as ns from "./y";
      import * as R from "@reactre/core";
      function A() {}
      function B() {}
      const o = { A: 1, x: B, [\`\${Imp}\`]: 1 };
      const el = <div><A /><ns.C /><R.Show when={1}>x</R.Show><ns.D.E /></div>;
      ns.F(); use(ns); R.signal(0);
    `),
    );
    expect([...info.escapes].sort()).toEqual(["B", "Imp"]);
    expect([...info.nsEscapes]).toEqual([
      ["ns", true],
      ["R", new Set(["signal"])],
    ]);
    // A, ns.C and ns.D.E are call sites; R.Show is control flow.
    expect(info.sites.map((s) => s.target)).toEqual([{ local: "A" }, { ns: "ns", member: "C" }, null]);
  });

  test("a call site's props: values, getters, spreads and the props each reads", () => {
    const info = scanModule(
      js(`
      function C(props) { return <D a={1} b={n()} c={props.x} d={() => f()} e={<i />} {...props} />; }
      const k = "x";
      const el = <C {...{ [k]: 1 }} />;
    `),
    );
    const [d, c] = info.sites;
    expect(d!.spread).toBe(true);
    expect(d!.props.map(([k, u]) => [k, u.fn, u.lazy, u.calls, u.reads.map(([o, r]) => [o.name, r])])).toEqual([
      ["a", false, false, false, []],
      ["b", false, false, true, []],
      ["c", false, false, false, [["C", new Set(["x"])]]],
      ["d", true, false, false, []],
      ["e", false, true, false, []],
    ]);
    expect(c!.spread).toBe(true);
  });

  test("the expression helpers: calls outside JSX, reads of a props object, and touching facts", () => {
    const h = new Set(["jsx_aaaaaaaa"]);
    expect(callsOutsideJsx(`jsx_aaaaaaaa("b", { children: n() })`, h)).toBe(false);
    expect(callsOutsideJsx(`c() ? jsx_aaaaaaaa("b", {}) : null`, h)).toBe(true);
    expect(callsOutsideJsx(`typeof (x) + "a"(1)`, h)).toBe(true);
    expect(callsOutsideJsx(`(a) + typeof (b)`, h)).toBe(false);
    // A function's body runs when it is called, not when the expression is evaluated.
    expect(callsOutsideJsx(`{ a: () => f(), b: (x) => { g(); }, c: function () { h(); }, d: async (y) => y }`, h)).toBe(
      false,
    );
    expect(callsOutsideJsx(`{ a: () => f(), b: g() }`, h)).toBe(true);
    expect(callsOutsideJsx(`new Map`, h)).toBe(true);
    expect(readsOf(`{ on: () => p.a, b: p.b }`, "p")).toEqual(new Set(["b"]));
    expect(readsOf(`p.a + p?.b + q.p + jsx_aaaaaaaa(C, { x: p.c })`, "p", h)).toEqual(new Set(["a", "b"]));
    expect(readsOf(`f(p)`, "p")).toBe(true);
    expect(readsOf(`p[k]`, "p")).toBe(true);
    expect(readsOf(`q`, "p")).toBe(null);
    expect(touches(true, new Set())).toBe(true);
    expect(touches(new Set(["a"]), true)).toBe(true);
    expect(touches(new Set(), true)).toBe(false);
    expect(touches(new Set(["a"]), new Set(["b"]))).toBe(false);
  });
});

// #endregion

// #region Programs

describe("a program", () => {
  test("links call sites to components through imports, re-exports, stars and namespaces", () => {
    const p = program({
      main: `
        import { Label, Alias } from "./barrel";
        import * as parts from "./parts";
        import Def from "./parts";
        const [n] = signal(0);
        export const App = () => <div><Label text={n()} /><Alias v={n()} /><parts.Count n={n()} /><Def d={n()} /></div>;
      `,
      barrel: `export * from "./label"; export { Other as Alias } from "./other";`,
      label: `export function Label(props) { return <b>{props.text}</b>; } export function Quiet(props) { return <i>{props.q}</i>; }`,
      other: `import { Inner } from "./inner"; export { Inner as Other };`,
      inner: `export function Inner(props) { return <b>{props.v}</b>; }`,
      parts: `export function Count(props) { return <b>{props.n}</b>; } export default function Def(props) { return <b>{props.d}</b>; }`,
    });
    expect(p.complete).toBe(true);
    expect(plain(p.factsOf("label"))).toEqual({ Label: ["text"], Quiet: [] });
    expect(plain(p.factsOf("inner"))).toEqual({ Inner: ["v"] });
    expect(plain(p.factsOf("parts"))).toEqual({ Count: ["n"], Def: ["d"] });
    expect(p.info("main")!.defs.map((d) => d.name)).toEqual(["App"]);
    expect(p.info("nowhere")).toBeUndefined();
  });

  test("the props other than children a call site passes JSX are content, in a component its module keeps", () => {
    const main = `
      import { Card as Shared } from "./card";
      function Card(props) { return <section>{props.header}<Inner title={props.header} /></section>; }
      function Inner(props) { return <b>{props.title}</b>; }
      function Used(props) { return <i>{props.icon}</i>; }
      const [on] = signal(true);
      export const App = () => (
        <div><Card header={<h1 />} text="a" /><Shared header={<h1 />} /><Used icon={<b />} />{[Used]}</div>
      );
    `;
    const p = program({ main, card: `export function Card(props) { return <p>{props.header}</p>; }` });
    const facts = p.factsOf("main");
    expect([...facts.contentProps!].map(([k, v]) => [k, [...v]])).toEqual([
      ["Card", ["header"]],
      ["Inner", ["title"]],
    ]);
    // An exported component, and one used as a value, are passed none.
    expect(p.factsOf("card").contentProps).toBeUndefined();
    const out = compileJs(js(main), { props: facts });
    expect(out).toContain("__rrInsert(__n[0], props.header, null)");
    expect(out).toContain("__rrInsert(__n[0], props.title, null)");
    expect(out).toContain("__rrBind(__rrT2, 0, __n[0], () => (props.icon))");
  });

  test("an entry's exports, and what escapes, are reactive in every prop", () => {
    const p = program(
      {
        main: `export * from "./a"; export { B } from "./b"; import * as c from "./c"; import("./d"); use(c.C1);`,
        a: `export function A(props) {} export default function ADef(props) {}`,
        b: `export function B(props) {} export function B2(props) {}`,
        c: `export function C1(props) {} export function C2(props) {}`,
        d: `export function D(props) {}`,
        e: `import * as all from "./e2"; use(all); export const x = 1;`,
        e2: `export function E(props) {}`,
        f: `export * from "./a"; export * from "./f"; export { nothing } from "./none";`,
      },
      ["main", "f"],
    );
    expect(plain(p.factsOf("a"))).toEqual({ A: true, ADef: [] });
    expect(plain(p.factsOf("b"))).toEqual({ B: true, B2: [] });
    expect(plain(p.factsOf("c"))).toEqual({ C1: true, C2: [] });
    expect(plain(p.factsOf("d"))).toEqual({ D: true });
    expect(plain(p.factsOf("e2"))).toEqual({ E: true });
  });

  test("a prop passed on is reactive where the outer prop is, until nothing changes", () => {
    const p = program({
      main: `
        function A(props) { return <B x={props.x} y={props.y} />; }
        function B(props) { return <C x={props.x} all={props} />; }
        function C(props) { return <b>{props.x}{props.all}</b>; }
        function Same(props) { return <Same x={props.x} />; }
        export const App = () => <div><A x={n()} y="1" /><Same x={1} /></div>;
      `,
    });
    expect(plain(p.factsOf("main"))).toEqual({ A: ["x"], B: ["x"], C: ["all", "x"], Same: [], App: true });
  });

  test("two components of one name share their facts; a call site whose component is unknown adds none", () => {
    const p = program({
      main: `
        import * as ns from "./x";
        function A() { function Row(props) { return <b>{props.a}</b>; } return <Row a={n()} />; }
        function B() { function Row(props) { return <b>{props.b}</b>; } return <Row b={n()} />; }
        function C() { const Row = (props) => <i />; use(Row); }
        const obj = {};
        export const App = () => <div><A /><B /><C /><obj.Card x={n()} /><ns.D.E y={n()} /></div>;
        export default class K {}
      `,
    });
    expect(plain(p.factsOf("main"))).toEqual({ A: [], B: [], C: [], Row: true, App: true });
    expect(p.info("main")!.exports.get("default")).toEqual({ local: "K" });
    const q = program({
      main: `
        function A() { function Row(props) {} return <Row a={n()} />; }
        function B() { function Row(props) {} return <Row b={n()} />; }
        export const x = 1;
      `,
    });
    expect(plain(q.factsOf("main"))).toEqual({ A: [], B: [], Row: ["a", "b"] });
  });

  test("gives up on what it cannot see: an opaque module, a specifier it cannot place", () => {
    expect(program({ main: `import(name);` }).complete).toBe(false);
    expect(program({ main: `import "?";` }).complete).toBe(false);
  });

  test("check: a module that joins late may not pass a prop reactively to a component compiled without it", () => {
    const p = program({
      main: `import { L } from "./l"; export const App = () => <div><L t="x" /></div>;`,
      l: `export function L(props) { return <b>{props.t}</b>; } export const All = (props) => <b>{props.a}</b>;`,
    });
    expect(plain(p.factsOf("l"))).toEqual({ L: [], All: [] });
    expect(p.check()).toBeNull();
    // A module that passes t as a value changes nothing; one that passes it reactively does.
    p.add(
      "late1",
      js(`import { L } from "./l"; export const X = () => <div><L t="y" /></div>;`),
      new Map([["./l", "l"]]),
    );
    expect(p.check()).toBeNull();
    p.add(
      "late2",
      js(`import { L } from "./l"; export const X = () => <div><L t={n()} /></div>;`),
      new Map([["./l", "l"]]),
    );
    expect(p.check()).toEqual({ file: "l", component: "L", prop: "t" });
    p.add("late3", js(`import { All } from "./l"; use(All);`), new Map([["./l", "l"]]));
    expect(p.check()).toEqual({ file: "l", component: "L", prop: "t" });
    // Compiled again, l is given the new facts.
    p.add(
      "l",
      js(`export function L(props) { return <b>{props.t}</b>; } export const All = (props) => <b>{props.a}</b>;`),
      new Map(),
    );
    expect(plain(p.factsOf("l"))).toEqual({ L: ["t"], All: true });
    expect(p.check()).toBeNull();
  });

  test("a module seen alone: what it exports or uses as a value is reactive in every prop", () => {
    const facts = moduleFacts(
      js(`
      function Local(props) {}
      function Used(props) {}
      export function Out(props) {}
      const App = () => <div><Local a={n()} b="1" /></div>;
      render(Used);
    `),
    );
    expect(plain(facts)).toEqual({ Local: ["a"], Used: true, Out: true, App: [] });
  });
});

// #endregion

// #region Reading a build

describe("reading a build", () => {
  const dir = mkdtempSync(join(tmpdir(), "reactre-program-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string): string => {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  /** Resolves relative specifiers in the directory, anything else as a package. */
  const host: Host = {
    resolve: (spec) => (spec.startsWith("./") ? join(dir, spec) : spec.startsWith("/") ? spec : false),
    transpile: (_, source) => transpileSource(source),
  };

  test("follows imports from the entries, an HTML page's scripts included; assets are leaves", async () => {
    file("label.tsx", `import "./style.css"; export function Label(props) { return <b>{props.t}</b>; }`);
    file("style.css", `b {}`);
    file(
      "main.tsx",
      `import { Label } from "./label.tsx"; import { x } from "./pkg/node_modules/p/i.js"; render(() => <Label t={n()} />);`,
    );
    file("inline.tsx", `export function Inline(props) { return <i>{props.v}</i>; }`);
    const page = file(
      "index.html",
      `<script type="module" src="./main.tsx"></script><script type="module">import { Inline } from "./inline.tsx"; Inline;</script><script src="/abs.js"></script>`,
    );
    file("abs.js", "");
    const p = (await analyze([page], {
      ...host,
      resolve: (spec, importer) => (spec === "/abs.js" ? join(dir, "abs.js") : host.resolve(spec, importer)),
    }))!;
    expect(p).not.toBeNull();
    expect(plain(p.factsOf(join(dir, "label.tsx")))).toEqual({ Label: ["t"] });
    expect(plain(p.factsOf(join(dir, "inline.tsx")))).toEqual({ Inline: true });
    expect(p.has(join(dir, "style.css"))).toBe(false);
  });

  test("gives up on a virtual module, a missing file, a file type that may import code, or one it cannot read", async () => {
    file("vue.tsx", `import "./c.vue";`);
    file("c.vue", "");
    file("virtual.tsx", `import "\\0virtual";`);
    file("missing.tsx", `import "./nope.tsx";`);
    file("query.tsx", `import "./label.tsx?raw";`);
    expect(await analyze([join(dir, "vue.tsx")], host)).toBeNull();
    expect(await analyze([join(dir, "virtual.tsx")], { ...host, resolve: () => "\0virtual" })).toBeNull();
    expect(await analyze([join(dir, "virtual.tsx")], { ...host, resolve: () => null })).toBeNull();
    expect(await analyze([join(dir, "missing.tsx")], host)).toBeNull();
    expect(await analyze([join(dir, "nothing.tsx")], host)).toBeNull();
    expect(await analyze([join(dir, "query.tsx")], host)).not.toBeNull();
    expect(await analyze([join(dir, "query.tsx")], { ...host, read: () => "import(x);" })).toBeNull();
  });

  test("factsFor: a module that joins late is checked against what was compiled", async () => {
    file("l.tsx", `export function L(props) { return <b>{props.t}</b>; }`);
    file("m.tsx", `import { L } from "./l.tsx"; export const A = () => <L t="x" />;`);
    const p = (await analyze([join(dir, "m.tsx")], host))!;
    expect(await factsFor(null, "x", "", host)).toBeUndefined();
    const l = join(dir, "l.tsx");
    expect(plain((await factsFor(p, l, transpileSource(await Bun.file(l).text()), host))!)).toEqual({ L: [] });
    // A late module that passes nothing reactively joins quietly.
    const quiet = transpileSource(`import { L } from "./l.tsx"; export const B = () => <L t="y" />;`);
    expect(plain((await factsFor(p, join(dir, "q.tsx"), quiet, host))!)).toEqual({ B: [] });
    const loud = transpileSource(`import { L } from "./l.tsx"; export const C = () => <L t={n()} />;`);
    const err = await factsFor(p, join(dir, "r.tsx"), loud, host).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReactreCompileError);
    expect((err as Error).message).toContain(`it passes t reactively to L in ${l}, compiled already`);
    const fresh = (await analyze([join(dir, "m.tsx")], host))!;
    const opaque = await factsFor(fresh, join(dir, "s.tsx"), "import(x);", host).catch((e: unknown) => e);
    expect((opaque as Error).message).toContain("it imports what cannot be known while compiling");
  });

  test("walk: a module already in the program is read once", async () => {
    const p = new Program([]);
    const reads: string[] = [];
    const h: Host = { ...host, read: (f) => (reads.push(f), "") };
    expect(await walk(p, [join(dir, "a.tsx"), join(dir, "a.tsx")], h)).toBe(true);
    expect(reads).toEqual([join(dir, "a.tsx")]);
  });
});

// #endregion

// #region The Bun plugin

describe("reactreCompiler's whole program", () => {
  const dir = mkdtempSync(join(tmpdir(), "reactre-bun-program-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("Bun.build reads the program from its entrypoints: an exported component's static hole stays static", async () => {
    writeFileSync(join(dir, "label.tsx"), `export function Label(props) { return <b>{props.t}</b>; }`);
    writeFileSync(
      join(dir, "main.tsx"),
      `import { Label } from "./label.tsx"; import { missing } from "no-such-package"; export const App = () => <div><Label t="x" /></div>;`,
    );
    const build = async (wholeProgram?: boolean) => {
      const r = await Bun.build({
        entrypoints: [join(dir, "main.tsx")],
        external: ["@reactre/core", "no-such-package"],
        plugins: [reactreCompiler(wholeProgram === undefined ? {} : { wholeProgram })],
      });
      return r.outputs[0]!.text();
    };
    expect(await build()).toContain("clone([props.t])");
    expect(await build(false)).toContain("() => props.t");
  });

  test("what Bun cannot resolve and the build does not name external may be a virtual module: it gives up", async () => {
    writeFileSync(
      join(dir, "virtual.tsx"),
      `import { Label } from "./label.tsx"; import "virtual:x"; export const A = () => <div><Label t="x" /></div>;`,
    );
    const r = await Bun.build({
      entrypoints: [join(dir, "virtual.tsx")],
      external: ["@reactre/core"],
      plugins: [
        {
          name: "virtual",
          setup(b) {
            b.onResolve({ filter: /^virtual:x$/ }, () => ({ path: "x", namespace: "virtual" }));
            b.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: "", loader: "js" }));
          },
        },
        reactreCompiler(),
      ],
    });
    expect(await r.outputs[0]!.text()).toContain("() => props.t");
  });

  test("isExternal: a name, its subpaths, and patterns with *", () => {
    expect(isExternal("react", ["react"])).toBe(true);
    expect(isExternal("react/jsx-runtime", ["react"])).toBe(true);
    expect(isExternal("react-dom", ["react"])).toBe(false);
    expect(isExternal("@scope/a.b", ["@scope/*"])).toBe(true);
    expect(isExternal("@scopex/a", ["@scope/*"])).toBe(false);
    expect(isExternal("virtual:x")).toBe(false);
  });
});

// #endregion
