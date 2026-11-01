// Hydration (@reactre/core/features/hydrate), on the unbundled runtime: a TSX source rendered with
// @reactre/core/server's renderToString (`hydrate: true`), its HTML parsed into the fake DOM, then
// the same source compiled with @reactre/compiler's hydrate mode and hydrated over it. Each test
// checks that the server's nodes are kept (the same objects), that updates work after, and that
// handlers, refs and effects are attached. Mismatches, and what hydration needs (the hydrate
// compile mode, a page with markers), are tested too.
//
// A context's provider, <Errored> and <Loading> build their content with the core's `__frag`, which
// claims only in a hydrate build, where the bundler plugin points the feature modules at
// @reactre/core/features/hydrate: they are tested through real builds at the end of this file,
// and in packages/plugin/test/ssr.test.ts. Here the async runtime is turned on before the tests
// and off after them, as in server.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { compileSource, ReactreCompileError, reactreCompiler } from "@reactre/compiler";
import { FakeComment, FakeElement, FakeEvent, type FakeNode, FakeText, installFakeDocument } from "@reactre/testdom";

import * as asyncApi from "../src/features/async.ts";
import { __hooks } from "../src/features/async.ts";
import { configureClientErrors } from "../src/features/errors.ts";
import * as hydrateApi from "../src/features/hydrate.ts";
import * as indexApi from "../src/features/index.ts";
import * as hydrateAsync from "../src/hydrate/async.ts";
import * as hydrateErrors from "../src/hydrate/errors.ts";
import * as core from "../src/index.ts";
import * as server from "../src/server.ts";
import * as serverAsync from "../src/server/async.ts";
import * as serverErrors from "../src/server/errors.ts";

// #region Harness

let body: FakeElement;

beforeAll(() => core.__installAsync(__hooks));
afterAll(() => {
  core.__installAsync(false);
  installFakeDocument();
});
beforeEach(() => {
  installFakeDocument();
  body = new FakeElement("BODY");
  Object.assign(globalThis.document, {
    body,
    createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
  });
});
afterEach(() => configureClientErrors({}));

/** What a server-compiled source's imports bind to, by specifier. */
const serverModules: Record<string, unknown> = {
  "@reactre/core/server": server,
  "@reactre/core/server/async": serverAsync,
  "@reactre/core/server/errors": serverErrors,
  "@reactre/core/features/hydrate": hydrateApi,
};
/** What a source compiled for hydration imports. */
const clientModules: Record<string, unknown> = {
  "@reactre/core": core,
  "@reactre/core/features/hydrate": hydrateApi,
  "@reactre/core/features/index": indexApi,
  "@reactre/core/features/async": asyncApi,
  "@reactre/core/hydrate/async": hydrateAsync,
  "@reactre/core/hydrate/errors": hydrateErrors,
  "@reactre/core/server": { isServer: false },
};

/** Run compiled module `js` (a body ending in `return { ... }`), its imports bound to `modules`. */
function load<T>(js: string, modules: Record<string, unknown>): T {
  const code = js
    .replace(/^(\s*)export /gm, "$1")
    .replace(/^import "[^"]*";/gm, "")
    .replace(/import \{([^}]*)\} from "(@reactre\/core[^"]*)";/g, (_, names: string, from: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr[${JSON.stringify(from)}].${a};`;
        })
        .join("\n"),
    );
  return new Function("rr", code)(modules) as T;
}

/** A TSX module body ending in `return { ... }`, compiled for the server and run. */
const ssr = <T>(src: string): T => load<T>(compileSource(src, "tsx", { server: true }), serverModules);
/** The same, compiled for hydration. */
const hyd = <T>(src: string): T => load<T>(compileSource(src, "tsx", { hydrate: true }), clientModules);

/** Every node under `n`, in document order. */
function all(n: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  for (let c = n.firstChild; c !== null; c = c.nextSibling) out.push(c, ...all(c));
  return out;
}

/** The markup of `n`'s children, without comments, as the page shows it. */
function shown(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const attrs = c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += `<${c.tagName.toLowerCase()}${attrs}>${shown(c)}</${c.tagName.toLowerCase()}>`;
    } else if (c instanceof FakeText) out += c.data;
  }
  return out;
}

/** What `page` returns: the root, the client module, and what hydration kept. */
interface Page<T> {
  root: FakeElement;
  app: T;
  /** The elements and text nodes the server rendered. */
  before: FakeNode[];
  dispose: () => void;
}

/**
 * Render `src`'s `App` on the server with the markers, parse it into a root in the body, and
 * hydrate it with the same source compiled for hydration.
 */
function page<T extends { App: () => unknown }>(src: string, html?: (h: string) => string): Page<T> {
  const h = server.renderToString(ssr<T>(src).App, { hydrate: true });
  const root = new FakeElement("DIV");
  body.appendChild(root);
  root.innerHTML = html === undefined ? h : html(h);
  const before = all(root).filter((n) => n.nodeType !== 8);
  const app = hyd<T>(src);
  const dispose = hydrateApi.hydrate(app.App, root as unknown as Element);
  return { root, app, before, dispose };
}

