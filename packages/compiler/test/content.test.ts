// Tests of JSX held in values, in @reactre/compiler: a hole that mentions a local made of JSX, a
// function that returns it or a value imported from such a module of the program is inserted
// (`__insert`, or a slot when it may change), not written as text (`__bind`, or the clone's
// text), in client, hydrate and server builds, for a file alone and in a whole program; a
// fragment's expression in an element is inserted whatever the compiler knows of it; and a
// component the scan finds no name for (an object's property, a member, what a function returns)
// is open, so the holes that read its props follow them. What the scan finds is tested here too
// (`ModuleInfo.jsx`, `PropFacts.jsx`, the unnamed components' `Def`s).

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as runtime from "../../core/src/index.ts";
import { compileJs, type CompileOptions, transpileSource } from "../src/index.ts";
import { findDefs, Program, type Resolved, scanModule } from "../src/program.ts";

/** The name the scan gives a component it finds no name for. */
const UNNAMED = "(unnamed)";

beforeEach(installFakeDocument);

// #region Harness

/** A TSX source as the compiler reads it. */
const js = (src: string): string => transpileSource(src);

/** A program of in-memory modules, resolved by their specifiers' names (`./a` is module `a`). */
function program(files: Record<string, string>, entries: string[] = ["main"]): Program {
  const p = new Program(entries);
  for (const [file, src] of Object.entries(files)) {
    const code = js(src);
    const resolved = new Map<string, Resolved>(
      scanModule(code).specs.map((s) => [s, s.startsWith("./") ? s.slice(2) : false]),
    );
    p.add(file, code, resolved);
  }
  return p;
}

/** `src` compiled alone, and as module `main` of a program of `src` and `others`, with `options`. */
function both(src: string, options: CompileOptions = {}, others: Record<string, string> = {}): [string, string] {
  const p = program({ main: src, ...others });
  return [compileJs(js(src), options), compileJs(js(src), { ...options, props: p.factsOf("main") })];
}

/**
 * Run the compiled modules of a program (each a module body; `main`'s ends in `return { ... }`)
 * with the runtime, `root` in scope: imports of @reactre/core bind to the runtime, and `./x` to
 * module `x`'s exports, which run first, in the order given.
 */
function link<T>(modules: Record<string, string>, root: FakeElement): T {
  const done: Record<string, Record<string, unknown>> = {};
  let out: unknown;
  for (const [name, code] of Object.entries(modules)) {
    const exported = [...scanModule(code).exports].map(([k, e]) => ("local" in e ? `${k}: ${e.local}` : k));
    const body = code
      .replace(/^import \{([^}]*)\} from "(@reactre\/core|\.\/(\w+))";$/gm, (_, names: string, spec: string) =>
        names
          .split(",")
          .map((n) => {
            const [a, b] = n.trim().split(" as ");
            return `const ${b ?? a} = ${spec.startsWith("./") ? `mods.${spec.slice(2)}` : "rr"}.${a};`;
          })
          .join("\n"),
      )
      .replace(/^export /gm, "");
    const tail = name === "main" ? "" : `\nreturn { ${exported.join(", ")} };`;
    const r = new Function("rr", "root", "mods", body + tail)(runtime, root, done) as Record<string, unknown>;
    if (name === "main") out = r;
    else done[name] = r;
  }
  return out as T;
}

/** `src` compiled alone and run (see `link`). */
const run = <T>(src: string, root: FakeElement): T => link<T>({ main: compileJs(js(src)) }, root);

/** Tags and text: enough to compare what was rendered. */
const html = (n: FakeElement): string => {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      out += `<${tag}>${html(c)}</${tag}>`;
    } else out += c.textContent;
  }
  return out;
};

// #endregion

// #region Holes

