// Tests of an optional call in @reactre/compiler: `count?.()` calls, as `count()` does, wherever
// the compiler asks whether an expression calls something (a hole's text, an attribute, a class,
// a style, a key, a handler, a component's prop, `<Show>`'s and `<Match>`'s `when`, `<For>`'s
// `each`, a row's holes and their selector keys), so each case compiles to the code its plain call
// does, in client, hydrate and server builds, for a file alone and in a whole program; `?.` that
// no `(` follows reads, and calls nothing. At runtime, such a hole follows its signal.

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as runtime from "../../core/src/index.ts";
import { compileJs, type CompileOptions, transpileSource } from "../src/index.ts";
import { callsOutsideJsx, Program, type Resolved, scanModule } from "../src/program.ts";

beforeEach(installFakeDocument);

// #region Harness

/** A TSX source as the compiler reads it. */
const js = (src: string): string => transpileSource(src);

/** `src` compiled alone, and as module `main` of a program of `src` alone (its imports unseen), with `options`. */
function both(src: string, options: CompileOptions = {}): [string, string] {
  const code = js(src);
  const p = new Program(["main"]);
  p.add("main", code, new Map<string, Resolved>(scanModule(code).specs.map((s) => [s, false])));
  return [compileJs(code, options), compileJs(code, { ...options, props: p.factsOf("main") })];
}

/** The builds each case is compiled for. */
const BUILDS: Record<string, CompileOptions> = { client: {}, hydrate: { hydrate: true }, server: { server: true } };

/**
 * Compile a TSX test source (a module body ending in `return { ... }`) alone and run it with the
 * runtime, `root` in scope. Its imports from @reactre/core become bindings to the runtime.
 */
function run<T>(src: string, root: FakeElement): T {
  const code = compileJs(js(src)).replace(/^import \{([^}]*)\} from "@reactre\/core";$/gm, (_, names: string) =>
    names
      .split(",")
      .map((n) => {
        const [a, b] = n.trim().split(" as ");
        return `const ${b ?? a} = rr.${a};`;
      })
      .join("\n"),
  );
  return new Function("rr", "root", code)(runtime, root) as T;
}

/** Tags, attributes named in `attrs`, and text: enough to compare what was rendered. */
const html = (n: FakeElement, attrs: readonly string[] = []): string => {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      const a = attrs.map((k) => (c.getAttribute(k) === null ? "" : ` ${k}="${c.getAttribute(k)}"`)).join("");
      out += `<${tag}${a}>${html(c, attrs)}</${tag}>`;
    } else out += c.textContent;
  }
  return out;
};

// #endregion

// #region Compiled code

/** What each case's module starts with: a signal, an object holding it, one that may be undefined. */
const HEAD = `
  import { signal, Show, For, Switch, Match, Dynamic } from "@reactre/core";
  import { make } from "./ui";
  import * as ns from "./ui";
  const [count] = signal(0);
  const o = { count, f: { g: count } };
  let maybe = Math.random() > 2 ? undefined : count;
  const rows = [{ l: count }];
  const sel = (x) => x;
`;

/** Each case: a module body whose `?.(` calls, as `(` would. */
const CASES: Record<string, string> = {
  text: `export const App = () => <p>{count?.()}</p>;`,
  member: `export const App = () => <p>{o.count?.()}</p>;`,
  chain: `export const App = () => <p>{o.f?.g?.()}</p>;`,
  nullish: `export const App = () => <p>{o?.f ?? maybe?.()}</p>;`,
  operand: `export const App = () => <p>{maybe?.() + 1}</p>;`,
  template: "export const App = () => <p>{`n ${maybe?.()}`}</p>;",
  attribute: `export const App = () => <p title={maybe?.()} />;`,
  property: `export const App = () => <input value={maybe?.()} />;`,
  classToggle: `export const App = () => <p class={{ on: maybe?.() }} />;`,
  classList: `export const App = () => <p class={["a", maybe?.()]} />;`,
  style: `export const App = () => <p style={{ color: maybe?.() }} />;`,
  handler: `export const App = () => <p onClick={o.f?.g?.()} />;`,
  key: `export const App = () => <p key={maybe?.()}>x</p>;`,
  prop: `function C(props) { return <p title={props.n}>{props.children}</p>; } export const App = () => <C n={o.f?.g?.()}>{maybe?.()}</C>;`,
  readProp: `function C({ children, n }) { return <p title={n?.()}>{children?.()}{make?.()}</p>; } export const App = () => <C n={count}>{() => <i />}</C>;`,
  show: `export const App = () => <Show when={maybe?.()} fallback={<i>{maybe?.()}</i>}><p>on</p></Show>;`,
  keyed: `export const App = () => <Show when={maybe?.()} keyed>{(v) => <p>{v}</p>}</Show>;`,
  match: `export const App = () => <Switch><Match when={maybe?.()}><p>a</p></Match></Switch>;`,
  dynamic: `export const App = () => <Dynamic component={maybe?.() ? "b" : "i"} />;`,
  each: `const list = () => [1]; export const App = () => <ul><For each={list?.()} key={(r) => r}>{(r) => <li>{r}</li>}</For></ul>;`,
  eachOutside: `const list = () => [1]; export const App = () => <For each={list?.()} key={(r) => r}>{(r) => <li>{r}</li>}</For>;`,
  row: `export const App = () => <ul><For each={rows} key={(r) => r}>{(r) => <li title={r.l?.()}>{r.l?.()}</li>}</For></ul>;`,
  selectors: `export const App = () => <ul><For each={rows} key={(r) => r}>{(r) => <li class={sel?.(r)}>{sel?.(r.l)}</li>}</For></ul>;`,
  appCall: `const x = make?.(); const mine = () => ns.make?.(); export const App = () => <p>{x}{mine?.()}{ns.make?.()}</p>;`,
};