/** Whether every node of `nodes` is still in `root`. */
const kept = (root: FakeNode, nodes: FakeNode[]): boolean => {
  const now = new Set(all(root));
  return nodes.every((n) => now.has(n));
};

const click = (el: FakeNode): void => void (el as FakeElement).dispatchEvent(new FakeEvent("click"));

/** The first element under `n` with tag `tag`. */
const find = (n: FakeNode, tag: string): FakeElement =>
  all(n).find((x) => x instanceof FakeElement && x.tagName === tag.toUpperCase()) as FakeElement;

// #endregion

describe("templates", () => {
  test("elements, attributes, classes and text holes keep the server's nodes; holes update, handlers and refs attach", () => {
    const p = page<{ App: () => unknown; set: (n: number) => void; refs: unknown[] }>(`
      import { effect, signal } from "@reactre/core";
      const [n, set] = signal(1);
      const refs = [];
      const ran = [];
      const App = () => {
        effect(() => ran.push(n()));
        return (
          <div id="main" class={n() > 1 ? "big" : "small"} data-n={n()} ref={(e) => refs.push(e)} onClick={() => set(n() + 1)}>
            <p>a {n()} b {n() * 10}{n() + 100}</p>
            <p>{""}after</p>
            <span title={"t" + n()}>{n() > 5 ? "many" : ""}</span>
            <textarea value={"v" + n()} />
          </div>
        );
      };
      return { App, set, refs, ran };
    `);
    const { root, before, app } = p;
    expect(kept(root, before)).toBe(true);
    const div = root.firstChild as FakeElement;
    expect(app.refs).toEqual([div]);
    expect(shown(root)).toBe(
      '<div class="small" id="main" data-n="1"><p>a 1 b 10101</p><p>after</p><span title="t1"></span><textarea>v1</textarea></div>',
    );
    // A textarea's text is the server's value; the client sets the property.
    expect((find(root, "textarea") as unknown as { value: string }).value).toBe("v1");
    click(div);
    expect(shown(root)).toBe(
      '<div class="big" id="main" data-n="2"><p>a 2 b 20102</p><p>after</p><span title="t2"></span><textarea>v1</textarea></div>',
    );
    expect((find(root, "textarea") as unknown as { value: string }).value).toBe("v2");
    expect(kept(root, before)).toBe(true);
    expect((p.app as unknown as { ran: number[] }).ran).toEqual([1, 2]);
  });

  test("a constant value the page does not have is written", () => {
    const p = page<{ App: () => unknown }>(
      `const App = () => <p title={"t" + 1} class={"c" + 1}>{"x" + 1}</p>; return { App };`,
      (h) => h.replace('title="t1"', 'title="other"').replace('class="c1"', 'class="z"').replace("x1", "y"),
    );
    expect(shown(p.root)).toBe('<p class="c1" title="t1">x1</p>');
    expect(kept(p.root, p.before)).toBe(true);
  });

  test("isHydrating is true while hydrate runs; the disposer stops the view and empties the root", () => {
    const p = page<{ App: () => unknown; set: (n: number) => void; seen: boolean[]; runs: () => number }>(`
      import { effect, signal } from "@reactre/core";
      import { isHydrating } from "@reactre/core/features/hydrate";
      const [n, set] = signal(1);
      const seen = [];
      let r = 0;
      const App = () => {
        seen.push(isHydrating());
        effect(() => (n(), r++));
        return <b>{n()}</b>;
      };
      return { App, set, seen, runs: () => r };
    `);
    expect(p.app.seen).toEqual([true]);
    expect(hydrateApi.isHydrating()).toBe(false);
    p.dispose();
    expect(p.root.firstChild).toBe(null);
    p.app.set(2);
    expect(p.app.runs()).toBe(1);
  });
});

