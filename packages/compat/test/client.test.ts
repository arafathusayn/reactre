// @reactre/compat's client against React's own (react-dom@19.3.1, production builds), on the fake
// DOM.
//
// React's production client runs on the fake DOM with the few additions below (a window for its
// selection code, localName and splitText for hydration). Each test builds one tree twice, once
// from React and once from compat, renders each with its own library and expects the same: the
// ids useId gives while hydrating server HTML.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeNode, FakeText, HTML_NS, installFakeDocument } from "@reactre/testdom";

import * as Compat from "../src/core.ts";

// biome-ignore lint: both libraries are used through one untyped interface.
type Any = any;
type Lib = Any;

// React's production builds: NODE_ENV is read when the modules load. (React has no types here.)
const load = (specifier: string): Promise<Any> => import(specifier);
const prevEnv = process.env["NODE_ENV"];
process.env["NODE_ENV"] = "production";
const React: Lib = await load("react");
const ReactDOM: Any = await load("react-dom");
const ReactClient: Any = await load("react-dom/client");
const ReactServer: Any = await load("react-dom/server.browser");
if (prevEnv === undefined) delete process.env["NODE_ENV"];
else process.env["NODE_ENV"] = prevEnv;

// #region Fixtures

/**
 * Gives `target` the properties in `props` for every test of this file, and takes them off after
 * each, so other files see the plain fake DOM.
 */
function extend(target: object, props: Record<string, PropertyDescriptor>): void {
  beforeEach(() => {
    for (const k in props) Object.defineProperty(target, k, { configurable: true, ...props[k] });
  });
  afterEach(() => {
    for (const k in props) delete (target as Record<string, unknown>)[k];
  });
}

// What hydration reads: an element's localName and a text's splitText. What React's client reads
// of the document: its window (for the focused element and the selection) and its listeners.
extend(FakeElement.prototype, {
  localName: {
    get(this: FakeElement) {
      return this.namespaceURI === HTML_NS ? this.tagName.toLowerCase() : this.tagName;
    },
  },
});
extend(FakeText.prototype, {
  splitText: {
    value(this: FakeText, at: number) {
      const rest = new FakeText(this.data.slice(at));
      this.data = this.data.slice(0, at);
      this.parentNode!.insertBefore(rest, this.nextSibling);
      return rest;
    },
  },
});
const fakeDoc = new FakeNode(9).ownerDocument as Any;
extend(fakeDoc, {
  addEventListener: { value: () => {} },
  defaultView: { value: { document: fakeDoc, HTMLIFrameElement: class {}, getSelection: () => null } },
});

beforeEach(() => installFakeDocument());

/** A container "in the document", so moves can keep state (moveBefore). */
function box(): FakeElement {
  const c = new FakeElement("DIV");
  c.isDocument = true;
  return c;
}

/** The markup of `n`'s children: tags lowercased, attributes in order, comments shown. */
function markup(n: FakeNode): string {
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      const attrs = c.attributes.map((a) => ` ${a.name}="${a.value}"`).join("");
      out += `<${tag}${attrs}>${markup(c)}</${tag}>`;
    } else if (c.nodeType === 8) out += `<!--${(c as Any).data}-->`;
    else out += c.textContent;
  }
  return out;
}

/** Every node under `n`, in document order. */
function nodes(n: FakeNode, out: FakeNode[] = []): FakeNode[] {
  for (let c = n.firstChild; c !== null; c = c.nextSibling) out.push(c, ...nodes(c));
  return out;
}

/** Let React's scheduler run (it hydrates Suspense boundaries in tasks of their own). */
const tasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// #endregion

// #region useId while hydrating

