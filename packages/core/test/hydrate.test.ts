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
import type { BunPlugin } from "bun";

import * as asyncApi from "../src/features/async.ts";
import { __hooks } from "../src/features/async.ts";
import { configureClientErrors } from "../src/features/errors.ts";
import * as hydrateApi from "../src/features/hydrate.ts";
import * as indexApi from "../src/features/index.ts";
import * as storeApi from "../src/features/store.ts";
import * as hydrateAsync from "../src/hydrate/async.ts";
import * as hydrateErrors from "../src/hydrate/errors.ts";
import * as hydrateFor from "../src/hydrate/for.ts";
import * as core from "../src/index.ts";
import * as server from "../src/server.ts";
import * as serverAsync from "../src/server/async.ts";
import * as serverErrors from "../src/server/errors.ts";
import * as serverHydrate from "../src/server/hydrate.ts";

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
  "@reactre/core/server/hydrate": serverHydrate,
  "@reactre/core/features/store": storeApi,
};
/** What a source compiled for hydration imports. */
const clientModules: Record<string, unknown> = {
  "@reactre/core": core,
  "@reactre/core/features/hydrate": hydrateApi,
  "@reactre/core/features/index": indexApi,
  "@reactre/core/features/async": asyncApi,
  "@reactre/core/hydrate/async": hydrateAsync,
  "@reactre/core/hydrate/errors": hydrateErrors,
  "@reactre/core/hydrate/for": hydrateFor,
  "@reactre/core/server": { isServer: false },
  "@reactre/core/features/store": storeApi,
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
    // The server's row is where the client's fallback is: a mismatch, which the fallback's slot warns of.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
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
    expect(String(warn.mock.calls[0]![0])).toContain("where a slot renders something else");
    warn.mockRestore();
  });

  test("lists anywhere, with rows of any shape (features/for): the server's nodes are claimed, text rows split", () => {
    const p = page<{ App: () => unknown; set: (r: string[]) => void; on: (v: boolean) => void }>(`
      import { For, Repeat, Show, signal } from "@reactre/core";
      const [items, set] = signal(["a", "b"]);
      const [on, setOn] = signal(true);
      const Pair = (props) => <>{props.x}<b>{props.x}</b></>;
      const App = () => (
        <>
          <For each={items()} key={(s) => s}>{(s) => <i>{s}</i>}</For>
          <p><For each={items()} key={(s) => s}>{(s) => s}</For></p>
          <p><For each={items()} key={(s) => s}>{(s) => <Pair x={s} />}</For></p>
          <p><For each={items()} keyed={false} fallback="none">{(s, i) => <>{i}{s()}</>}</For></p>
          <Show when={on()}><Repeat count={items().length}>{(i) => <u>{i}</u>}</Repeat></Show>
        </>
      );
      return { App, set, on: setOn };
    `);
    const { root, before, app } = p;
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toBe("<i>a</i><i>b</i><p>ab</p><p>a<b>a</b>b<b>b</b></p><p>0a1b</p><u>0</u><u>1</u>");
    const text = (root.childNodes.filter((n) => n instanceof FakeElement)[2] as FakeElement).childNodes.filter(
      (n) => n instanceof FakeText,
    );
    expect(text.map((n) => (n as FakeText).data).filter(Boolean)).toEqual(["a", "b"]);
    app.set(["b", "c"]);
    expect(shown(root)).toBe("<i>b</i><i>c</i><p>bc</p><p>b<b>b</b>c<b>c</b></p><p>0b1c</p><u>0</u><u>1</u>");
    app.set([]);
    expect(shown(root)).toBe("<p></p><p></p><p>none</p>");
    app.on(false);
    app.set(["d"]);
    app.on(true);
    expect(shown(root)).toBe("<i>d</i><p>d</p><p>d<b>d</b></p><p>0d</p><u>0</u>");
  });

  test("features/for's list: a row that does not match and those after it are built afresh; rows only on the server go", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const SRC = `
      import { For, signal } from "@reactre/core";
      import { isServer } from "@reactre/core/server";
      const [items, set] = signal(isServer ? ["a", "b", "c", "d"] : ["a", "b", "c"]);
      const App = () => <div><For each={items()} key={(s) => s}>{(s) => <><i>{s}</i>!</>}</For></div>;
      return { App, set };
    `;
    const p = page<{ App: () => unknown; set: (r: string[]) => void }>(SRC, (h) => h.replace("<i>b</i>", "<b>b</b>"));
    expect(shown(p.root)).toBe("<div><i>a</i>!<i>b</i>!<i>c</i>!</div>");
    const is = all(p.root).filter((n) => n instanceof FakeElement && n.tagName === "I");
    expect(is.map((n) => p.before.includes(n))).toEqual([true, false, false]);
    expect(String(warn.mock.calls[0]![0])).toContain("the page has <b> where a <For> row renders something else");
    p.app.set(["c", "a"]);
    expect(shown(p.root)).toBe("<div><i>c</i>!<i>a</i>!</div>");
    // No pair where the list goes: the slot it is in renders afresh.
    const q = page<{ App: () => unknown }>(
      `
      import { For, Show } from "@reactre/core";
      const App = () => <main><Show when={true}><For each={["x"]} key={(s) => s}>{(s) => s}</For></Show></main>;
      return { App };
    `,
      (h) => h.replace("<!--[--><!--[-->x<!--]--><!--]-->", "<!--[-->y<!--]-->"),
    );
    expect(shown(q.root)).toBe("<main>x</main>");
    expect(String(warn.mock.calls[1]![0])).toContain('the page has the text "y" where a slot renders something else');
    warn.mockRestore();
  });
});