describe("an optional call", () => {
  test("compiles as its plain call, in client, hydrate and server builds, alone and in a whole program", () => {
    for (const [name, body] of Object.entries(CASES)) {
      for (const [build, options] of Object.entries(BUILDS)) {
        const optional = both(HEAD + body, options);
        const plain = both(HEAD + body.replaceAll("?.(", "("), options);
        expect({ name, build, code: optional.map((c) => c.replaceAll("?.(", "(")) }).toEqual({
          name,
          build,
          code: plain,
        });
        // A dev server and a build compile it alike; but for a value of the app's own files
        // (`x`), which the whole program inserts once where it sees no store, as before.
        const same = optional[0] === optional[1];
        expect({ name, build, same }).toEqual({ name, build, same: name !== "appCall" });
      }
    }
  });

  test("a hole of one is bound, a prop of one is a getter, a `when` of one is a memo", () => {
    for (const out of both(HEAD + CASES.text!))
      expect(out).toContain("__rrBind(__rrT0, 0, __n[0], () => (count?.()));");
    for (const out of both(HEAD + CASES.text!, { hydrate: true }))
      expect(out).toContain("__rrBind(__rrT0, 0, __n[0], () => (count?.()));");
    for (const out of both(HEAD + CASES.text!, { server: true }))
      expect(out).toContain("__rrsL(() => __rrsT((count?.()), 0))");
    for (const out of both(HEAD + CASES.attribute!)) expect(out).toContain("() => (maybe?.())");
    const prop = `function C(props) { return <p>{props.n}</p>; } export const App = () => <C n={maybe?.()} />;`;
    for (const out of both(HEAD + prop)) expect(out).toContain("get n() { return maybe?.(); }");
    for (const out of both(HEAD + CASES.show!)) expect(out).toContain("__rrMemo(() => !!(maybe?.()))");
    // A row's hole that calls is re-run, not written once.
    for (const out of both(HEAD + CASES.row!))
      expect(out).toContain("dyn: (r, __d) => { __d[0] = (r.l?.()); __d[1] = (r.l?.()); }");
  });

  test("`?.` that no `(` follows reads, and calls nothing, as `.` and `[` do", () => {
    const reads = `
      const o = { f: { g: 1 } }, k = "f", a = [1];
      export const App = () => <p title={o?.f}>{o?.f.g}{o?.[k]}{[...(a)]}{o ? .5 : (1)}{o ?? (1)}</p>;
    `;
    for (const [build, options] of Object.entries(BUILDS))
      for (const out of both(reads, options)) {
        const app = out.split("\n").find((l) => l.includes("App ="))!;
        expect({ build, written: /\[\(o\?\.f\), \(o\?\.f\.g\)|__rrsH\(/.test(app) }).toEqual({ build, written: true });
        expect({ build, bound: /__rrBind\(|__rrhB\(|__rrApply\(|__rrsL\(/.test(app) }).toEqual({ build, bound: false });
      }
  });

  test("the scan of a prop's value: `?.(` calls", () => {
    const h = new Set(["jsx_aaaaaaaa"]);
    expect(callsOutsideJsx(`count?.()`, h)).toBe(true);
    expect(callsOutsideJsx(`o.f?.g?.(1)`, h)).toBe(true);
    expect(callsOutsideJsx(`o?.f ?? maybe?.()`, h)).toBe(true);
    expect(callsOutsideJsx(`o?.f ?? o?.[k]`, h)).toBe(false);
    expect(callsOutsideJsx(`[...(a)]`, h)).toBe(false);
    expect(callsOutsideJsx(`() => count?.()`, h)).toBe(false);
  });
});

// #endregion

// #region At runtime

describe("at runtime, an optional call", () => {
  test("a hole's text, an attribute, a prop and a `when` of one follow the signal", () => {
    const root = new FakeElement("DIV");
    const app = run<{ set: (v: number) => void; swap: (f: (() => number) | undefined) => void }>(
      `
      import { render, Show, signal } from "@reactre/core";
      const [count, set] = signal(1);
      const [fn, setFn] = signal(count);
      const o = { count };
      function Label(props) { return <b>{props.n}</b>; }
      render(() => (
        <div title={count?.()}>
          {count?.()}|{o.count?.()}|{fn()?.() ?? "none"}|<Label n={count?.()} />
          <Show when={count?.() > 1}><i>big</i></Show>
        </div>
      ), root);
      return { set, swap: (f) => setFn(() => f) };
    `,
      root,
    );
    expect(html(root, ["title"])).toBe(`<div title="1">1|1|1|<b>1</b></div>`);
    app.set(2);
    expect(html(root, ["title"])).toBe(`<div title="2">2|2|2|<b>2</b><i>big</i></div>`);
    app.swap(undefined);
    expect(html(root, ["title"])).toBe(`<div title="2">2|2|none|<b>2</b><i>big</i></div>`);
    app.set(0);
    expect(html(root, ["title"])).toBe(`<div title="0">0|0|none|<b>0</b></div>`);
  });

  test("a row's hole of one follows the signal", () => {
    const root = new FakeElement("DIV");
    const app = run<{ set: (v: number) => void }>(
      `
      import { For, render, signal } from "@reactre/core";
      const [count, set] = signal(1);
      const rows = [{ id: 1, l: count }, { id: 2 }];
      render(() => <ul><For each={rows} key={(r) => r.id}>{(r) => <li>{r.l?.() ?? "-"}</li>}</For></ul>, root);
      return { set };
    `,
      root,
    );
    expect(html(root)).toBe("<ul><li>1</li><li>-</li></ul>");
    app.set(5);
    expect(html(root)).toBe("<ul><li>5</li><li>-</li></ul>");
  });
});

// #endregion