describe("useId while hydrating", () => {
  /**
   * Renders `make(React)` on React's server, hydrates that HTML with React's client and with
   * compat's, and expects compat to give every useId call React's id, with the server's nodes
   * and attributes left as they were.
   */
  async function hydrates(make: (L: Lib, ids: string[]) => Any, options: Record<string, Any> = {}): Promise<void> {
    const html = ReactServer.renderToString(make(React, []), options);
    const reactIds: string[] = [];
    const a = box();
    a.innerHTML = html;
    ReactDOM.flushSync(() => ReactClient.hydrateRoot(a, make(React, reactIds), options));
    await tasks();
    const compatIds: string[] = [];
    const b = box();
    b.innerHTML = html;
    const before = nodes(b);
    Compat.hydrateRoot(b as unknown as Element, make(Compat, compatIds), options);
    await tasks();
    expect(reactIds.length).toBeGreaterThan(0);
    // Sorted: React hydrates a Suspense boundary's content in a later pass, compat in this one.
    // The markup below holds each id where its component put it.
    expect(compatIds.toSorted()).toEqual(reactIds.toSorted());
    expect(markup(b)).toBe(markup(a));
    expect(nodes(b)).toEqual(before);
  }

  /** A component that calls useId `n` times and shows each id in an attribute and as text. */
  const Ids = (L: Lib, ids: string[], n = 1) =>
    function Ids(props: Any) {
      const own: string[] = [];
      for (let i = 0; i < n; i++) own.push(L.useId());
      ids.push(...own);
      return L.createElement("i", { id: own[0], title: own.join(" ") }, props.children);
    };

  test("siblings in arrays, nested components and later calls (H) get React's tree ids", () =>
    hydrates((L, ids) => {
      const h = L.createElement,
        A = Ids(L, ids),
        B = Ids(L, ids, 3);
      function Row(props: Any) {
        return h("li", null, h(A), props.children);
      }
      function App() {
        return h(
          "div",
          null,
          h(A),
          "text",
          [h(B, { key: "x" }), h(Row, { key: "y" }, h(B)), null, false, h(A, { key: "z" })],
          h("section", null, h(Row, null, [h(A, { key: 1 }), h(A, { key: 2 })])),
          h(B, null, h(A)),
        );
      }
      return h(App);
    }));

  test("a component that calls useId gives its children a level of their own", () =>
    hydrates((L, ids) => {
      const h = L.createElement,
        A = Ids(L, ids);
      function Outer() {
        const id = L.useId();
        const [n] = L.useState(1);
        ids.push(id + n);
        return [h(A, { key: "a" }), h("p", { key: "b" }, h(A)), h(Inner, { key: "c" })];
      }
      function Inner() {
        L.useState(0);
        const a = L.useId(),
          b = L.useId();
        ids.push(a, b);
        return h(A);
      }
      return h(Outer);
    }));

  test("fragments, nested arrays, iterables, memo, forwardRef and providers", () =>
    hydrates((L, ids) => {
      const h = L.createElement,
        A = Ids(L, ids);
      const M = L.memo(A);
      const F = L.forwardRef(function F(_props: Any, _ref: Any) {
        ids.push(L.useId());
        return h(A);
      });
      const Ctx = L.createContext(0);
      // A single child takes no place of its own, whatever it is.
      const Text = () => "t";
      function App() {
        return h(
          L.Fragment,
          null,
          h(A),
          h(L.Fragment, { key: "f" }, h(A), [h(M, { key: "m" }), [h(F, { key: "r" }), h(A, { key: "n" })]]),
          new Set([h(A, { key: "s1" }), h(Ctx.Provider, { key: "s2", value: 1 }, h(A), h(A))]),
          h(L.StrictMode, null, h(L.Profiler, { id: "p", onRender() {} }, [h(A, { key: "q" })])),
          h("p", null, h(Text)),
        );
      }
      return h("main", null, h(App));
    }));

  test("Suspense, Activity and ViewTransition (an unnamed one adds a level)", () =>
    hydrates((L, ids) => {
      const h = L.createElement,
        A = Ids(L, ids);
      return h(
        "div",
        null,
        h(L.Suspense, { fallback: "…" }, h(A), [h(A, { key: "a" })]),
        h(L.Activity, { mode: "visible" }, h(A)),
        h(L.ViewTransition, null, h(A), h(A)),
        h(L.ViewTransition, { name: "named" }, h(A)),
        h(L.ViewTransition, { name: "auto" }, [h(A, { key: "v" })]),
      );
    }));

  test("ids in a deep tree overflow 30 bits as React's do", () =>
    hydrates((L, ids) => {
      const h = L.createElement,
        A = Ids(L, ids);
      function Level(props: Any): Any {
        if (props.n === 0) return h(A);
        return [h(A, { key: "a" }), h("b", { key: "b" }), h(Level, { key: "c", n: props.n - 1 })];
      }
      return h(Level, { n: 24 });
    }));

  test("the root's identifierPrefix and an array at the root", () =>
    hydrates(
      (L, ids) => {
        const A = Ids(L, ids);
        return [L.createElement(A, { key: "a" }), L.createElement(A, { key: "b" })];
      },
      { identifierPrefix: "pre-" },
    ));

  test("hydration leaves the client counter alone, and later mounts count from it", () => {
    const ids: string[] = [];
    const A = Ids(Compat, ids);
    const first = box();
    Compat.flushSync(() => Compat.createRoot(first as unknown as Element).render(Compat.createElement(A)));
    const html = ReactServer.renderToString(React.createElement(Ids(React, [])));
    const c = box();
    c.innerHTML = html;
    const root = Compat.hydrateRoot(c as unknown as Element, Compat.createElement(A));
    // The server's id, from the tree.
    expect(ids[1]).toBe(/id="([^"]+)"/.exec(html)![1]!);
    Compat.flushSync(() => root.render([Compat.createElement(A, { key: 1 }), Compat.createElement(A, { key: 2 })]));
    const n = (id: string): number => parseInt(id.slice(3, -1), 32);
    expect(ids[0]).toMatch(/^_r_[0-9a-v]+_$/);
    // The second mount after hydration: the next client ids after the first's.
    expect([n(ids[3]!) - n(ids[0]!), n(ids[2]!) - n(ids[0]!)]).toEqual([2, 1]);
  });
});

// #endregion