describe("slots", () => {
  test("components, expressions that hold JSX, <Show>, <Switch>, <Dynamic> and keyed elements claim their content", () => {
    const p = page<{ App: () => unknown; set: (n: number) => void; clicks: () => number }>(`
      import { Dynamic, Match, Show, signal, Switch } from "@reactre/core";
      const [n, set] = signal(1);
      let c = 0;
      const Item = (props) => <i onClick={() => c++}>{props.label}{n()}</i>;
      const App = () => (
        <main>
          <Item label="item" />
          {n() > 1 ? <b>big</b> : <s>small</s>}
          <Show when={n() === 1} fallback={<u>not one</u>}>{"one "}<b>{n()}</b></Show>
          <Show when={n()} keyed>{(v) => <em>{v}</em>}</Show>
          <Switch fallback={<p>other</p>}>
            <Match when={n() === 1}><p>first</p></Match>
            <Match when={n() === 2}><p>second</p></Match>
          </Switch>
          <Dynamic component={n() > 1 ? "h2" : "h1"} class="t"><b>title</b></Dynamic>
          <Dynamic component={Item} label="dyn" />
          <p key={n()}>keyed</p>
          {[<a>x</a>, "y", null]}
        </main>
      );
      return { App, set, clicks: () => c };
    `);
    const { root, before, app } = p;
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toBe(
      '<main><i>item1</i><s>small</s>one <b>1</b><em>1</em><p>first</p><h1 class="t"><b>title</b></h1><i>dyn1</i><p>keyed</p><a>x</a>y</main>',
    );
    click(find(root, "i"));
    expect(app.clicks()).toBe(1);
    const h1 = find(root, "h1");
    app.set(2);
    expect(shown(root)).toBe(
      '<main><i>item2</i><b>big</b><u>not one</u><em>2</em><p>second</p><h2 class="t"><b>title</b></h2><i>dyn2</i><p>keyed</p><a>x</a>y</main>',
    );
    expect(h1.parentNode).toBe(null);
    // The parts that did not change are the server's still.
    expect(before.includes(find(root, "i"))).toBe(true);
    expect(before.includes(find(root, "a"))).toBe(true);
  });

  test("fragments, standalone control flow and a <Portal>, whose children are built in its mount", () => {
    const p = page<{ App: () => unknown; set: (n: number) => void }>(`
      import { Portal, Show, signal } from "@reactre/core";
      const [n, set] = signal(1);
      const Pair = () => <>start {"x"}<b>{n()}</b>{n() > 1 ? <i>more</i> : null}end</>;
      const Alone = () => <Show when={n() > 1} fallback={<s>no</s>}><u>yes</u></Show>;
      const Away = () => <Portal><p>away {n()}</p></Portal>;
      const App = () => (
        <main>
          <Pair />
          <Alone />
          <Away />
          <div><Portal mount={document.body}><b>in body</b></Portal>after</div>
        </main>
      );
      return { App, set };
    `);
    const { root, before, app } = p;
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toBe("<main>start x<b>1</b>end<s>no</s><div>after</div></main>");
    expect(shown(body)).toContain("<p>away 1</p><b>in body</b>");
    app.set(2);
    expect(shown(root)).toBe("<main>start x<b>2</b><i>more</i>end<u>yes</u><div>after</div></main>");
    expect(shown(body)).toContain("<p>away 2</p>");
  });
});

describe("lists", () => {
  test("<For> rows are the server's, in order; updates add, move and remove them; row handlers are delegated", () => {
    const p = page<{ App: () => unknown; set: (r: unknown[]) => void; picked: () => unknown }>(`
      import { For, signal } from "@reactre/core";
      const [rows, set] = signal([{ id: 1, t: "a" }, { id: 2, t: "b" }, { id: 3, t: "c" }]);
      let picked = null;
      const App = () => (
        <ul><For each={rows()} key={(r) => r.id}>{(r) => <li class={r.t} onClick={() => (picked = r.id)}>{r.t} {r.id}</li>}</For></ul>
      );
      return { App, set, picked: () => picked };
    `);
    const { root, before, app } = p;
    expect(kept(root, before)).toBe(true);
    const lis = all(root).filter((n) => n instanceof FakeElement && n.tagName === "LI");
    expect(shown(root)).toBe('<ul><li class="a">a 1</li><li class="b">b 2</li><li class="c">c 3</li></ul>');
    click(lis[1]!);
    expect(app.picked()).toBe(2);
    app.set([
      { id: 3, t: "c" },
      { id: 1, t: "A" },
      { id: 4, t: "d" },
    ]);
    expect(shown(root)).toBe('<ul><li class="c">c 3</li><li class="A">A 1</li><li class="d">d 4</li></ul>');
    const now = all(root).filter((n) => n instanceof FakeElement && n.tagName === "LI");
    expect([now[0], now[1]]).toEqual([lis[2]!, lis[0]!]);
  });

  test("rows with mounts, a list with a fallback, <For keyed={false}> and <Repeat>", () => {
    const p = page<{ App: () => unknown; set: (r: string[]) => void; setK: (n: number) => void }>(`
      import { For, Repeat, signal } from "@reactre/core";
      const [items, set] = signal(["a", "b"]);
      const [k, setK] = signal(2);
      const Tag = (props) => <b>{props.v}</b>;
      const App = () => (
        <main>
          <ul><For each={items()} key={(s) => s}>{(s) => <li><Tag v={s} />{s === "a" ? <i>first</i> : null}</li>}</For></ul>
          <ol><For each={items()} key={(s) => s} fallback={<li>none</li>}>{(s) => <li>{s}</li>}</For><li>last</li></ol>
          <p><For each={items()} keyed={false}>{(s, i) => <span>{i}:{s()}</span>}</For></p>
          <div><Repeat count={k()} from={1}>{(i) => <a>{i}</a>}</Repeat></div>
        </main>
      );
      return { App, set, setK };
    `);
    const { root, before, app } = p;
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toBe(
      "<main><ul><li><b>a</b><i>first</i></li><li><b>b</b></li></ul><ol><li>a</li><li>b</li><li>last</li></ol><p><span>0:a</span><span>1:b</span></p><div><a>1</a><a>2</a></div></main>",
    );
    app.set([]);
    expect(shown(root)).toBe(
      "<main><ul></ul><ol><li>none</li><li>last</li></ol><p></p><div><a>1</a><a>2</a></div></main>",
    );
    app.set(["c"]);
    app.setK(3);
    expect(shown(root)).toBe(
      "<main><ul><li><b>c</b></li></ul><ol><li>c</li><li>last</li></ol><p><span>0:c</span></p><div><a>1</a><a>2</a><a>3</a></div></main>",
    );
  });

  test("a list with no rows on the server claims none; one whose rows are only on the server loses them", () => {
    const p = page<{ App: () => unknown; set: (r: string[]) => void }>(
      `
      import { For, signal } from "@reactre/core";
      import { isServer } from "@reactre/core/server";
      const [items, set] = signal(isServer ? ["a"] : []);
      const App = () => <ul><For each={items()} key={(s) => s} fallback={<li>none</li>}>{(s) => <li>{s}</li>}</For></ul>;
      return { App, set };
    `,
    );
    expect(shown(p.root)).toBe("<ul><li>none</li></ul>");
    p.app.set(["b"]);
    expect(shown(p.root)).toBe("<ul><li>b</li></ul>");
  });
});

