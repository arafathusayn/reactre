// Tests of JSX held in values, in @reactre/compiler: a hole that mentions a local made of JSX, a
// function that returns it, an import from the app's own files (a path or an alias, which a file
// alone cannot see into) or a value a package of the program exports that holds JSX is inserted
// (`__insert`, or a slot when it may change), not written as text (`__bind`, or the clone's
// text), in client, hydrate and server builds, for a file alone and in a whole program; a
// fragment's expression in an element is inserted whatever the compiler knows of it; and a
// component the scan finds no name for (an object's property, a member, what a function returns)
// is open, so the holes that read its props follow them. What the scan finds is tested here too
// (`ModuleInfo.jsx`, `PropFacts.jsx`, the unnamed components' `Def`s).

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";

import * as runtime from "../../core/src/index.ts";
import { compileJs, type CompileOptions, transpileSource } from "../src/index.ts";
import { findDefs, moduleFacts, Program, type Resolved, scanModule } from "../src/program.ts";

/** The name the scan gives a component it finds no name for. */
const UNNAMED = "(unnamed)";

beforeEach(installFakeDocument);

// #region Harness

/** A TSX source as the compiler reads it. */
const js = (src: string): string => transpileSource(src);

/**
 * A program of in-memory modules, resolved by their specifiers' names (`./a` is module `a`); a
 * package's specifier leads to the module of that name (`@app/ui`, a workspace's package), if any.
 */
