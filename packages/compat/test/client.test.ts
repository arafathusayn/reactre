// @reactre/compat's client against React's own (react-dom@19.3.1, production builds), on the fake
// DOM.
//
// React's production client runs on the fake DOM with the few additions below (a window for its
// selection code, localName and splitText for hydration). Each test builds one tree twice, once
// from React and once from compat, renders each with its own library and expects the same: the
// ids useId gives while hydrating server HTML, the rows and their state when keys repeat, and the
// component stacks errors are reported with.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeNode, FakeText, HTML_NS, installFakeDocument } from "@reactre/testdom";

// The default entry: class support is loaded, for error boundaries.
import * as Compat from "../src/index.ts";

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

// #region Duplicate keys

describe("duplicate keys", () => {
  /**
   * A list of rows with React and with compat: each row is a component with state (its mount
   * number) and a layout effect whose cleanup logs it. render(keys) renders one row per key (a
   * key written "k:other" is a row of another type, "k:none" one that renders nothing); each
   * render expects both DOMs and both logs of unmounted rows to be equal. `shape` is where the rows go: straight in a <ul>, or returned
   * by a component inside it, between two other rows.
   */
  function lists(shape: "host" | "component" = "host") {
    const make = (L: Lib, flush: (fn: () => void) => void, createRoot: (c: Any) => Any) => {
      const c = box(),
        h = L.createElement,
        log: string[] = [];
      let n = 0;
      const row = (props: Any) => {
        const [id] = L.useState(() => ++n);
        L.useLayoutEffect(() => () => void log.push(props.k + id), []);
        return h("li", null, props.k + id);
      };
      const Row = (props: Any) => row(props),
        Other = (props: Any) => row(props),
        None = (props: Any) => (row(props), null);
      const rows = (keys: string[]) =>
        keys.map((k) => {
          const [key, type] = k.split(":");
          return h(type === "other" ? Other : type === "none" ? None : Row, { key, k: key });
        });
      const List = (props: Any) => rows(props.keys);
      const root = createRoot(c);
      const list = (keys: string[]) =>
        shape === "host" ? rows(keys) : [h("li", { key: "<" }), h(List, { key: "l", keys }), h("li", { key: ">" })];
      return { c, log, render: (keys: string[]) => flush(() => root.render(h("ul", null, list(keys)))) };
    };
    const r = make(React, ReactDOM.flushSync, ReactClient.createRoot),
      p = make(Compat, Compat.flushSync, (c) => Compat.createRoot(c as unknown as Element));
    return {
      render(keys: string[]) {
        r.render(keys);
        p.render(keys);
        expect({ dom: markup(p.c), unmounted: p.log }).toEqual({ dom: markup(r.c), unmounted: r.log });
      },
    };
  }

  test("a mount and an append render every row, repeated keys included", () => {
    const l = lists();
    l.render(["x", "x", "y", "x"]);
    l.render(["x", "x", "y", "x", "x", "z"]);
  });

  test("a key repeated among the new rows: the first takes the old row, the others mount", () => {
    const l = lists();
    l.render(["a", "b", "c"]);
    l.render(["c", "b", "b", "a"]);
  });

  test("an old key that repeats: the last old row is the one reused, the others stay in the DOM", () => {
    const l = lists();
    l.render(["a", "x", "y", "x"]);
    l.render(["y", "x", "a"]);
    l.render(["a", "y", "x", "x"]);
  });

  test("reordered and removed rows around repeated keys", () => {
    const l = lists();
    l.render(["a", "b", "x", "x", "c"]);
    l.render(["c", "x", "b", "a"]);
    l.render(["x", "y", "x", "z"]);
    l.render(["z", "y", "x", "w", "x"]);
  });

  test("a row whose key matches in place but whose type changed is replaced in place", () => {
    const l = lists();
    l.render(["x", "y", "y", "q"]);
    l.render(["x:other", "y", "z", "q"]);
    // Matching in place runs out of new rows, then of old ones.
    l.render(["x", "x", "y"]);
    l.render(["x:other", "x"]);
    l.render(["x", "x", "z"]);
  });

  test("rows that render nothing", () => {
    const l = lists();
    l.render(["x:none", "x:none", "y:none"]);
    l.render(["y:none", "x:none"]);
  });

  test("rows a component returns, between other rows of the same element", () => {
    const l = lists("component");
    l.render(["a", "x", "y", "x"]);
    l.render(["y", "x", "a"]);
    l.render(["a", "b", "x", "x", "c"]);
    l.render(["c", "x", "b", "a"]);
  });
});