describe("mismatches", () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const SRC = `
    import { For, signal } from "@reactre/core";
    const [n, set] = signal(1);
    const Inner = () => <p>inner {n()}</p>;
    const App = () => (
      <main>
        <h1>{n()}</h1>
        {n() > 0 ? <Inner /> : null}
        <ul><For each={[1, 2, 3]} key={(x) => x}>{(x) => <li>{x}</li>}</For></ul>
      </main>
    );
    return { App, set };
  `;

  test("in a slot: the slot renders afresh, the rest is the server's, and the development build warns", () => {
    const p = page<{ App: () => unknown; set: (n: number) => void }>(SRC, (h) => h.replace("<p>inner", "<div>inner"));
    expect(shown(p.root)).toBe("<main><h1>1</h1><p>inner 1</p><ul><li>1</li><li>2</li><li>3</li></ul></main>");
    expect(p.before.includes(find(p.root, "h1"))).toBe(true);
    expect(p.before.includes(find(p.root, "p"))).toBe(false);
    expect(String(warn.mock.calls[0]![0])).toStartWith(
      "reactre HYDRATION_MISMATCH: the page has <div> where a slot renders something else",
    );
    p.app.set(2);
    expect(shown(p.root)).toBe("<main><h1>2</h1><p>inner 2</p><ul><li>1</li><li>2</li><li>3</li></ul></main>");
  });

  test("in a list: the rows from the first that does not match are built afresh", () => {
    const p = page<{ App: () => unknown }>(SRC, (h) => h.replace("<li>2</li>", "<b>2</b>"));
    expect(shown(p.root)).toBe("<main><h1>1</h1><p>inner 1</p><ul><li>1</li><li>2</li><li>3</li></ul></main>");
    const lis = all(p.root).filter((n) => n instanceof FakeElement && n.tagName === "LI");
    expect([p.before.includes(lis[0]!), p.before.includes(lis[1]!)]).toEqual([true, false]);
    expect(String(warn.mock.calls[0]![0])).toContain("the page has <b> where a <For> row renders something else");
  });

  test("outside every slot: the app renders afresh; text and a missing node are found too", () => {
    let p = page<{ App: () => unknown }>(SRC, (h) => h.replace("<h1>", "<h2>").replace("</h1>", "</h2>"));
    expect(shown(p.root)).toBe("<main><h1>1</h1><p>inner 1</p><ul><li>1</li><li>2</li><li>3</li></ul></main>");
    expect(p.before.includes(find(p.root, "main"))).toBe(false);
    expect(String(warn.mock.calls[0]![0])).toContain("the page has <h2> where the app renders something else");
    // Text before the app's element is passed over; a node missing is a mismatch.
    p = page<{ App: () => unknown }>(SRC, (h) => "text" + h.replace(/<ul>.*<\/ul>/, ""));
    expect(String(warn.mock.calls[1]![0])).toContain("the page has nothing where the app");
    expect(shown(p.root)).toBe("<main><h1>1</h1><p>inner 1</p><ul><li>1</li><li>2</li><li>3</li></ul></main>");
    p = page<{ App: () => unknown }>(`const App = () => <p>{"" + 1} static</p>; return { App };`, (h) =>
      h.replace(" static", " other"),
    );
    expect(String(warn.mock.calls[2]![0])).toContain('the page has the text " other" where the app');
    p = page<{ App: () => unknown }>(SRC, (h) => h.replace("<!--]-->", "<!--x-->"));
    expect(String(warn.mock.calls[3]![0])).toContain("the page has <!--[--> where");
    expect(shown(p.root)).toBe("<main><h1>1</h1><p>inner 1</p><ul><li>1</li><li>2</li><li>3</li></ul></main>");
  });
});