function program(files: Record<string, string>, entries: string[] = ["main"]): Program {
  const p = new Program(entries);
  for (const [file, src] of Object.entries(files)) {
    const code = js(src);
    const resolved = new Map<string, Resolved>(
      scanModule(code).specs.map((s) => [s, s.startsWith("./") ? s.slice(2) : s in files ? s : false]),
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

  test("a value or a function a package of the program exports that holds JSX is inserted in a whole program", () => {
    // `@app/ui` is a package the program resolves into its own modules (a workspace's): it sees
    // what each export holds, through re-exports, its own imports and namespace imports.
    const ui = `
      import { view, label } from "./inner";
      export function make() { return <b>b</b>; }
      export const el = <i>i</i>;
      export const text = () => "t";
      const own = () => <u>u</u>;
      export { own as renamed };
      export const viaView = view, viaLabel = label;
      export { view as viewed, label as labelled } from "./inner";
      export * from "./more";
    `;
    const more = `export const deep = () => <s>s</s>; export default function () { return <p />; }`;
    const inner = `export const view = () => <em />, label = "x";`;
    const src = `
      import { make, el, text, renamed, deep, viaView, viaLabel, viewed, labelled } from "@app/ui";
      import * as UI from "@app/ui";
      import pkg from "pkg";
      const mine = make;
      export const App = () => <div>{make()}{el}{text()}{renamed()}{deep()}{UI.make()}{UI.text()}{mine()}{pkg()}{viaView()}{viaLabel}{viewed()}{labelled}</div>;
    `;
    const p = program({ main: src, "@app/ui": ui, more, inner });
    expect([...p.factsOf("main").jsx!].sort()).toEqual([
      "App",
      "UI.deep",
      "UI.el",
      "UI.make",
      "UI.renamed",
      "UI.viaView",
      "UI.viewed",
      "deep",
      "el",
      "make",
      "mine",
      "renamed",
      "viaView",
      "viewed",
    ]);
    const whole = compileJs(js(src), { props: p.factsOf("main") });
    for (const h of ["make()", "renamed()", "deep()", "UI.make()", "mine()"]) expect(whole).toContain(`() => (${h}));`);
    expect(whole).toContain("__rrInsert(__n[1], el, null);");
    // Text, and a package the program cannot see.
    expect(whole).toContain("__rrBind(__rrT0, 2, __n[2], () => (text()));");
    expect(whole).toContain("__rrBind(__rrT0, 6, __n[6], () => (UI.text()));");
    expect(whole).toContain("__rrBind(__rrT0, 8, __n[8], () => (pkg()));");
    // Alone, the file cannot see what a package's imports hold: text, which the development
    // build checks (NODE_AS_TEXT).
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
    // A module the program does not have, and an import cycle through packages it resolves.
    expect([...new Program([]).factsOf("none").jsx!]).toEqual([]);
    const cycle = program({
      main: `import { b } from "@app/b"; export const a = b;`,
      "@app/b": `import { a } from "main"; export const b = a;`,
    });
    expect([...cycle.factsOf("main").jsx!]).toEqual([]);
  });
});

// #endregion

// #region Imports from the app's own files

/** A module of the app: functions that return JSX, text and a flag, and an object of two. */
const UI = `
  export function make() { return <b>b</b>; }
  export function text() { return "t"; }
  export function flag() { return true; }
  export const obj = { render() { return <i>i</i>; }, label() { return "l"; } };
`;

/** Each case: what the module declares, and a hole that calls a function of `./ui` through it. */
const CALLS: Record<string, [string, string]> = {
  jsx: ["", "make()"],
  text: ["", "text()"],
  flag: ["", "flag()"],
  namespace: ["", "UI.make()"],
  "namespace text": ["", "UI.text()"],
  method: ["", "obj.render()"],
  "method text": ["", "obj.label()"],
  optional: ["", "obj?.label()"],
  computed: ["", `obj["label"]()`],
  conditional: ["", "on() ? text() : null"],
  alias: ["const mine = text;", "mine()"],
  object: ["const o = { text };", "o.text()"],
  result: ["const x = text();", "x.trim()"],
  wrapper: ["function fmt(n) { return text() + n; }", "fmt(1)"],
  arrow: ["const f = () => UI.text();", "f()"],
};

/** What a slot at the `<div>`'s first child is, in each build. */
const SLOT = [
  ["client", {}, /__rrSlot\(__n\[0\], |__rrInsert\(__n\[0\], /],
  ["hydrate", { hydrate: true }, /__rrhS\(__n\[0\], |__rrhI\(__n\[0\], /],
  ["server", { server: true }, /__rrsS\(/],
] as const;

describe("a hole that calls a function of the app's own files", () => {
  test("is a slot alone and in a whole program, which compile it alike, in client, hydrate and server builds", () => {
    for (const [name, [own, hole]] of Object.entries(CALLS)) {
      const src = `import { make, text, flag, obj } from "./ui"; import * as UI from "./ui"; ${own} export const App = () => <div>{${hole}}</div>;`;
      for (const [build, options, slot] of SLOT) {
        const [alone, whole] = both(src, options, { ui: UI });
        expect({ name, build, same: alone === whole, slot: slot.test(alone) }).toEqual({
          name,
          build,
          same: true,
          slot: true,
        });
      }
    }
    // A value made of such a call is a slot too. Alone it is followed, as a store may be (an
    // import's member); the program sees it is none, and inserts it once.
    const [alone, whole] = both(
      `import { text } from "./ui"; const x = text(); export const App = () => <div>{x}</div>;`,
      {},
      { ui: UI },
    );
    expect(alone).toContain("__rrSlot(__n[0], () => (x));");
    expect(whole).toContain("__rrInsert(__n[0], x, null);");
  });

  test("an import from a path or an alias is the app's; a package's, @reactre's and an asset's are as they were", () => {
    const specs: Record<string, boolean> = {
      "./ui": true,
      "../ui": true,
      "/src/ui": true,
      "~/ui": true,
      "@/ui": true,
      "#ui": true,
      $lib: true,
      lib: false,
      "lib/sub": false,
      "@scope/lib": false,
      "@scope/lib/sub": false,
      "node:x": false,
      "virtual:x": false,
      "@reactre/core": false,
      "./a.css": false,
      "./data.json?raw": false,
    };
    for (const [spec, app] of Object.entries(specs)) {
      const src = `import f, { g } from "${spec}"; export const App = () => <div>{f()}{g.h()}</div>;`;
      for (const [build, options, slot] of SLOT) {
        const [alone, whole] = both(src, options);
        expect({ spec, build, same: alone === whole, slot: slot.test(alone) }).toEqual({
          spec,
          build,
          same: true,
          slot: app,
        });
      }
    }
  });
});

/** Each case: what the module declares, and a hole that reads a value of `./ui` through it. */
const VALUES: Record<string, [string, string]> = {
  jsx: ["", "el"],
  text: ["", "label"],
  object: ["", "obj"],
  namespace: ["", "UI.el"],
  "namespace text": ["", "UI.label"],
  conditional: ["", "on() ? el : label"],
  alias: ["const mine = label;", "mine"],
};

describe("a hole that reads a value of the app's own files", () => {
  test("is a slot alone and in a whole program, in client, hydrate and server builds", () => {
    const ui = UI + `export const el = <u>u</u>, label = "x";`;
    for (const [name, [own, hole]] of Object.entries(VALUES)) {
      const src = `import { el, label, obj } from "./ui"; import * as UI from "./ui"; ${own} export const App = () => <div>{${hole}}</div>;`;
      for (const [build, options, slot] of SLOT) {
        const [alone, whole] = both(src, options, { ui });
        expect({ name, build, alone: slot.test(alone), whole: slot.test(whole) }).toEqual({
          name,
          build,
          alone: true,
          whole: true,
        });
      }
    }
    // Alone, such a slot is followed, as an import may be a store; the program sees which are
    // none, and inserts those once. What may change is followed in both.
    const [alone, whole] = both(
      `import { el, obj } from "./ui"; export const App = () => <div>{el}{obj.label}{on() ? el : null}</div>;`,
      {},
      { ui },
    );
    expect(alone).toContain("__rrSlot(__n[0], () => (el)); __rrSlot(__n[1], () => (obj.label));");
    expect(whole).toContain("__rrInsert(__n[0], el, null); __rrInsert(__n[1], obj.label, null);");
    for (const out of [alone, whole]) expect(out).toContain("__rrSlot(__n[2], () => (on() ? el : null));");
  });

  test("the names: each import from the app's own files, and what is made of one, alone and in a whole program", () => {
    const src = `
      import { make } from "./ui";
      import * as N from "~/n";
      import lib from "lib";
      import data from "./data.json";
      const mine = make, f = () => N.x(), m = lib({ fn: () => make() }), z = lib(), w = data.get();
    `;
    const names = ["N.*", "f", "m", "make", "mine"];
    expect([...moduleFacts(js(src)).jsx!].sort()).toEqual(names);
    expect([...program({ main: src, ui: UI }).factsOf("main").jsx!].sort()).toEqual(names);
  });
});

describe("at runtime, a hole that reads the app's own files", () => {
  test("alone, a call of one inserts the function's nodes and writes its text; true, false and null render nothing", () => {
    const ui = `
      import { signal } from "@reactre/core";
      export const [n, setN] = signal(1);
      export function make() { return <b>{n()}</b>; }
      export const text = () => "t" + n();
      export const yes = () => n() > 0, no = () => false, none = () => null;
    `;
    const main = `
      import { render } from "@reactre/core";
      import { make, setN, text, yes, no, none } from "./ui";
      render(() => <div>{make()}{text()}{yes()}{no()}{none()}</div>, root);
      return { setN };
    `;
    const root = new FakeElement("DIV");
    const app = link<{ setN: (v: number) => void }>({ ui: compileJs(js(ui)), main: compileJs(js(main)) }, root);
    expect(html(root)).toBe("<div><b>1</b>t1</div>");
    app.setN(2);
    expect(html(root)).toBe("<div><b>2</b>t2</div>");
  });

  test("alone, a value of one is inserted: an element, an array of them, text", () => {
    const ui = `export const el = <i>i</i>, items = [<li>1</li>, <li>2</li>], label = "x", none = null;`;
    const main = `
      import { render } from "@reactre/core";
      import { el, items, label, none } from "./ui";
      render(() => <div>{el}{items}{label}{none}</div>, root);
      return {};
    `;
    const root = new FakeElement("DIV");
    link({ ui: compileJs(js(ui)), main: compileJs(js(main)) }, root);
    expect(html(root)).toBe("<div><i>i</i><li>1</li><li>2</li>x</div>");
  });
});

// #endregion

// #region Holes at runtime, and fragments

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

describe("template strings are primitive text, even when their inputs may hold content", () => {
  test("imported values become text holes, with signal dependencies and same-key updates preserved", () => {
    const ui = `export const labels = { a: "A", b: "B" };`;
    const main = `
      import { attach, For, signal } from "@reactre/core";
      import { labels } from "./ui";
      const [rows, setRows] = signal([{ id: 1, kind: "a" }]);
      const [suffix, setSuffix] = signal("!");
      const dispose = attach(() => <ul><For each={rows()} key={r => r.id}>{r =>
        <li onClick={() => setSuffix("clicked")}>{\`\${labels[r.kind]}\${suffix()}\`}</li>
      }</For></ul>, root);
      return { setRows, setSuffix, dispose };
    `;
    for (const whole of [false, true]) {
      const p = program({ ui, main });
      const output = compileJs(js(main), whole ? { props: p.factsOf("main") } : undefined);
      // Reactive interpolations keep their per-run owner and dependency tracking.
      expect(output).toContain("__rrForM(");
      const root = new FakeElement("DIV");
      const app = link<{
        setRows(rows: { id: number; kind: string }[]): void;
        setSuffix(s: string): void;
        dispose(): void;
      }>({ ui: compileJs(js(ui)), main: output }, root);
      const row = root.firstChild!.firstChild as FakeElement;
      expect(html(root)).toBe("<ul><li>A!</li></ul>");
      row.dispatchEvent(new FakeEvent("click"));
      expect(html(root)).toBe("<ul><li>Aclicked</li></ul>");
      app.setSuffix("?");
      expect(html(root)).toBe("<ul><li>A?</li></ul>");
      app.setRows([{ id: 1, kind: "b" }]);
      expect(root.firstChild!.firstChild).toBe(row);
      expect(html(root)).toBe("<ul><li>B?</li></ul>");
      app.dispose();
      app.setSuffix("after disposal");
      expect(html(root)).toBe("");
    }
  });

  test("content props coerced to strings retain updates, escaping and primitive values", () => {
    const source = `
      import { attach, signal } from "@reactre/core";
      function Label(props) { return <p>{\`value: \${props.children}\`}</p>; }
      const [value, setValue] = signal(null);
      const dispose = attach(() => <Label>{value()}</Label>, root);
      return { setValue, dispose };
    `;
    const root = new FakeElement("DIV");
    const app = run<{ setValue(v: unknown): void; dispose(): void }>(source, root);
    expect(root.textContent).toBe("value: null");
    app.setValue(false);
    expect(root.textContent).toBe("value: false");
    app.setValue("<b>& text");
    expect(root.textContent).toBe("value: <b>& text");
    expect(root.firstChild!.childNodes.length).toBe(1);
    app.dispose();
  });

  test("static imported labels use the plain keyed list and still replace same-key content", () => {
    const ui = 'export const labels = { a: "A", b: "B" };';
    const main = `import { attach, For, signal } from "@reactre/core";
      import { labels } from "./ui";
      const [rows, setRows] = signal([{ id: 1, kind: "a" }]);
      const dispose = attach(() => <ul><For each={rows()} key={r => r.id}>{r => <li>{\`\${labels[r.kind]}\`}</li>}</For></ul>, root);
      return { setRows, dispose };`;
    const p = program({ ui, main });
    const output = compileJs(js(main), { props: p.factsOf("main") });
    expect(output).not.toContain("__rrForM(");
    const root = new FakeElement("DIV");
    const app = link<{ setRows(rows: { id: number; kind: string }[]): void; dispose(): void }>(
      { ui: compileJs(js(ui)), main: output },
      root,
    );
    const row = root.firstChild!.firstChild;
    app.setRows([{ id: 1, kind: "b" }]);
    expect(root.firstChild!.firstChild).toBe(row);
    expect(root.textContent).toBe("B");
    app.dispose();
    expect(root.textContent).toBe("");
  });

  test("reactive string evaluations retain per-run resource cleanup", () => {
    const ui = `import { onCleanup } from "@reactre/core";
      export const cleaned = [];
      export function value(n) { onCleanup(() => cleaned.push(n)); return n; }`;
    const main = `import { attach, signal } from "@reactre/core";
      import { value, cleaned } from "./ui";
      const [n, setN] = signal(1);
      const dispose = attach(() => <p>{\`\${value(n())}\`}</p>, root);
      return { setN, dispose, cleaned };`;
    const root = new FakeElement("DIV");
    const app = link<{ setN(n: number): void; dispose(): void; cleaned: number[] }>(
      { ui: compileJs(js(ui)), main: compileJs(js(main)) },
      root,
    );
    app.setN(2);
    expect(app.cleaned).toEqual([1]);
    app.dispose();
    expect(app.cleaned).toEqual([1, 2]);
  });

  test("a template at the start of a larger expression does not prove the result is text", () => {
    for (const src of [
      'import { value } from "./ui"; const A = () => <p>{`${value}` && value}</p>;',
      'import { value } from "./ui"; const A = () => <p>{`${value}` ? <b>yes</b> : null}</p>;',
      'import { tag } from "./ui"; const A = () => <p>{tag`x`}</p>;',
    ])
      expect(compileJs(js(src))).toContain("], [-5])");
  });
});