// #endregion

// #region Component stacks

describe("component stacks", () => {
  /**
   * The stack React gives, each frame's location replaced with "<anonymous>": React finds a
   * function or class component's frame by calling it and reading the native stack trace
   * ("at Name (file:line:col)"), where compat writes the frame React writes when it finds none
   * ("at Name (<anonymous>)").
   */
  const names = (stack: string): string => stack.replace(/^( +at \S+) \(.*\)$/gm, "$1 (<anonymous>)");

  // A test error's message; React's own errors are minified, compat's are not.
  const message = (e: Any): string => (e.message.length < 20 ? e.message : "(React's error)");

  /**
   * Renders `make(L)` with React and with compat into roots with both error callbacks, and
   * expects the same reports, component stacks included (React's with locations replaced),
   * after `ms` more for content that waits on a promise. Returns compat's reports.
   */
  async function reports(make: (L: Lib) => Any, ms = 0): Promise<string[]> {
    const run = async (L: Lib, createRoot: (c: Any, o: Any) => Any, flush: (fn: () => void) => void) => {
      const out: string[] = [];
      const options = {
        onUncaughtError: (e: Any, info: Any) => void out.push(`uncaught ${message(e)}${info.componentStack}`),
        onCaughtError: (e: Any, info: Any) =>
          void out.push(`caught ${message(e)} by ${info.errorBoundary.constructor.name}${info.componentStack}`),
      };
      const root = createRoot(box(), options);
      flush(() => root.render(make(L)));
      await tasks();
      await new Promise((r) => setTimeout(r, ms));
      await tasks();
      return out;
    };
    const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
    const compat = await run(Compat, (c, o) => Compat.createRoot(c as unknown as Element, o), Compat.flushSync);
    expect(react.length).toBeGreaterThan(0);
    expect(compat).toEqual(react.map(names));
    return compat;
  }

  /** A component that throws `message` when it renders. */
  const Boom = (props: Any) => {
    throw new Error(props.message ?? "boom");
  };

  test("an uncaught render error: hosts, components, memo, forwardRef and arrays", async () => {
    const stacks = await reports((L) => {
      const h = L.createElement;
      const Fwd = L.forwardRef(function Field(_p: Any, _r: Any) {
        return h("label", null, h(Boom));
      });
      const Item = L.memo(function Item() {
        return h("li", null, h(Fwd));
      });
      const List = () => [h(Item, { key: 1 })];
      const Ctx = L.createContext(0);
      function App() {
        return h(Ctx.Provider, { value: 1 }, h("section", null, h(L.Fragment, null, h("ul", null, h(List)))));
      }
      return h(App);
    });
    // Each frame exactly as React writes one it found no source location for.
    const frames = ["Boom", "label", "Field", "li", "Item", "List", "ul", "section", "App"];
    expect(stacks).toEqual(["uncaught boom" + frames.map((n) => `\n    at ${n} (<anonymous>)`).join("")]);
  });

  test("an error boundary's report and componentDidCatch get the stack", async () => {
    const seen: string[] = [];
    const stacks = await reports((L) => {
      const h = L.createElement;
      class Boundary extends L.Component {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(_e: Any, info: Any) {
          seen.push(names(info.componentStack));
        }
        render() {
          return this.state.failed ? "failed" : this.props.children;
        }
      }
      const Inner = () => h("p", null, h(Boom, { message: "inner" }));
      return h("main", null, h(Boundary, null, h("div", null, h(Inner))));
    });
    // React's, then compat's: the stack the boundary's report got.
    const stack = stacks[0]!.slice(stacks[0]!.indexOf("\n"));
    expect(seen).toEqual([stack, stack]);
  });

  test("Suspense, its fallback, Activity, SuspenseList and ViewTransition name themselves", async () => {
    await reports((L) => {
      const h = L.createElement;
      const never = new Promise(() => {});
      const Wait = () => L.use(never);
      const fallback = h(Boom, { message: "fallback" });
      return h(L.Activity, { mode: "visible" }, h(L.ViewTransition, null, h(L.Suspense, { fallback }, h(Wait))));
    });
    // React's stable build has no SuspenseList to render; its describeFiber names one so.
    const stacks: string[] = [];
    const root = Compat.createRoot(box() as unknown as Element, {
      onUncaughtError: (_e, info) => void stacks.push(info.componentStack!),
    });
    const h = Compat.createElement;
    Compat.flushSync(() =>
      root.render(h(Compat.Suspense, null, h("div", null, h(Compat.SuspenseList, null, h(Boom))))),
    );
    const frames = ["Boom", "SuspenseList", "div", "Suspense"];
    expect(stacks).toEqual([frames.map((n) => `\n    at ${n} (<anonymous>)`).join("")]);
  });

  test("an effect's error starts at its component; a bad child type at its parent", async () => {
    await reports((L) => {
      const h = L.createElement;
      function Effect() {
        L.useLayoutEffect(() => {
          throw new Error("effect");
        });
        return h("i");
      }
      return h("div", null, h(Effect));
    });
    await reports((L) => {
      const h = L.createElement;
      const Parent = () => h("b", null, h({}));
      return h("div", null, h(Parent));
    });
  });

  test("a lazy component that fails to load is named Lazy; one that loaded is its component", async () => {
    const failed = Promise.reject(new Error("load"));
    failed.catch(() => {});
    const loaded = Promise.resolve({ default: Boom });
    await loaded;
    // Both libraries hold back a suspended boundary's retry for 300 ms after its fallback shows.
    for (const load of [() => failed, () => loaded])
      await reports((L) => {
        const h = L.createElement;
        return h(L.Suspense, { fallback: null }, h("div", null, h(L.lazy(load))));
      }, 400);
  });

  test("a compiled template's elements are frames too", async () => {
    const T = Compat.__template(["div", 0, ["span", 0, 0]]);
    await reports((L) => {
      const h = L.createElement;
      const Row = () => (L === Compat ? Compat.__block(T, null, [h(Boom)]) : h("div", null, h("span", null, h(Boom))));
      return h("section", null, h(Row));
    });
  });
});