describe("what hydration needs", () => {
  test("code compiled without the hydrate mode: hydrate throws, naming the plugin's option", () => {
    const html = server.renderToString(ssr<{ App: () => unknown }>(`const App = () => <p>x</p>; return { App };`).App, {
      hydrate: true,
    });
    const root = new FakeElement("DIV");
    root.innerHTML = html;
    const app = load<{ App: () => unknown }>(compileSource(`const App = () => <p>x</p>; return { App };`), {
      "@reactre/core": core,
    });
    expect(() => hydrateApi.hydrate(app.App, root as unknown as Element)).toThrow(
      "@reactre/plugin's `hydrate: true` option",
    );
    expect(shown(root)).toBe("<p>x</p>");
    // Text only claims nothing, and needs nothing claimed.
    hydrateApi.hydrate(() => "x", root as unknown as Element);
  });

  test("compiling a file that imports hydrate without the hydrate mode fails; with it, it compiles", () => {
    const src = `import { hydrate } from "@reactre/core/features/hydrate"; hydrate(() => <p />, document.body);`;
    expect(() => compileSource(src)).toThrow(ReactreCompileError);
    expect(() => compileSource(src)).toThrow("@reactre/plugin's `hydrate: true` option");
    expect(() =>
      compileSource(`import { isHydrating as h } from "@reactre/core/features/hydrate"; h();`),
    ).not.toThrow();
    expect(compileSource(src, "tsx", { hydrate: true })).toContain('from "@reactre/core/features/hydrate"');
    // A server build may import it: it renders, and never hydrates.
    expect(() => compileSource(src, "tsx", { server: true })).not.toThrow();
  });

  test("HTML rendered without the markers: a mismatch outside every slot throws, naming renderToString's option", () => {
    const src = `
      import { signal } from "@reactre/core";
      const [n] = signal(1);
      const App = () => <main>{n() > 0 ? <b>b</b> : null}</main>;
      return { App };
    `;
    const root = new FakeElement("DIV");
    root.innerHTML = server.renderToString(ssr<{ App: () => unknown }>(src).App);
    expect(() => hydrateApi.hydrate(hyd<{ App: () => unknown }>(src).App, root as unknown as Element)).toThrow(
      "renderToString(app, { hydrate: true })",
    );
    expect(shown(root)).toBe("<main><b>b</b></main>");
    // A page with nothing that needs a marker hydrates without any.
    root.innerHTML = "<p>x</p>";
    const p = root.firstChild;
    hydrateApi.hydrate(
      hyd<{ App: () => unknown }>(`const App = () => <p>x</p>; return { App };`).App,
      root as unknown as Element,
    );
    expect(root.firstChild).toBe(p);
  });
});

describe("the runtime's helpers", () => {
  test("a clone's anchors are the core's slot, insert and list; content of strings and nodes is put in place", () => {
    const t = core.__template(["<div>", "", "</div>"], [-5, -5]);
    const n: unknown[] = [];
    const r = hydrateApi.__hclone(t, ["", ""], n) as unknown as FakeElement;
    hydrateApi.__hslot(n[0] as Node, () => "a");
    hydrateApi.__hinsert(n[1] as Node, () => "b");
    expect(r.textContent).toBe("ab");
    const u = core.__template(["<ul>", "</ul>"], [-5]);
    const m: unknown[] = [];
    const ul = hydrateApi.__hclone(u, [""], m) as unknown as FakeElement;
    const row = core.__template(["<li>", "</li>"], [-1]);
    const spec = {
      each: () => ["x", "y"],
      key: (s: string) => s,
      t: row,
      fill: (s: string, v: unknown[]) => (v[0] = s),
      holes: [0],
    };
    hydrateApi.__hfor(core.__for, m[0] as Node, spec, 1);
    expect(shown(ul)).toBe("<li>x</li><li>y</li>");
    expect(hydrateApi.__frag(["a", () => "b"], []).map((x) => x.textContent)).toEqual(["a", "b", ""]);
    expect(hydrateApi.__frag([() => "c", "d"], [0]).map((x) => x.textContent)).toEqual(["c", "d"]);
    const el = hydrateApi.__hel("svg", 1) as unknown as FakeElement;
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    hydrateApi.__hkids(el as unknown as Element, () => "kid");
    expect(el.textContent).toBe("kid");
    expect(hydrateApi.__htemplate(t, [0])).toBe(t);
  });

  test("put: what is between a pair becomes the value's nodes; strings take the text there", () => {
    const root = new FakeElement("DIV");
    body.appendChild(root);
    root.innerHTML = "<!--[-->old<b></b><i></i><!--]-->";
    const b = root.childNodes[2]!,
      i = root.childNodes[3]!;
    hydrateApi.__seek(null);
    hydrateApi.__hslot(root.lastChild as unknown as Node, () => ["new", i, document.createTextNode("t")]);
    expect(shown(root)).toBe("new<i></i>t");
    expect(b.parentNode).toBe(null);
    expect(hydrateApi.__cursor()).toBe(null);
    expect(hydrateApi.__close(root.firstChild as unknown as Node)).toBe(root.lastChild as unknown as Node);
    expect(hydrateApi.__open(root.lastChild as unknown as Node)).toBe(root.firstChild as unknown as Node);
    expect(() => hydrateApi.__close(root.lastChild as unknown as Node)).toThrow("does not match");
    expect(() => hydrateApi.__open(root.firstChild as unknown as Node)).toThrow("does not match");
    expect(new FakeComment("x").data).toBe("x");
  });

  test("__claim: a mismatch runs it again afresh, and warns; anything else thrown goes on; a string the page lacks is new text", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const root = new FakeElement("DIV");
    root.innerHTML = "<i></i>tail";
    const t = core.__template(["<b>", "</b>"], [-1]);
    const got = hydrateApi.__claim(root.firstChild as unknown as Node, () => hydrateApi.__hclone(t, ["x"]), "a test");
    expect((got as unknown as FakeElement).tagName).toBe("B");
    expect(String(warn.mock.calls[0]![0])).toContain("where a test renders something else");
    warn.mockRestore();
    expect(() =>
      hydrateApi.__claim(
        null,
        () => {
          throw new Error("other");
        },
        "",
      ),
    ).toThrow("other");
    hydrateApi.__seek(root.lastChild as unknown as Node);
    const [text] = hydrateApi.__frag(["head"]);
    expect([text!.textContent, root.lastChild!.textContent]).toEqual(["head", "tail"]);
    hydrateApi.__seek(null);
  });
});