/** Each case: a module body whose `<div>` holds what the case names, and what it renders. */
const CASES: Record<string, string> = {
  local: `const el = <h1>Hi</h1>; export const App = () => <div>{el}</div>;`,
  fn: `function make() { return <b>b</b>; } export const App = () => <div>{make()}</div>;`,
  ternary: `const a = <i>i</i>, b = <u>u</u>; export const App = () => <div>{on() ? a : b}{on() && a}</div>;`,
  array: `const items = [<li>1</li>, <li>2</li>]; export const App = () => <div>{items}</div>;`,
  method: `const o = { render() { return <b>b</b>; } }; export const App = () => <div>{o.render()}</div>;`,
  arrow: `const mk = () => <i>i</i>; export const App = () => <div>{mk()}</div>;`,
  memo: `import { memo } from "@reactre/core"; const view = memo(() => <p>p</p>); export const App = () => <div>{view()}</div>;`,
  made: `const el = <h1>Hi</h1>; let box; box = { el }; for (const x of [el]) box.x = x; export const App = () => <div>{box.el}</div>;`,
};

describe("a hole that holds JSX", () => {
  test("is inserted, or a slot when it may change, alone and in a whole program", () => {
    for (const [name, src] of Object.entries(CASES)) {
      for (const out of both(src)) {
        expect({ name, text: out.includes("__rrBind(") || /clone\(\[\(/.test(out) }).toEqual({ name, text: false });
        expect({ name, inserted: /__rrInsert\(|__rrSlot\(/.test(out) }).toEqual({ name, inserted: true });
      }
    }
    // What may not change is inserted once; what calls something is a slot.
    expect(both(CASES.local!)[0]).toContain("__rrInsert(__n[0], el, null);");
    expect(both(CASES.array!)[1]).toContain("__rrInsert(__n[0], items, null);");
    expect(both(CASES.fn!)[0]).toContain("__rrSlot(__n[0], () => (make()));");
    expect(both(CASES.ternary!)[1]).toContain(
      "__rrSlot(__n[0], () => (on() ? a : b)); __rrSlot(__n[1], () => (on() && a));",
    );
  });

  test("hydrating, it claims the page's content; on the server, it is content between slot markers", () => {
    for (const [name, src] of Object.entries(CASES)) {
      for (const out of both(src, { hydrate: true }))
        expect({ name, ok: /__rrhI\(|__rrhS\(/.test(out) && !out.includes("__rrBind(") }).toEqual({ name, ok: true });
      for (const out of both(src, { server: true }))
        expect({ name, ok: out.includes("__rrsS(") && !out.includes("__rrsT(") }).toEqual({ name, ok: true });
    }
  });

  test("text, and what the compiler cannot see, stay text holes", () => {
    const src = `
      import { signal } from "@reactre/core";
      const [count] = signal(0);
      const label = "x";
      function fmt(n) { return n + "!"; }
      function row(r) { return <p>{r.f()}</p>; }
      export const App = () => <div>{count()}{label}{fmt(count())}{window.x()}</div>;
    `;
    for (const out of both(src)) expect(out).not.toMatch(/__rrInsert\(|__rrSlot\(/);
  });

  test("a function imported from a module of the program that returns JSX is inserted in a whole program", () => {
    const ui = `
      export function make() { return <b>b</b>; }
      export const el = <i>i</i>;
      export const text = () => "t";
      const own = () => <u>u</u>;
      export { own as renamed };
      export * from "./more";
    `;
    const more = `export const deep = () => <s>s</s>; export default function () { return <p />; }`;
    const src = `
      import { make, el, text, renamed, deep } from "./ui";
      import * as UI from "./ui";
      import pkg from "pkg";
      const mine = make;
      export const App = () => <div>{make()}{el}{text()}{renamed()}{deep()}{UI.make()}{UI.text()}{mine()}{pkg()}</div>;
    `;
    const p = program({ main: src, ui, more });
    expect([...p.factsOf("main").jsx!].sort()).toEqual([
      "App",
      "UI.deep",
      "UI.el",
      "UI.make",
      "UI.renamed",
      "deep",
      "el",
      "make",
      "mine",
      "renamed",
    ]);
    const whole = compileJs(js(src), { props: p.factsOf("main") });
    for (const h of ["make()", "renamed()", "deep()", "UI.make()", "mine()"]) expect(whole).toContain(`() => (${h}));`);
    expect(whole).toContain("__rrInsert(__n[1], el, null);");
    // Text, and a package the program cannot see.
    expect(whole).toContain("__rrBind(__rrT0, 2, __n[2], () => (text()));");
    expect(whole).toContain("__rrBind(__rrT0, 6, __n[6], () => (UI.text()));");
    expect(whole).toContain("__rrBind(__rrT0, 8, __n[8], () => (pkg()));");
    // Alone, the file cannot see what its imports hold: text, which the development build checks
    // (NODE_AS_TEXT); its own local made of one is the import's.
    const alone = compileJs(js(src));
    expect(alone).not.toMatch(/__rrInsert\(|__rrSlot\(/);
  });

  test("the scan: what each local is made of, and the program's names", () => {
    const info = scanModule(
      js(`
        import { x } from "./x";
        import * as N from "./n";
        import { signal } from "@reactre/core";
        import data from "./data.json";
        const el = <b />;
        const a = el, b = x, c = N.y, d = data, e = signal(0), f = 1;
        function g() { return a; }
      `),
    );
    expect(Object.fromEntries(info.jsx)).toEqual({ el: true, a: ["el"], b: ["x"], c: ["N.y"], g: ["a"] });
    // A program that cannot see `./x` and `./n`: none of those hold JSX.
    const p = program({
      main: `import { x } from "pkg"; const el = <b />; const a = el, b = x; function g() { return a; }`,
    });
    expect([...p.factsOf("main").jsx!].sort()).toEqual(["a", "el", "g"]);
    // A module the program does not have, and an import cycle.
    expect([...new Program([]).factsOf("none").jsx!]).toEqual([]);
    const cycle = program({
      main: `import { b } from "./b"; export const a = b;`,
      b: `import { a } from "./main"; export const b = a;`,
    });
    expect([...cycle.factsOf("main").jsx!]).toEqual([]);
  });
});

describe("at runtime, a hole that holds JSX renders its nodes", () => {
  test("a local, a function, an array, a method, an arrow, a memo, and a conditional of locals, which updates", () => {
    const root = new FakeElement("DIV");
    const app = run<{ set: (v: boolean) => void; n: (v: number) => void }>(
      `
      import { memo, render, signal } from "@reactre/core";
      const [on, set] = signal(true);
      const [count, n] = signal(1);
      const el = <h1>Hi</h1>;
      const a = <i>i</i>, b = <u>u</u>;
      function make() { return <b>{count()}</b>; }
      const items = [<li>1</li>, <li>2</li>];
      const o = { render() { return <s>s</s>; } };
      const mk = () => <em>e</em>;
      const view = memo(() => <p>{on() ? "on" : "off"}</p>);
      render(() => <div>{el}{on() ? a : b}{on() && a}{make()}{items}{o.render()}{mk()}{view()}</div>, root);
      return { set, n };
    `,
      root,
    );
    expect(html(root)).toBe("<div><h1>Hi</h1><i>i</i><b>1</b><li>1</li><li>2</li><s>s</s><em>e</em><p>on</p></div>");
    app.set(false);
    expect(html(root)).toBe("<div><h1>Hi</h1><u>u</u><b>1</b><li>1</li><li>2</li><s>s</s><em>e</em><p>off</p></div>");
    app.set(true);
    app.n(2);
    expect(html(root)).toBe("<div><h1>Hi</h1><i>i</i><b>2</b><li>1</li><li>2</li><s>s</s><em>e</em><p>on</p></div>");
  });

  test("a function imported from another module of the program", () => {
    const ui = `import { signal } from "@reactre/core"; export const [n, setN] = signal(1); export function make() { return <b>{n()}</b>; }`;
    const main = `
      import { render } from "@reactre/core";
      import { make, setN } from "./ui";
      render(() => <div>{make()}</div>, root);
      return { setN };
    `;
    const p = program({ main, ui });
    const root = new FakeElement("DIV");
    const app = link<{ setN: (v: number) => void }>(
      {
        ui: compileJs(js(ui), { props: p.factsOf("ui") }),
        main: compileJs(js(main), { props: p.factsOf("main") }),
      },
      root,
    );
    expect(html(root)).toBe("<div><b>1</b></div>");
    app.setN(2);
    expect(html(root)).toBe("<div><b>2</b></div>");
  });

  test("a fragment's expression in an element is inserted: the fix for what the compiler cannot see", () => {
    const root = new FakeElement("DIV");
    const app = run<{ set: (v: unknown) => void }>(
      `
      import { render, signal } from "@reactre/core";
      const nodes = { get: () => document.createElement("i") };
      const [v, set] = signal("a");
      render(() => <div><>{nodes.get()}</><p><>{v()}</></p></div>, root);
      return { set };
    `,
      root,
    );
    expect(html(root)).toBe("<div><i></i><p>a</p></div>");
    app.set(false);
    expect(html(root)).toBe("<div><i></i><p></p></div>");
  });
});

describe("a fragment in an element", () => {
  test("its expressions are inserted, in each build; its text and elements join the template", () => {
    const src = `export const App = () => <div><>x {f()} <b /> {g}</></div>;`;
    for (const out of both(src)) {
      expect(out).toContain(`__rrT(["<div>x "," <b></b> ","</div>"], [-5,-5])`);
      expect(out).toContain("__rrSlot(__n[0], () => (f())); __rrInsert(__n[1], g, null);");
    }
    for (const out of both(src, { server: true })) expect(out).toContain("__rrsS(__rrsL(() => __rrsI(f())))");
    for (const out of both(src, { hydrate: true })) expect(out).toContain("__rrhS(__n[0], () => (f()));");
  });
});

// #endregion

// #region Unnamed components

/** Each form: a component the scan finds no name for, rendered with a reactive prop `n`. */
const UNNAMED_CASES: Record<string, string> = {
  property: `const parts = { default: (props) => <b>{props.n}</b> }; const App = () => <div><parts.default n={count()} /></div>;`,
  method: `const parts = { card(props) { return <b>{props.n}</b>; } }; const App = () => <div><parts.card n={count()} /></div>;`,
  map: `const Cs = [1].map((k) => (props) => <b>{props.n}</b>); const C = Cs[0]; const App = () => <div><C n={count()} /></div>;`,
  returned: `function makeC() { return (props) => <b>{props.n}</b>; } const C = makeC(); const App = () => <div><C n={count()} /></div>;`,
  member: `const ui = {}; ui.card = (props) => <b>{props.n}</b>; const App = () => <div><ui.card n={count()} /></div>;`,
  index: `const ui = {}; ui["card"] = (props) => <b>{props.n}</b>; const C = ui.card; const App = () => <div><C n={count()} /></div>;`,
  ternary: `const C = on ? (props) => <b>{props.n}</b> : (props) => <i>{props.n}</i>; const App = () => <div><C n={count()} /></div>;`,
  hoc: `function withB(Inner) { return (props) => <b>{props.n}<Inner {...props} /></b>; } function Plain(p) { return null; } const C = withB(Plain); const App = () => <div><C n={count()} /></div>;`,
};

describe("a component the scan finds no name for", () => {
  test("is open: a hole that reads its props follows them, alone and in a whole program", () => {
    for (const [name, body] of Object.entries(UNNAMED_CASES)) {
      const src = `import { render, signal } from "@reactre/core"; const on = true; const [count, set] = signal(1); ${body} render(App, root); return { set };`;
      for (const out of both(src)) {
        // The prop's hole is a slot (it may be passed JSX), not the clone's text.
        expect({ name, followed: out.includes("__rrSlot(__n[0], () => (props.n))") }).toEqual({
          name,
          followed: true,
        });
      }
      const root = new FakeElement("DIV");
      const app = run<{ set: (v: number) => void }>(src, root);
      expect({ name, html: html(root) }).toEqual({ name, html: "<div><b>1</b></div>" });
      app.set(2);
      expect({ name, html: html(root) }).toEqual({ name, html: "<div><b>2</b></div>" });
    }
  });

  test("the scan: an unnamed component is a Def of its own, open; a callback, a row and a lowercase local are not", () => {
    const defs = findDefs(
      js(`
        const parts = { a: (props) => <b>{props.n}</b>, b(p) { return <i />; }, c: () => <u />, d: (x) => x };
        items.map((item) => <li>{item.name}</li>);
        const row = (item) => <li>{item.name}</li>;
        const App = () => <ul><For each={xs()}>{(x) => <li>{x}</li>}</For><Card render={(r) => <p>{r}</p>} /></ul>;
        if (ok) { go(); }
      `),
    );
    expect(defs.map((d) => [d.name, d.open])).toEqual([
      [UNNAMED, true],
      [UNNAMED, true],
      ["App", false],
    ]);
  });
});

// #endregion