describe("stores and props given JSX", () => {
  test("what is made of a store, a store passed as a prop and JSX passed as a prop are the server's nodes, and update", () => {
    // List and Card are called only here: the file sees what they are passed. Tag is used as a
    // value too, so its callers cannot all be seen: its props are taken for maybe a store and
    // maybe JSX, as an exported component's are in a file compiled alone.
    const p = page<{ App: () => unknown; setStore: (f: (s: any) => void) => void }>(`
      import { For } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store, setStore] = createStore({ todos: [{ id: 1, title: "a" }, { id: 2, title: "b" }], user: { name: "Ann" } });
      const todos = store.todos;
      function useUser() { return store.user; }
      function List(props) { return <ul><For each={props.todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>; }
      function Card(props) { return <section>{props.header}<p>{useUser().name}</p></section>; }
      function Tag(props) { return <ol><For each={props.items} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For>{props.label}</ol>; }
      const App = () => (
        <div><b>{todos.length}</b><List todos={store.todos} /><Card header={<h1>Hi</h1>} /><Tag items={store.todos} label={<em>e</em>} /></div>
      );
      return { App, setStore, Tag };
    `);
    const { root, before, app } = p;
    const html =
      "<div><b>2</b><ul><li>a</li><li>b</li></ul><section><h1>Hi</h1><p>Ann</p></section><ol><li>a</li><li>b</li><em>e</em></ol></div>";
    expect(shown(root)).toBe(html);
    expect(kept(root, before)).toBe(true);
    const tag = (name: string): FakeNode => before.find((n) => n instanceof FakeElement && n.tagName === name)!;
    app.setStore((s) => {
      s.todos.push({ id: 3, title: "c" });
      s.todos[0].title = "A";
      s.user.name = "Bo";
    });
    expect(shown(root)).toBe(
      "<div><b>3</b><ul><li>A</li><li>b</li><li>c</li></ul><section><h1>Hi</h1><p>Bo</p></section><ol><li>A</li><li>b</li><li>c</li><em>e</em></ol></div>",
    );
    // The server's nodes for the JSX passed as props are kept through the update.
    expect(find(root, "h1") as FakeNode).toBe(tag("H1"));
    expect(find(root, "em") as FakeNode).toBe(tag("EM"));
  });

  test("a list that is a component's whole view, or whose rows are not one element, over a store passed as a prop or a local of one", () => {
    // Each list is features/for's `__each` (hydrate/for here): List's is its whole view, its rows
    // fragments; Tag is used as a value, so its props may be stores.
    const p = page<{ App: () => unknown; setStore: (f: (s: any) => void) => void }>(`
      import { For } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store, setStore] = createStore({ todos: [{ id: 1, title: "a" }, { id: 2, title: "b" }] });
      const todos = store.todos;
      function List(props) { return <For each={props.todos} key={(t) => t.id}>{(t) => <><i>{t.title}</i>!</>}</For>; }
      function Tag(props) { return <For each={props.items} key={(t) => t.id}>{(t) => <u>{t.title}</u>}</For>; }
      const App = () => (
        <div><p><List todos={store.todos} /></p><p><Tag items={store.todos} /></p><p><b /><For each={todos} key={(t) => t.id}>{(t) => <s>{t.title}</s>}</For></p></div>
      );
      return { App, setStore, Tag };
    `);
    const { root, before, app } = p;
    expect(shown(root)).toBe(
      "<div><p><i>a</i>!<i>b</i>!</p><p><u>a</u><u>b</u></p><p><b></b><s>a</s><s>b</s></p></div>",
    );
    expect(kept(root, before)).toBe(true);
    const first = find(root, "u");
    app.setStore((s) => {
      s.todos.push({ id: 3, title: "c" });
      s.todos[0].title = "A";
    });
    expect(shown(root)).toBe(
      "<div><p><i>A</i>!<i>b</i>!<i>c</i>!</p><p><u>A</u><u>b</u><u>c</u></p><p><b></b><s>A</s><s>b</s><s>c</s></p></div>",
    );
    // The server's rows are kept, and written in place.
    expect(find(root, "u")).toBe(first);
  });
});