describe("the hydrate builds of <Loading> and <Errored>", () => {
  // The unbundled runtime builds a boundary's content with the core's `__frag`, which moves what it
  // claims: these check what each boundary does with the server's markers, and the built apps
  // below check that the nodes stay where they are.
  const P = core.__template(["<p>", "</p>"], [-1]);
  /** A view that claims (or clones) a <p> with text `s`. */
  const para = (s: string) => () => hydrateApi.__hclone(P, [s]);

  /** A root in the body with `html`. */
  const rooted = (html: string): FakeElement => {
    const root = new FakeElement("DIV");
    body.appendChild(root);
    root.innerHTML = html;
    return root;
  };

  test("<Loading>: not hydrating, the core's; over children the server rendered, they are claimed", () => {
    const L = hydrateAsync.Loading as (p: object) => unknown;
    expect((L({ children: "x" }) as FakeNode[]).map((n) => n.textContent).join("")).toBe("x");
    const root = rooted("<p>ok</p>");
    const p = find(root, "p");
    hydrateApi.hydrate(() => L({ fallback: "wait", children: para("ok") }), root as unknown as Element);
    expect(shown(root)).toBe("<p>ok</p>");
    expect(find(root, "p")).toBe(p);
  });

  test("<Loading>: while it hydrates, what waits for a value does not show its fallback; after, it does", async () => {
    const L = hydrateAsync.Loading as (p: object) => unknown;
    const pending = () => asyncApi.memo(() => new Promise<string>(() => {}));
    const root = rooted("<p>ok</p>");
    const read = pending();
    hydrateApi.hydrate(
      () =>
        L({
          fallback: "wait",
          children: () => [para("ok")(), core.__frag([() => read()])],
        }),
      root as unknown as Element,
    );
    await Promise.resolve();
    expect(shown(root)).toBe("<p>ok</p>");
    const fresh = new FakeElement("DIV");
    const later = pending();
    core.render(() => L({ fallback: "wait", children: () => later() }), fresh as unknown as Element);
    await Promise.resolve();
    expect(shown(fresh)).toBe("wait");
  });

  test("<Loading> whose fallback renderToString wrote is built afresh", () => {
    const root = rooted("<!--rr:b--><!--[--><i>wait</i><!--]--><!--/rr:b-->");
    const i = find(root, "i");
    hydrateApi.hydrate(
      () => (hydrateAsync.Loading as (p: object) => unknown)({ fallback: "wait", children: para("ok") }),
      root as unknown as Element,
    );
    expect(shown(root)).toBe("<p>ok</p>");
    expect(i.parentNode).toBe(null);
  });

  test("<Loading> a stream has not sent: the server's fallback stays until the swap, then its content is claimed", () => {
    const L = hydrateAsync.Loading as (p: object) => unknown;
    const $rrh = (globalThis as unknown as { $rrh: (i: number) => void }).$rrh;
    const root = rooted("<!--rr:b3--><!--[--><i>wait</i><!--]--><!--/rr:b3-->");
    const i = find(root, "i");
    hydrateApi.hydrate(() => L({ fallback: "wait", children: para("ok") }), root as unknown as Element);
    expect(shown(root)).toBe("<i>wait</i>");
    expect(find(root, "i")).toBe(i);
    // The swap: the content where the fallback and its markers were.
    const tpl = rooted("<!--[--><p>ok</p><!--]-->");
    const p = find(tpl, "p");
    const start = root.firstChild!;
    let end = start;
    while (end.nodeType !== 8 || (end as FakeComment).data !== "/rr:b3") end = end.nextSibling!;
    for (const x of [...tpl.childNodes]) root.insertBefore(x, start);
    while (start.nextSibling !== end) root.removeChild(start.nextSibling!);
    root.removeChild(start);
    root.removeChild(end);
    // Here the core's `__frag` builds the content, which does not claim a pair: a mismatch, so the
    // content is built afresh in place of the swapped one (the built apps below claim it).
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    $rrh(3);
    expect(String(warn.mock.calls[0]![0])).toContain("where a <Loading> renders something else");
    warn.mockRestore();
    expect(shown(root)).toBe("<p>ok</p>");
    expect(p.parentNode).toBe(null);
    // Once hydrated, and for a boundary disposed before its content came, the swap does nothing.
    $rrh(3);
    const gone = rooted("<!--rr:b4--><i>wait</i><!--/rr:b4-->");
    hydrateApi.hydrate(() => L({ fallback: "wait", children: para("ok") }), gone as unknown as Element)();
    $rrh(4);
    expect(gone.firstChild).toBe(null);
  });

  test("<Errored>: without the server's marker, the core's; with it, the fallback claims the server's, and reset builds the children", () => {
    const E = hydrateErrors.Errored as (p: object) => unknown;
    const root = rooted("<p>ok</p>");
    hydrateApi.hydrate(() => E({ fallback: "no", children: para("ok") }), root as unknown as Element);
    expect(shown(root)).toBe("<p>ok</p>");
    const page = rooted("<!--[--><!--rr:e:TypeError:bad%3A%20it--><p>TypeError bad: it</p><!--]-->");
    const p = find(page, "p");
    let reset!: () => void, seen: unknown;
    hydrateApi.hydrate(
      () =>
        E({
          fallback: (e: Error, r: () => void) => {
            reset = r;
            seen = e;
            return para(`${e.name} ${e.message}`)();
          },
          children: para("fixed"),
        }),
      page as unknown as Element,
    );
    expect(shown(page)).toBe("<p>TypeError bad: it</p>");
    expect(find(page, "p")).toBe(p);
    expect(seen).toBeInstanceOf(Error);
    expect((seen as Error).name).toBe("TypeError");
    reset();
    expect(shown(page)).toBe("<p>fixed</p>");
    // A fallback that is not a function, shown again after the first.
    const other = rooted("<!--[--><!--rr:e:Error:x--><b>no</b><!--]-->");
    let fail = true;
    hydrateApi.hydrate(
      () =>
        E({
          fallback: "no",
          get children() {
            if (fail) throw new Error("again");
            return "ok";
          },
        }),
      other as unknown as Element,
    );
    expect(shown(other)).toContain("no");
    fail = false;
  });
});