// #endregion

// #region The core entry

describe("@reactre/compat/core", () => {
  // A separate instance of the module (the query string makes one), without what the default
  // entry installs into the shared one.
  const tag = "core-only";
  const core = (): Promise<typeof import("../src/core.ts")> => import(`../src/core.ts?${tag}`);

  test("reports errors with an empty component stack", async () => {
    const Core = await core();
    const stacks: unknown[] = [];
    const root = Core.createRoot(box() as unknown as Element, {
      onUncaughtError: (_e, info) => void stacks.push(info.componentStack),
    });
    const Boom = () => {
      throw new Error("boom");
    };
    Core.flushSync(() => root.render(Core.createElement("div", null, Core.createElement(Boom))));
    expect(stacks).toEqual([""]);
  });

  test("reconciles repeated keys by its own rules: no row is left outside the list", async () => {
    const Core = await core();
    const c = box(),
      h = Core.createElement,
      root = Core.createRoot(c as unknown as Element);
    const render = (keys: string[]) =>
      Core.flushSync(() =>
        root.render(
          h(
            "ul",
            null,
            keys.map((k) => h("li", { key: k }, k)),
          ),
        ),
      );
    render(["a", "x", "y", "x"]);
    render(["y", "x", "a"]);
    expect(markup(c)).toBe("<ul><li>y</li><li>x</li><li>a</li></ul>");
  });
});

// #endregion