describe("JSX held in values", () => {
  test("what a hole calls, a conditional, a fragment's expression and an unnamed component are the server's nodes, and update", () => {
    // With the compiler before, the server wrote each as [object Object], and the client as text.
    // Each is built as its hole runs, in the page's order, so it claims the server's nodes.
    const p = page<{ App: () => unknown; set: (v: boolean) => void; setN: (v: number) => void }>(`
      import { signal } from "@reactre/core";
      const [on, set] = signal(true);
      const [n, setN] = signal(1);
      function make() { return <b>{n()}</b>; }
      const a = () => <i>i</i>;
      const items = () => [<li>1</li>, <li>2</li>];
      const box = { get: () => <s>s</s> };
      const parts = { card: (props) => <em>{props.n}</em> };
      const App = () => <div>{on() ? a() : null}{make()}<ul>{items()}</ul><><span>{box.get()}</span></><parts.card n={n()} /></div>;
      return { App, set, setN };
    `);
    const { root, before, app } = p;
    expect(shown(root)).toBe("<div><i>i</i><b>1</b><ul><li>1</li><li>2</li></ul><span><s>s</s></span><em>1</em></div>");
    expect(kept(root, before)).toBe(true);
    const b = find(root, "b");
    app.set(false);
    expect(shown(root)).toBe("<div><b>1</b><ul><li>1</li><li>2</li></ul><span><s>s</s></span><em>1</em></div>");
    app.setN(2);
    expect(shown(root)).toBe("<div><b>2</b><ul><li>1</li><li>2</li></ul><span><s>s</s></span><em>2</em></div>");
    expect(find(root, "ul")).toBe(before.find((x) => x instanceof FakeElement && x.tagName === "UL") as FakeElement);
    expect(b.isConnected).toBe(false);
  });

  test("the server renders a local's, a function's, an array's and a fragment's expression's JSX as markup, not [object Object]", () => {
    const app = ssr<{ App: () => unknown }>(`
      const el = <h1>Hi</h1>;
      function make() { return <b>b</b>; }
      const items = [<li>1</li>, <li>2</li>];
      const App = () => <div>{el}{make()}<ul>{items}</ul><>{(() => <i>i</i>)()}</></div>;
      return { App };
    `);
    expect(server.renderToString(app.App)).toBe("<div><h1>Hi</h1><b>b</b><ul><li>1</li><li>2</li></ul><i>i</i></div>");
  });

  test("JSX built before its place in the page is claimed (a module's local, a memo) takes the place of the server's nodes", () => {
    const p = page<{ App: () => unknown; set: (v: boolean) => void }>(`
      import { memo, signal } from "@reactre/core";
      const [on, set] = signal(true);
      const el = <h1>Hi</h1>;
      const items = [<li>1</li>, <li>2</li>];
      const view = memo(() => <p>{on() ? "on" : "off"}</p>);
      const App = () => <div>{el}<ul>{items}</ul>{view()}<em>after</em></div>;
      return { App, set };
    `);
    expect(shown(p.root)).toBe("<div><h1>Hi</h1><ul><li>1</li><li>2</li></ul><p>on</p><em>after</em></div>");
    const em = (n: FakeNode) => n instanceof FakeElement && n.tagName === "EM";
    expect(find(p.root, "em")).toBe(p.before.find(em) as FakeElement);
    p.app.set(false);
    expect(shown(p.root)).toBe("<div><h1>Hi</h1><ul><li>1</li><li>2</li></ul><p>off</p><em>after</em></div>");
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

describe("the server's markers for boundaries", () => {
  test("an <Errored>'s fallback: its error's name and message, only with `hydrate`", () => {
    const render = (hydrate: boolean, err: unknown) =>
      server.renderToString(() => server.__ssrErrored(err), { hydrate });
    expect(render(true, new TypeError("bad: it"))).toBe("<!--rr:e:TypeError:bad%3A%20it-->");
    expect(render(true, "plain")).toBe("<!--rr:e:Error:plain-->");
    expect(render(false, new Error("x"))).toBe("");
    expect(server.__ssrErrored(new Error("outside a render"))).toBe(null);
    // The server's <Errored> puts it before the fallback (here outside a render: nothing before it).
    const nodes = serverErrors.Errored({
      fallback: (e: unknown) => (e as Error).message,
      get children(): string {
        throw new Error("thrown");
      },
    }) as FakeNode[];
    expect(nodes.map((n) => n.textContent).join("")).toBe("thrown");
    expect(
      (serverErrors.Errored({ fallback: "static", children: "ok" }) as FakeNode[]).map((n) => n.textContent).join(""),
    ).toBe("ok");
  });

  test("a <Loading> whose fallback renderToString writes, with `hydrate`: between markers", () => {
    const app = ssr<{ App: () => unknown }>(`
      import { Loading, memo } from "@reactre/core/features/async";
      const word = memo(() => new Promise(() => {}));
      const App = () => <main><Loading fallback={<i>wait</i>}><p>{word()}</p></Loading></main>;
      return { App };
    `);
    expect(server.renderToString(app.App, { hydrate: true })).toContain(
      "<!--rr:b--><!--[--><i>wait</i><!--]--><!--/rr:b-->",
    );
    expect(server.renderToString(app.App)).toBe("<main><i>wait</i></main>");
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
    // A production server's marker, bare: the fallback gets an Error saying it was kept out.
    const bare = rooted("<!--[--><!--rr:e--><p>failed</p><!--]-->");
    let got: unknown;
    hydrateApi.hydrate(
      () => E({ fallback: (e: Error) => ((got = e), para("failed")()), children: para("ok") }),
      bare as unknown as Element,
    );
    expect(shown(bare)).toBe("<p>failed</p>");
    expect([(got as Error).name, (got as Error).message]).toEqual([
      "Error",
      "reactre: the server's <Errored> showed its fallback, and its production build keeps the error out of the page; its development build shows it",
    ]);
  });
});

describe("built apps: a context, <Errored> and <Loading>", () => {
  const scratch = Bun.fileURLToPath(new URL("../.cache/hydrate", import.meta.url));

  /**
   * Bundle `entry` (a module body, with `app.tsx` of `APP` beside it) as the compiler's Bun plugin
   * bundles it with `options`, then run it: it sets what the test drives on `globalThis`.
   */
  async function run(
    name: string,
    entry: string,
    options: { server?: boolean; hydrate?: boolean },
    dev = false,
  ): Promise<void> {
    await Bun.write(`${scratch}/app.tsx`, APP);
    await Bun.write(`${scratch}/${name}.tsx`, entry);
    const r = await Bun.build({
      entrypoints: [`${scratch}/${name}.tsx`],
      format: "iife",
      target: "browser",
      conditions: ["reactre-source"],
      // With `dev`, the server as its development build is (Bun loads a file with the first
      // plugin's onLoad that returns it); else stripped, as a production build gets it.
      plugins: dev ? [serverAsIs, reactreCompiler(options)] : [reactreCompiler(options)],
    });
    if (!r.success) throw new Error(r.logs.join("\n"));
    new Function(await r.outputs[0]!.text())();
  }

  /** Loads @reactre/core's server.ts as it is: its development build. */
  const serverAsIs: BunPlugin = {
    name: "server-as-is",
    setup(b) {
      b.onLoad({ filter: /[\\/]core[\\/]src[\\/]server\.ts$/ }, async (a) => ({
        contents: await Bun.file(a.path).text(),
        loader: "ts",
      }));
    },
  };

  /**
   * The app: a provider, an <Errored> whose child throws until it is fixed (an error whose message
   * holds markup), and two <Loading>s. The fallback shows none of the error, and keeps it.
   */
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
    export const errors = [];
    const Label = () => <b class={useContext(Theme)}>{n()}</b>;
    const Maybe = () => {
      if (broken()) throw new TypeError("bad: </script><script>alert(1)</script>");
      return <s>fixed</s>;
    };
    export const App = () => (
      <main>
        <Theme value="dark"><Label /></Theme>
        <Errored fallback={(err, reset) => (resets.push(reset), errors.push(err), <p class="error">failed</p>)}>
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
    errors: Error[];
  }

  /** The server's entry: its render functions, for `srv` (or `dev` for its development build). */
  const SERVER = (name: string) => `
    import { renderToStream, renderToString, renderToStringAsync } from "@reactre/core/server";
    import { App, resolve } from "./app.tsx";
    globalThis.${name} = {
      html: () => renderToString(App, { hydrate: true }),
      stream: () => renderToStream(App, { hydrate: true }),
      whole: () => renderToStringAsync(App, { hydrate: true }),
      resolve,
    };
  `;

  let srv: Server, dev: Server;
  beforeAll(async () => {
    await run("server", SERVER("srv"), { server: true });
    await run("server-dev", SERVER("dev"), { server: true }, true);
    ({ srv, dev } = globalThis as unknown as { srv: Server; dev: Server });
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
      import { App, errors, resets, resolve, setBroken, setN } from "./app.tsx";
      hydrate(App, globalThis.root);
      globalThis.cli = { errors, resolve, resets, setBroken, setN };
      `,
      { hydrate: true },
    );
    return { root, before, cli: (globalThis as unknown as { cli: Client }).cli };
  }

  const settle = () => new Promise((ok) => setTimeout(ok, 0));

  test("renderToString: the provider's content, <Errored>'s fallback and a ready <Loading> are claimed; one that waited builds afresh", async () => {
    const html = srv.html();
    expect(html).toContain("<!--rr:b--><!--[--><i>loading</i><!--]--><!--/rr:b-->");
    const { root, before, cli } = await hydrated(html);
    const [b, error, sync] = [find(root, "b"), find(root, "p"), all(root).filter((x) => x instanceof FakeElement)[3]];
    expect([b, error, sync].every((x) => before.includes(x!))).toBe(true);
    expect(shown(root)).toBe(
      '<main><b class="dark">1</b><p class="error">failed</p><p>sync 1</p><i>loading</i></main>',
    );
    // The waiting boundary's fallback is the client's own.
    expect(before.includes(find(root, "i"))).toBe(false);
    cli.resolve("word");
    await settle();
    expect(shown(root)).toBe(
      '<main><b class="dark">1</b><p class="error">failed</p><p>sync 1</p><p class="word">word</p></main>',
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

  test("<Errored>'s marker: a production server writes none of the error, and the fallback gets a generic one; a development server names it", async () => {
    const prod = srv.html();
    expect(prod).toContain("<!--[--><!--rr:e--><p");
    for (const s of ["alert", "script", "%3C", "TypeError", "bad"]) expect(prod).not.toContain(s);
    let { cli } = await hydrated(prod);
    expect(cli.errors.length).toBe(1);
    expect(cli.errors[0]!.name).toBe("Error");
    expect(cli.errors[0]!.message).toBe(
      "reactre: the server's <Errored> showed its fallback, and its production build keeps the error out of the page; its development build shows it",
    );
    const html = dev.html();
    expect(html).toContain("<!--rr:e:TypeError:bad%3A%20%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E--><p");
    expect(html).not.toContain("</script>");
    ({ cli } = await hydrated(html));
    expect(cli.errors.length).toBe(1);
    expect([cli.errors[0]!.name, cli.errors[0]!.message]).toEqual([
      "TypeError",
      "bad: </script><script>alert(1)</script>",
    ]);
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

  test("a list of features/for as the only child of a provider, an <Errored> and a <Loading>: its rows are claimed", async () => {
    const LISTS = `
      import { For, signal } from "@reactre/core";
      import { Loading } from "@reactre/core/features/async";
      import { createContext } from "@reactre/core/features/context";
      import { Errored } from "@reactre/core/features/errors";
      const Theme = createContext("light");
      export const [items, setItems] = signal(["a", "b"]);
      export const App = () => (
        <main>
          <Theme value="dark"><For each={items()} key={(s) => s}>{(s) => <i>{s}</i>}</For></Theme>
          <Errored fallback="failed"><For each={items()} key={(s) => s}>{(s) => s}</For></Errored>
          <Loading fallback="wait"><For each={items()} keyed={false}>{(s) => <>{s()}!</>}</For></Loading>
        </main>
      );
    `;
    await run(
      "lists-server",
      `${LISTS} globalThis.lists = { html: () => renderToString(App, { hydrate: true }) };`.replace(
        "import {",
        'import { renderToString } from "@reactre/core/server"; import {',
      ),
      { server: true },
    );
    const html = (globalThis as unknown as { lists: { html(): string } }).lists.html();
    const root = new FakeElement("DIV");
    body.appendChild(root);
    root.innerHTML = html;
    const before = all(root).filter((n) => n.nodeType !== 8);
    (globalThis as unknown as { root: FakeElement }).root = root;
    await run(
      "lists-client",
      `${LISTS} import { hydrate } from "@reactre/core/features/hydrate"; hydrate(App, globalThis.root); globalThis.lists = { setItems };`,
      { hydrate: true },
    );
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toBe("<main><i>a</i><i>b</i>aba!b!</main>");
    (globalThis as unknown as { lists: { setItems(v: string[]): void } }).lists.setItems(["b", "c"]);
    expect(shown(root)).toBe("<main><i>b</i><i>c</i>bcb!c!</main>");
  });
});

describe("what the server sends: hydration values, the memo's options and clientOnly", () => {
  /** The page's globals the server's scripts set. */
  const win = globalThis as unknown as {
    $rrd?: Record<string, unknown>;
    $rrv?: (o: object) => void;
    $rrw?: unknown;
  };
  afterEach(() => {
    delete win.$rrd;
    delete win.$rrv;
    delete win.$rrw;
  });

  /** Run the scripts in `html` as the browser would, and give back `html` without them. */
  function run(html: string): string {
    for (const m of html.matchAll(/<script[^>]*>(.*?)<\/script>/g)) new Function(m[1]!)();
    return html.replace(/<script[^>]*>.*?<\/script>/g, "");
  }

  /** Let promise callbacks and timers run. */
  const settle = (): Promise<void> => new Promise((ok) => setTimeout(ok, 0));

  /** Run `make` as a view that hydrates an empty root, so that it runs while the page hydrates. */
  function hydrating(make: () => void): () => void {
    const root = new FakeElement("DIV");
    body.appendChild(root);
    return hydrateApi.hydrate(() => (make(), null), root as unknown as Element);
  }

  /** What `read` reads once it is ready. */
  const value = <T>(read: () => T): Promise<T> => asyncApi.resolve(read);

  test("takeHydrationValue: what the server wrote, as it was, once; tagged values and plain objects of no prototype key", () => {
    const LS = String.fromCharCode(0x2028);
    const date = new Date(5);
    const sent = [undefined, NaN, -0, -Infinity, 10n, date, new Map([[1, { a: "x" }]]), new Set(["y"]), { $rr: 1 }];
    run(
      server.renderToString(() => {
        const w = server.getHydrationWriter()!;
        w.write("t", sent);
        w.write("s", { s: "</script><!--" + LS, n: [1, null, true] });
        return "";
      }),
    );
    const t = hydrateApi.takeHydrationValue<unknown[]>("t")!;
    expect(t.status).toBe("resolved");
    const got = (t as { value: unknown[] }).value;
    expect(got).toEqual(sent);
    expect(Object.is(got[2], -0)).toBe(true);
    expect(got[5]).toBeInstanceOf(Date);
    expect(hydrateApi.takeHydrationValue("s")).toEqual({
      status: "resolved",
      value: { s: "</script><!--" + LS, n: [1, null, true] },
    });
    expect(hydrateApi.takeHydrationValue("t")).toBeUndefined();
    // A page's registry has no prototype; a `__proto__` key some other script put there is dropped.
    win.$rrd = { x: JSON.parse('{"__proto__":{"polluted":1},"ok":1}') };
    const x = hydrateApi.takeHydrationValue<object>("x") as { value: object };
    expect(Object.getPrototypeOf(x.value)).toBe(Object.prototype);
    expect(x.value).toEqual({ ok: 1 });
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });

  test("takeHydrationValue: a Promise the stream has not settled is pending until its script comes, then resolved or rejected", async () => {
    run(server.renderToString(() => (server.getHydrationWriter()!.write("x", 1), "")));
    win.$rrd = { ok: { $rr: "p" }, no: { $rr: "p" }, prod: { $rr: "p" } };
    const ok = hydrateApi.takeHydrationValue<number>("ok") as { status: string; promise: Promise<number> };
    const no = hydrateApi.takeHydrationValue("no") as { promise: Promise<unknown> };
    const prod = hydrateApi.takeHydrationValue("prod") as { promise: Promise<unknown> };
    expect(ok.status).toBe("pending");
    win.$rrv!({ ok: 7, other: 1 });
    expect(await ok.promise).toBe(7);
    win.$rrv!({ no: { $rr: "r", v: ["RangeError", "bad"] }, prod: { $rr: "r" } });
    const err = await no.promise.catch((e: unknown) => e);
    expect([(err as Error).name, (err as Error).message]).toEqual(["RangeError", "bad"]);
    expect(((await prod.promise.catch((e: unknown) => e)) as Error).message).toContain("production build");
    // One that rejected before it was taken.
    win.$rrd!["late"] = { $rr: "r", v: ["Error", "late"] };
    const late = hydrateApi.takeHydrationValue("late") as { status: string; error: Error };
    expect([late.status, late.error.message]).toEqual(["rejected", "late"]);
  });

  test("memo with an id: hydrating, its first value is the server's, fetch sending nothing; then it computes as it would", async () => {
    const src = `
      import { signal } from "@reactre/core";
      import { memo } from "@reactre/core/features/async";
      const log = [];
      const [n, setN] = signal(1);
      const App = () => {
        const text = memo(() => (log.push(n()), fetch("data:,v" + n()).then((r) => r.text())), { id: "text" });
        return <p>{text()}</p>;
      };
      return { App, log, setN };
    `;
    const s = ssr<{ App: () => unknown; log: number[] }>(src);
    const html = run(await server.renderToStringAsync(s.App, { hydrate: true }));
    expect(s.log).toEqual([1]);
    expect(win.$rrd).toEqual({ text: "v1" });
    const root = new FakeElement("DIV");
    body.appendChild(root);
    root.innerHTML = html;
    const p = find(root, "p");
    const c = hyd<{ App: () => unknown; log: number[]; setN: (n: number) => void }>(src);
    const fetched = spyOn(globalThis, "fetch");
    hydrateApi.hydrate(c.App, root as unknown as Element);
    // It ran once, to learn what it reads, with no request sent; the page shows the server's value.
    expect(c.log).toEqual([1]);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
    expect(shown(root)).toBe("<p>v1</p>");
    expect(find(root, "p")).toBe(p);
    expect(win.$rrd).toEqual({});
    c.setN(2);
    for (let i = 0; i < 5 && shown(root) !== "<p>v2</p>"; i++) await settle();
    expect(shown(root)).toBe("<p>v2</p>");
    expect(c.log).toEqual([1, 2]);
  });

  test("memo hydrating: a pending value waits for its script, a rejected one rejects; with a loadingValue, it comes after", async () => {
    run(server.renderToString(() => (server.getHydrationWriter()!.write("x", 1), "")));
    win.$rrd = { p: { $rr: "p" }, r: { $rr: "r", v: ["Error", "server"] }, lv: "server", fails: 1, x: 1 };
    let p!: () => string, r!: () => string, lv!: () => string, fails!: () => number, none!: () => string;
    hydrating(() => {
      p = hydrateAsync.memo(() => Promise.resolve("client"), { id: "p" });
      r = hydrateAsync.memo(() => Promise.resolve("client"), { id: "r" });
      lv = hydrateAsync.memo(() => Promise.resolve("client"), { id: "lv", loadingValue: "loading" });
      // What `fn` throws or rejects with while it is traced is dropped.
      fails = hydrateAsync.memo(
        (): number => {
          throw new Error("traced");
        },
        { id: "fails" },
      );
      hydrateAsync.memo(() => Promise.reject(new Error("traced")), { id: "x" });
      // No value under its id: it computes.
      none = hydrateAsync.memo(() => Promise.resolve("computed"), { id: "missing" });
    });
    expect(lv()).toBe("loading");
    expect(fails()).toBe(1);
    win.$rrv!({ p: "streamed" });
    expect(await value(p)).toBe("streamed");
    expect(await value(r).catch((e: Error) => e.message)).toBe("server");
    expect(await value(lv)).toBe("server");
    expect(await value(none)).toBe("computed");
  });

  test("memo hydrating: a source of from reconnects from the server's value; with hybrid, an AsyncIterable goes on after it", async () => {
    win.$rrd = { live: 1, gen: "a", empty: "z", one: "only" };
    const [round, nextRound] = core.signal(0);
    let next!: (v: number) => void;
    const log: string[] = [];
    let live!: () => number, gen!: () => string, empty!: () => string, one!: () => string;
    async function* letters() {
      log.push("gen");
      yield "a";
      yield "b";
    }
    async function* nothing(): AsyncGenerator<string> {}
    async function* single() {
      yield "skipped";
    }
    const dispose = hydrating(() => {
      live = hydrateAsync.memo(
        () =>
          asyncApi.from<number>((n) => {
            log.push("subscribe");
            next = n;
            return () => log.push("unsubscribe");
          }),
        { id: "live" },
      );
      gen = hydrateAsync.memo(() => (round(), letters()), { id: "gen", ssrSource: "hybrid" });
      empty = hydrateAsync.memo(() => nothing(), { id: "empty", ssrSource: "hybrid" });
      one = hydrateAsync.memo(() => single(), { id: "one", ssrSource: "hybrid" });
    });
    expect(live()).toBe(1);
    expect(gen()).toBe("a");
    await settle();
    next(2);
    await settle();
    expect(live()).toBe(2);
    expect(gen()).toBe("b");
    expect([empty(), one()]).toEqual(["z", "only"]);
    // Run again, it stops the iterator it had, and computes as it would.
    nextRound(1);
    await settle();
    expect(gen()).toBe("b");
    // A generator's body runs once iterated: the traced call never was.
    expect(log.filter((x) => x === "gen").length).toBe(2);
    dispose();
    expect(log).toContain("unsubscribe");
    // Without hybrid, an AsyncIterable that is not a subscription's is the server's value alone.
    win.$rrd = { plain: "server" };
    let plain!: () => string;
    hydrating(() => (plain = hydrateAsync.memo(() => letters(), { id: "plain" })));
    await settle();
    expect(plain()).toBe("server");
  });

  test('memo hydrating: ssrSource "client" computes once the page has hydrated; transparent takes nothing; not hydrating, features/async\'s', async () => {
    win.$rrd = { t: "server" };
    let calls = 0;
    let client!: () => string, transparent!: () => string;
    hydrating(() => {
      client = hydrateAsync.memo(() => (calls++, Promise.resolve("client")), { ssrSource: "client" });
      transparent = hydrateAsync.memo(() => Promise.resolve("fresh"), { id: "t", transparent: true });
      expect(calls).toBe(0);
    });
    expect(await value(client)).toBe("client");
    expect(calls).toBe(1);
    expect(await value(transparent)).toBe("fresh");
    expect(win.$rrd).toEqual({ t: "server" });
    expect(await value(hydrateAsync.memo(() => Promise.resolve("afresh"), { id: "t" }))).toBe("afresh");
    expect(await value(hydrateAsync.memo(() => Promise.resolve("bare")))).toBe("bare");
  });

  test("clientOnly: the server writes the fallback; hydrating, it claims it, and the component takes its place once the page has hydrated", async () => {
    const src = `
      import { clientOnly } from "@reactre/core/features/hydrate";
      const loads = [];
      const Chart = clientOnly(() => (loads.push(1), Promise.resolve({ Chart: (p) => <b>chart {p.n}</b> })), { export: "Chart" });
      const App = () => <div><Chart n={1} fallback={<i>wait</i>} /></div>;
      return { App, loads };
    `;
    const s = ssr<{ App: () => unknown; loads: number[] }>(src);
    // The component's slot, and in it the fallback's, which the client's `__frag` claims.
    expect(server.renderToString(s.App, { hydrate: true })).toBe(
      "<div><!--[--><!--[--><i>wait</i><!--]--><!--]--></div>",
    );
    expect(s.loads).toEqual([]);
    const { root, before } = page(src);
    expect(kept(root, before)).toBe(true);
    expect(shown(root)).toBe("<div><i>wait</i></div>");
    await settle();
    expect(shown(root)).toBe("<div><b>chart 1</b></div>");
  });

  test("clientOnly rendering afresh: the fallback until it has loaded, then the component with the props but fallback; lazy loads on first render", async () => {
    let loads = 0;
    const seen: string[][] = [];
    const Widget = hydrateApi.clientOnly<{ n: number }>(
      () => (
        loads++,
        Promise.resolve({
          default: (p: { n: number }) => (seen.push(Object.keys(p)), "widget " + p.n),
        })
      ),
      { lazy: true },
    );
    expect(loads).toBe(0);
    const root = new FakeElement("DIV");
    body.appendChild(root);
    core.render(() => Widget({ n: 2, fallback: "wait" }), root as unknown as Element);
    expect([loads, shown(root)]).toEqual([1, "wait"]);
    await settle();
    expect(shown(root)).toBe("widget 2");
    expect(seen).toEqual([["n"]]);
    // On the server it is never loaded.
    expect(serverHydrate.isHydrating()).toBe(false);
    expect(() => serverHydrate.hydrate(() => null, null)).toThrow("it does not run in a server build");
  });
});
