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

import { compileSource, ReactreCompileError } from "@reactre/compiler";
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
    expect(new FakeComment("x").data).toBe("x");
  });
});