describe("built apps: a context, <Errored> and <Loading>", () => {
  const scratch = Bun.fileURLToPath(new URL("../.cache/hydrate", import.meta.url));

  /**
   * Bundle `entry` (a module body, with `app.tsx` of `APP` beside it) as the compiler's Bun plugin
   * bundles it with `options`, then run it: it sets what the test drives on `globalThis`.
   */
  async function run(name: string, entry: string, options: { server?: boolean; hydrate?: boolean }): Promise<void> {
    await Bun.write(`${scratch}/app.tsx`, APP);
    await Bun.write(`${scratch}/${name}.tsx`, entry);
    const r = await Bun.build({
      entrypoints: [`${scratch}/${name}.tsx`],
      format: "iife",
      target: "browser",
      conditions: ["reactre-source"],
      plugins: [reactreCompiler(options)],
    });
    if (!r.success) throw new Error(r.logs.join("\n"));
    new Function(await r.outputs[0]!.text())();
  }

  /** The app: a provider, an <Errored> whose child throws until it is fixed, and two <Loading>s. */
  const APP = `
    import { signal } from "@reactre/core";
    import { Loading, memo } from "@reactre/core/features/async";
    import { createContext, useContext } from "@reactre/core/features/context";
    import { Errored } from "@reactre/core/features/errors";
    const Theme = createContext("light");
    let settle;
    export const resolve = (v) => settle(v);
    // Each render's own data, which the test gives.
    const Word = () => {
      const word = memo(() => new Promise((ok) => (settle = ok)));
      return <p class="word">{word()}</p>;
    };
    export const [n, setN] = signal(1);
    export const [broken, setBroken] = signal(true);
    export const resets = [];
    const Label = () => <b class={useContext(Theme)}>{n()}</b>;
    const Maybe = () => {
      if (broken()) throw new TypeError("bad: thing");
      return <s>fixed</s>;
    };
    export const App = () => (
      <main>
        <Theme value="dark"><Label /></Theme>
        <Errored fallback={(err, reset) => (resets.push(reset), <p class="error">{err.name} {err.message}</p>)}>
          <Maybe />
        </Errored>
        <Loading fallback={<i>wait</i>}><p>sync {n()}</p></Loading>
        <Loading fallback={<i>loading</i>}><Word /></Loading>
      </main>
    );
  `;

  /** What the server bundle sets. */
  interface Server {
    html(): string;
    stream(): ReadableStream<Uint8Array>;
    whole(): Promise<string>;
    resolve(v: string): void;
  }
  /** What the client bundle sets, once it has hydrated `root`. */
  interface Client {
    resolve(v: string): void;
    setN(n: number): void;
    setBroken(b: boolean): void;
    resets: (() => void)[];
  }

  let srv: Server;
  beforeAll(async () => {
    await run(
      "server",
      `
      import { renderToStream, renderToString, renderToStringAsync } from "@reactre/core/server";
      import { App, resolve } from "./app.tsx";
      globalThis.srv = {
        html: () => renderToString(App, { hydrate: true }),
        stream: () => renderToStream(App, { hydrate: true }),
        whole: () => renderToStringAsync(App, { hydrate: true }),
        resolve,
      };
      `,
      { server: true },
    );
    srv = (globalThis as unknown as { srv: Server }).srv;
  });

  /** A root in the body with `html`, hydrated by a fresh client bundle. */
  async function hydrated(html: string): Promise<{ root: FakeElement; before: FakeNode[]; cli: Client }> {
    const root = new FakeElement("DIV");
    body.appendChild(root);
    root.innerHTML = html;
    const before = all(root).filter((n) => n.nodeType !== 8);
    (globalThis as unknown as { root: FakeElement }).root = root;
    await run(
      "client",
      `
      import { hydrate } from "@reactre/core/features/hydrate";
      import { App, resets, resolve, setBroken, setN } from "./app.tsx";
      hydrate(App, globalThis.root);
      globalThis.cli = { resolve, resets, setBroken, setN };
      `,
      { hydrate: true },
    );
    return { root, before, cli: (globalThis as unknown as { cli: Client }).cli };
  }

  const settle = () => new Promise((ok) => setTimeout(ok, 0));

  test("renderToString: the provider's content, <Errored>'s fallback and a ready <Loading> are claimed; one that waited builds afresh", async () => {
    const html = srv.html();
    expect(html).toContain("<!--rr:e:TypeError:bad%3A%20thing-->");
    expect(html).toContain("<!--rr:b--><!--[--><i>loading</i><!--]--><!--/rr:b-->");
    const { root, before, cli } = await hydrated(html);
    const [b, error, sync] = [find(root, "b"), find(root, "p"), all(root).filter((x) => x instanceof FakeElement)[3]];
    expect([b, error, sync].every((x) => before.includes(x!))).toBe(true);
    expect(shown(root)).toBe(
      '<main><b class="dark">1</b><p class="error">TypeError bad: thing</p><p>sync 1</p><i>loading</i></main>',
    );
    // The waiting boundary's fallback is the client's own.
    expect(before.includes(find(root, "i"))).toBe(false);
    cli.resolve("word");
    await settle();
    expect(shown(root)).toBe(
      '<main><b class="dark">1</b><p class="error">TypeError bad: thing</p><p>sync 1</p><p class="word">word</p></main>',
    );
    cli.setN(2);
    expect(shown(root)).toContain('<b class="dark">2</b>');
    expect(shown(root)).toContain("<p>sync 2</p>");
    expect(find(root, "b")).toBe(b);
    // `reset` builds the children afresh.
    cli.setBroken(false);
    cli.resets[0]!();
    expect(shown(root)).toBe('<main><b class="dark">2</b><s>fixed</s><p>sync 2</p><p class="word">word</p></main>');
  });

  test("renderToStringAsync: every boundary's children are claimed, and keep the server's text until the client's data comes", async () => {
    const whole = srv.whole();
    srv.resolve("server");
    const html = await whole;
    const { root, before, cli } = await hydrated(html);
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toContain('<p class="word">server</p>');
    cli.resolve("client");
    await settle();
    expect(shown(root)).toContain('<p class="word">client</p>');
    expect(kept(root, before)).toBe(true);
  });

  test("renderToStream: a boundary the stream has not sent keeps the server's fallback, and hydrates when it is swapped in", async () => {
    const reader = srv.stream().getReader(),
      dec = new TextDecoder();
    const shell = dec.decode((await reader.read()).value);
    expect(shell).toContain("<!--rr:b0--><!--[--><i>loading</i><!--]--><!--/rr:b0-->");
    const { root, before, cli } = await hydrated(shell);
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toContain("<i>loading</i>");
    srv.resolve("streamed");
    const rest = dec.decode((await reader.read()).value);
    expect(rest).toContain("self.$rrh&&self.$rrh(i)");
    // The swap script, as the browser runs it: the template's content in place of the fallback.
    const tpl = new FakeElement("DIV");
    tpl.innerHTML = /<template id="rr:t0">(.*?)<\/template>/.exec(rest)![1]!;
    const nodes = all(root);
    const s = nodes.find((x) => x.nodeType === 8 && (x as FakeComment).data === "rr:b0")!,
      e = nodes.find((x) => x.nodeType === 8 && (x as FakeComment).data === "/rr:b0")!;
    const p = s.parentNode!;
    while (s.nextSibling !== e) p.removeChild(s.nextSibling!);
    const swapped = [...tpl.childNodes];
    for (const x of swapped) p.insertBefore(x, s);
    p.removeChild(s);
    p.removeChild(e);
    (globalThis as unknown as { $rrh: (i: number) => void }).$rrh(0);
    expect(shown(root)).toContain('<p class="word">streamed</p>');
    const word = all(root).find((x) => x instanceof FakeElement && x.className === "word")!;
    expect(swapped.includes(word)).toBe(true);
    cli.resolve("later");
    await settle();
    expect(shown(root)).toContain('<p class="word">later</p>');
    expect(all(root).includes(word)).toBe(true);
    // A boundary that is gone before its content comes is not hydrated.
    (globalThis as unknown as { $rrh: (i: number) => void }).$rrh(0);
  });
});
