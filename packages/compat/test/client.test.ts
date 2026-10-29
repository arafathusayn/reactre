// @reactre/compat's client against React's own (react-dom@19.3.1, production builds), on the fake
// DOM.
//
// React's production client runs on the fake DOM with the few additions below (a window for its
// selection code, localName and splitText for hydration). Each test builds one tree twice, once
// from React and once from compat, renders each with its own library and expects the same: the
// ids useId gives while hydrating server HTML, the rows and their state when keys repeat, the
// component stacks errors are reported with, and the errors themselves: React's production codes.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, FakeNode, FakeText, HTML_NS, installFakeDocument } from "@reactre/testdom";

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
const ReactServer: Any = await load("react-dom/server.browser");
// React's client installs its own handlers for preload, preconnect and the rest, which React's
// server builds a later file loads hand what they cannot place to: the ones before it go back
// after this file.
const internals = ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const before = internals.d;
const ReactClient: Any = await load("react-dom/client");
// The client installs its handlers once, as the first file that loads it does, which keeps them in
// a global for the others; each file puts back the ones it found.
const client = ((globalThis as Any).__reactClientDispatcher ??= internals.d);
beforeAll(() => void (internals.d = client));
afterAll(() => void (internals.d = before));
if (prevEnv === undefined) delete process.env["NODE_ENV"];
else process.env["NODE_ENV"] = prevEnv;

// #region Fixtures

/**
 * Gives `target` the properties in `props` for every test of this file, and takes them off after
 * each, so other files see the plain fake DOM.
 */
function extend(target: object, props: Record<string, PropertyDescriptor>): void {
  // What another file in the same process defined there first, put back after each test.
  const found = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const k in props) {
      found.set(k, Object.getOwnPropertyDescriptor(target, k));
      Object.defineProperty(target, k, { configurable: true, ...props[k] });
    }
  });
  afterEach(() => {
    for (const k in props) {
      delete (target as Record<string, unknown>)[k];
      const d = found.get(k);
      if (d !== undefined) Object.defineProperty(target, k, d);
    }
  });
}

// What hydration reads: an element's localName and type, and a text's splitText. What React's client reads
// of the document: its window (for the focused element and the selection) and its listeners.
extend(FakeElement.prototype, {
  localName: {
    get(this: FakeElement) {
      return this.namespaceURI === HTML_NS ? this.tagName.toLowerCase() : this.tagName;
    },
  },
  // An input's type, which hydration reads to pass over a hidden one.
  type: {
    get(this: FakeElement) {
      return this.getAttribute("type") ?? "";
    },
    set(this: FakeElement, v: string) {
      this.setAttribute("type", v);
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
    Compat.flushSync(() => Compat.hydrateRoot(b as unknown as Element, make(Compat, compatIds), options));
    await tasks();
    expect(reactIds.length).toBeGreaterThan(0);
    expect(compatIds).toEqual(reactIds);
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
    const root = Compat.flushSync(() => Compat.hydrateRoot(c as unknown as Element, Compat.createElement(A)));
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
   * key written "k:other" is a row of another type, "k:none" one that renders nothing,
   * "k:settled" a row in a settled promise, and "-" is a hole, null); each
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
          if (k === "-") return null;
          const [key, type] = k.split(":");
          const el = h(type === "other" ? Other : type === "none" ? None : Row, { key, k: key });
          return type === "settled" ? { then() {}, status: "fulfilled", value: el } : el;
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

  test("rows matching at the end, where an old key repeats: matched through the key map, as React does", () => {
    const l = lists();
    // A removal at the front leaves a common end.
    l.render(["a", "x", "b", "x"]);
    l.render(["x"]);
    // A changed front with the same end.
    l.render(["a", "x", "x"]);
    l.render(["b", "x", "x"]);
    // The two ends traded places around a repeated key, with and without a common end.
    l.render(["p", "x", "x", "q", "z"]);
    l.render(["q", "x", "x", "p", "z"]);
    l.render(["p", "y", "y", "q"]);
    l.render(["q", "y", "y", "p"]);
  });

  test("rows matching at the end, where a new key repeats, around holes and settled promises", () => {
    const l = lists();
    l.render(["x"]);
    l.render(["a", "-", "x", "x"]);
    l.render(["b", "x:settled", "-", "x:settled", "z"]);
    l.render(["c", "x", "z"]);
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
  /** A stack with each frame's location replaced with "<anonymous>", to read the names alone. */
  const names = (stack: string): string => stack.replace(/^( +at \S+) \(.*\)$/gm, "$1 (<anonymous>)");

  // An error's message: React's own errors are minified, and compat's must be the same.
  const message = (e: Any): string => e.message;

  /**
   * Renders `make(L)` with React and with compat into roots with both error callbacks, and
   * expects the same reports, component stacks included, locations and all,
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
    expect(compat).toEqual(react);
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
    const frames = ["Boom", "label", "Field", "li", "Item", "List", "ul", "section", "App"];
    expect(stacks.map(names)).toEqual(["uncaught boom" + frames.map((n) => `\n    at ${n} (<anonymous>)`).join("")]);
  });

  test("a component's frame is where calling it without props throws: hooks, classes, displayName", async () => {
    const stacks = await reports((L) => {
      const h = L.createElement;
      function Counter() {
        const [n] = L.useState(0);
        return h("b", null, n, h(Boom));
      }
      class Panel extends L.Component<Any> {
        constructor(props: Any) {
          super(props);
        }
        render() {
          return h(Counter);
        }
      }
      class Plain extends L.Component<Any> {
        render() {
          return h(Panel);
        }
      }
      // Called without props, as the probe calls it, it returns a promise that rejects: no frame.
      function Odd(props: Any) {
        return props === undefined ? Promise.reject(new Error("probe")) : h(Plain);
      }
      const Anon = [(p: Any) => h("i", null, p.title, h(Odd))][0]! as Any;
      Anon.displayName = "Titled";
      return h(Anon, { title: "t" });
    });
    expect(stacks.map(names)).toEqual([
      "uncaught boom" +
        ["Boom", "b", "Counter", "Panel", "Plain", "Odd", "i", "Titled"]
          .map((n) => `\n    at ${n} (<anonymous>)`)
          .join(""),
    ]);
    // Counter's and Titled's frames are in this file, where their first line that can throw is.
    expect(stacks[0]).toMatch(/at Counter \(.*client\.test\.ts:\d+:\d+\)/);
    expect(stacks[0]).toMatch(/at Titled \(.*client\.test\.ts:\d+:\d+\)/);
  });

  test("a component whose first hook is use() of a promise has its frame, where use() throws", async () => {
    const stacks = await reports((L) => {
      const h = L.createElement;
      const ready = Object.assign(Promise.resolve("v"), { status: "fulfilled", value: "v" });
      // Without props, as the probe calls them: React's use() throws outside a render, settled
      // or not.
      function Settled() {
        return h("b", null, L.use(ready), h(Boom));
      }
      function Pending(p: Any) {
        L.use(p.data ?? new Promise(() => {}));
        return h(Settled);
      }
      return h(Pending, { data: ready });
    });
    expect(stacks[0]).toMatch(/at Settled \(.*client\.test\.ts:\d+:\d+\)/);
    expect(stacks[0]).toMatch(/at Pending \(.*client\.test\.ts:\d+:\d+\)/);
  });

  test("a stack trace too short to reach the probe gives the component's name alone, as React's", async () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 1;
    try {
      const stacks = await reports((L) => {
        const h = L.createElement;
        function Counter() {
          L.useState(0);
          return h(Boom);
        }
        return h(Counter);
      });
      expect(stacks).toEqual(["uncaught boom\n    at Boom (<anonymous>)\n    at Counter (<anonymous>)"]);
    } finally {
      Error.stackTraceLimit = limit;
    }
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
          seen.push(info.componentStack);
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
      root.render(h(Compat.Suspense, null, h("div", null, h(Symbol.for("react.suspense_list"), null, h(Boom))))),
    );
    const frames = ["Boom", "SuspenseList", "div", "Suspense"];
    expect(stacks.map(names)).toEqual([frames.map((n) => `\n    at ${n} (<anonymous>)`).join("")]);
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

// #region Hydration mismatches

describe("hydration mismatches", () => {
  /** An error's code and first argument (#418 HTML), to read the logs by; the messages are compared whole. */
  const short = (e: Any): string => {
    const m = /^Minified React error #(\d+);[^?]*(?:\?args\[\]=(\w+))?/.exec(e.message);
    return m ? m[1] + (m[2] ? " " + m[2] : "") : e.message;
  };

  /**
   * Renders `server(React)` on React's server, hydrates that HTML with `client(L, log)` on React's
   * client and on compat's, and expects the same: the markup after, which of the server's nodes
   * stayed (Y) or were replaced (n), and the log: what onRecoverableError got, component stack
   * included, in order with the effects and anything else the tree logs, and each error's whole
   * message.
   */
  async function recovers(
    server: (L: Lib) => Any,
    client: (L: Lib, log: string[]) => Any,
    options: Record<string, Any> = {},
  ): Promise<{ dom: string; kept: string; log: string[] }> {
    const html = ReactServer.renderToString(server(React), options);
    const run = async (L: Lib, hydrate: (c: Any, el: Any, o: Any) => void) => {
      const c = box();
      c.innerHTML = html;
      const before = nodes(c);
      const log: string[] = [],
        messages: string[] = [];
      const code = (e: Any): string => (messages.push(e.message), short(e));
      hydrate(c, client(L, log), {
        onRecoverableError: (e: Any, info: Any) =>
          void log.push(
            `recoverable ${code(e)}${e.digest === undefined ? "" : " " + e.digest}${e.cause === undefined ? "" : " cause " + code(e.cause)}${info.componentStack}`,
          ),
        onCaughtError: (e: Any) => void log.push("caught " + code(e)),
        onUncaughtError: (e: Any) => void log.push("uncaught " + code(e)),
      });
      await tasks();
      return {
        dom: markup(c),
        kept: nodes(c)
          .map((n) => (before.includes(n) ? "Y" : "n"))
          .join(""),
        log,
        messages,
      };
    };
    const react = await run(React, (c, el, o) => ReactDOM.flushSync(() => ReactClient.hydrateRoot(c, el, o)));
    const { messages, ...compat } = await run(Compat, (c, el, o) =>
      Compat.flushSync(() => Compat.hydrateRoot(c, el, o)),
    );
    expect({ ...compat, messages }).toEqual(react);
    return compat;
  }

  /** A component that logs its layout and passive effects. */
  const Effects = (L: Lib) =>
    function Effects(props: Any) {
      L.useLayoutEffect(() => void props.log.push("layout " + props.n), []);
      L.useEffect(() => void props.log.push("passive " + props.n), []);
      return props.children ?? null;
    };

  test("an element that does not match renders the root on the client, reported after layout effects", async () => {
    const r = await recovers(
      (L) => L.createElement("div", null, L.createElement("p", null, "a"), L.createElement("b", null, "x")),
      (L, log) => {
        const h = L.createElement,
          E = Effects(L);
        // An error boundary does not catch a mismatch.
        class Boundary extends L.Component<Any> {
          static getDerivedStateFromError() {
            return {};
          }
          render() {
            return this.props.children;
          }
        }
        function Row() {
          return h("span", null, "a");
        }
        return h(Boundary, null, h("div", null, h(E, { log, n: 1 }), h(Row), h("b", null, "x")));
      },
    );
    expect(r.kept).toBe("nnnnn");
    expect(r.log[1]).toMatch(/^recoverable 418 HTML\n {4}at span \(<anonymous>\)\n {4}at Row \(/);
  });

  test("text: a text-only element's, a text node's, and a text where an element was", async () => {
    const h = (L: Lib) => L.createElement;
    await recovers(
      (L) => h(L)("div", null, h(L)("p", null, "a")),
      (L) => h(L)("div", null, h(L)("p", null, "b")),
    );
    await recovers(
      (L) => h(L)("div", null, h(L)("p", null, "a", h(L)("i"))),
      (L) => h(L)("div", null, h(L)("p", null, "b", h(L)("i"))),
    );
    await recovers(
      (L) => h(L)("div", null, "t"),
      (L) => h(L)("div", null, h(L)("b")),
    );
    await recovers(
      (L) => h(L)("div", null, h(L)("b")),
      (L) => h(L)("div", null, "t", h(L)("b")),
    );
    // Line breaks and U+FFFD the server normalized match; suppressHydrationWarning keeps the
    // server's text without an error.
    await recovers(
      (L) => h(L)("div", null, h(L)("p", null, "a\nb"), "x", h(L)("i")),
      (L) => h(L)("div", null, h(L)("p", null, "a\r\nb"), "x�", h(L)("i")),
    );
    const kept = await recovers(
      (L) =>
        h(L)(
          "div",
          { suppressHydrationWarning: true },
          h(L)("p", { suppressHydrationWarning: true }, "a"),
          "x",
          h(L)("i"),
        ),
      (L) =>
        h(L)(
          "div",
          { suppressHydrationWarning: true },
          h(L)("p", { suppressHydrationWarning: true }, "b"),
          "y",
          h(L)("i"),
        ),
    );
    expect(kept).toEqual({ dom: "<div><p>a</p>x<i></i></div>", kept: "YYYYY", log: [] });
  });

  test("children the server has and the client does not, and the other way round", async () => {
    const h = (L: Lib) => L.createElement;
    await recovers(
      (L) => h(L)("div", null, h(L)("p", null, "a"), h(L)("b")),
      (L) => h(L)("div", null, h(L)("p", null, "a")),
    );
    await recovers(
      (L) => h(L)("div", null, h(L)("p", null, "a")),
      (L) => h(L)("div", null, h(L)("p", null, "a"), h(L)("b")),
    );
    // Not a mismatch: in the root, nodes that do not match are passed over and stay; in a form,
    // a hidden input; and an element whose HTML is set keeps the server's.
    const passed = await recovers(
      (L) => [h(L)("aside", { key: 1 }), h(L)("p", { key: 2 }, "a"), h(L)("b", { key: 3 })],
      (L) => h(L)("p", null, "a"),
    );
    expect(passed).toEqual({ dom: "<aside></aside><p>a</p><b></b>", kept: "YYYY", log: [] });
    // A hidden input the client renders too is claimed, by its name.
    await recovers(
      (L) =>
        h(L)("form", null, h(L)("input", { type: "hidden", name: "a" }), h(L)("input", { type: "hidden", name: "b" })),
      (L) => h(L)("form", null, h(L)("input", { type: "hidden", name: "b" })),
    );
    await recovers(
      (L) =>
        h(L)(
          "form",
          null,
          h(L)("input", { type: "hidden", name: "x", value: "1" }),
          h(L)("button", null, "go"),
          h(L)("i"),
          h(L)("div", { dangerouslySetInnerHTML: { __html: "<b>server</b>" } }),
        ),
      (L) =>
        h(L)(
          "form",
          null,
          h(L)("button", null, "go"),
          h(L)("i"),
          h(L)("div", { dangerouslySetInnerHTML: { __html: "<b>client</b>" } }),
        ),
    );
  });

  test("in a Suspense boundary, only the boundary renders on the client", async () => {
    const h = (L: Lib) => L.createElement;
    const r = await recovers(
      (L) =>
        h(L)(
          "main",
          null,
          h(L)("b", null, "1"),
          h(L)(L.Suspense, { fallback: "…" }, h(L)("p", null, "a"), h(L)("i")),
          h(L)("u", null, "2"),
        ),
      (L) =>
        h(L)(
          "main",
          null,
          h(L)("b", null, "1"),
          h(L)(L.Suspense, { fallback: "…" }, h(L)("span", null, "a"), h(L)("i")),
          h(L)("u", null, "2"),
        ),
    );
    expect(r.kept).toBe("YYYnnnYY");
    // Two boundaries, two errors; content the server has beyond the client's is the boundary's.
    await recovers(
      (L) =>
        h(L)(
          "main",
          null,
          h(L)(L.Suspense, { fallback: "." }, h(L)("p", null, "a")),
          h(L)(L.Suspense, { fallback: "." }, h(L)("p", null, "b"), h(L)("p", null, "c")),
        ),
      (L) =>
        h(L)(
          "main",
          null,
          h(L)(L.Suspense, { fallback: "." }, h(L)("i", null, "a")),
          h(L)(L.Suspense, { fallback: "." }, h(L)("p", null, "b")),
        ),
    );
    // The outer of two nested boundaries: it drops the inner one's nodes with its own.
    await recovers(
      (L) =>
        h(L)(
          "main",
          null,
          h(L)(
            L.Suspense,
            { fallback: "." },
            h(L)("p", null, "a"),
            h(L)(L.Suspense, { fallback: "," }, h(L)("i", null, "in")),
          ),
          h(L)("u"),
        ),
      (L) =>
        h(L)(
          "main",
          null,
          h(L)(
            L.Suspense,
            { fallback: "." },
            h(L)("s", null, "a"),
            h(L)(L.Suspense, { fallback: "," }, h(L)("i", null, "in")),
          ),
          h(L)("u"),
        ),
    );
    // A boundary the server rendered where the client renders none, and the other way round.
    await recovers(
      (L) => h(L)("main", null, h(L)(L.Suspense, { fallback: "." }, h(L)("p", null, "a"))),
      (L) => h(L)("main", null, h(L)("p", null, "a")),
    );
    await recovers(
      (L) => h(L)("main", null, h(L)("p", null, "a")),
      (L) => h(L)("main", null, h(L)(L.Suspense, { fallback: "." }, h(L)("p", null, "a"))),
    );
  });

  test("an error the root's client render throws is uncaught, and the mismatch goes unreported", async () => {
    const r = await recovers(
      (L) => L.createElement("p", null, "a"),
      (L) => {
        let renders = 0;
        function Flaky() {
          if (renders++ > 0) throw new Error("second render");
          return null;
        }
        return [L.createElement(Flaky, { key: 1 }), L.createElement("b", { key: 2 }, "a")];
      },
    );
    expect(r.log).toEqual(["uncaught second render"]);
  });

  test("a boundary the server could not finish renders on the client, reported as React reports it", async () => {
    const h = (L: Lib) => L.createElement;
    function Fails(): never {
      throw new Error("server only");
    }
    const r = await recovers(
      (L) => h(L)("main", null, h(L)(L.Suspense, { fallback: h(L)("i", null, "…") }, h(L)("p", null, h(L)(Fails)))),
      (L) => h(L)("main", null, h(L)(L.Suspense, { fallback: h(L)("i", null, "…") }, h(L)("p", null, "ok"))),
    );
    // No component stack: React reports this one with null. (renderToString writes no digest.)
    expect(r).toEqual({ dom: "<main><p>ok</p></main>", kept: "Ynn", log: ["recoverable 419null"] });
  });

  test("useSyncExternalStore hydrates with the server snapshot, then renders the store's", async () => {
    const h = (L: Lib) => L.createElement;
    // One subscribe function per log, so it stays the same across renders.
    const subs = new WeakMap<string[], Any>();
    const subscribe = (log: string[]) => {
      if (!subs.has(log)) subs.set(log, () => (log.push("subscribe"), () => {}));
      return subs.get(log);
    };
    const read = (L: Lib, log: string[], server: string | undefined) =>
      function Read() {
        const v = L.useSyncExternalStore(
          subscribe(log),
          // getSnapshot's calls are not logged: React calls it once more after a commit whose
          // snapshot or getSnapshot changed, where compat leaves the check to the subscription.
          () => "client",
          server === undefined ? undefined : () => (log.push("getServerSnapshot"), server),
        );
        L.useLayoutEffect(() => void log.push("layout " + v));
        L.useEffect(() => void log.push("passive " + v));
        log.push("render " + v);
        return v;
      };
    // The server's text hydrates; after the passive effects the store's snapshot renders.
    const changed = await recovers(
      (L) => h(L)("div", null, h(L)(read(L, [], "server"))),
      (L, log) => h(L)("div", null, h(L)(read(L, log, "server"))),
    );
    expect(changed.kept).toBe("YY");
    expect(changed.log).toEqual([
      "getServerSnapshot",
      "render server",
      "layout server",
      "subscribe",
      "passive server",
      "render client",
      "layout client",
      "passive client",
    ]);
    // The same snapshot: nothing renders again.
    const same = await recovers(
      (L) => h(L)("div", null, h(L)(read(L, [], "client"))),
      (L, log) => h(L)("div", null, h(L)(read(L, log, "client"))),
    );
    expect(same.log).toEqual(["getServerSnapshot", "render client", "layout client", "subscribe", "passive client"]);
    // Without getServerSnapshot, #407 is the cause of a recoverable error: #423 where the root
    // renders on the client, #422 where a Suspense boundary does.
    const root = await recovers(
      (L) => h(L)("div", null, h(L)(read(L, [], "server"))),
      (L, log) => h(L)("div", null, h(L)(read(L, log, undefined))),
    );
    expect(root.kept).toBe("nn");
    expect(root.log[2]).toStartWith("recoverable 423 cause 407\n    at Read (");
    const boundary = await recovers(
      (L) =>
        h(L)(
          "div",
          null,
          h(L)("b", null, "x"),
          h(L)(L.Suspense, { fallback: "…" }, h(L)("p", null, h(L)(read(L, [], "server")))),
        ),
      (L, log) =>
        h(L)(
          "div",
          null,
          h(L)("b", null, "x"),
          h(L)(L.Suspense, { fallback: "…" }, h(L)("p", null, h(L)(read(L, log, undefined)))),
        ),
    );
    expect(boundary.kept).toBe("YYYnn");
    expect(boundary.log.some((l) => l.startsWith("recoverable 422 cause 407\n    at Read ("))).toBe(true);
  });

  test("useSyncExternalStoreWithSelector hydrates with the selection of the server snapshot", async () => {
    // React's selector hook (use-sync-external-store/with-selector) hands useSyncExternalStore a
    // server getter that selects through the client's memo: a client snapshot that is the
    // server's, or a selection isEqual calls equal, renders nothing again.
    const run = async (server: Any, client: Any, isEqual?: (a: Any, b: Any) => boolean) => {
      const c = box();
      c.innerHTML = ReactServer.renderToString(React.createElement("p", null, server.n));
      const log: string[] = [];
      function Read() {
        const v = Compat.useSyncExternalStoreWithSelector(
          noSubscription,
          () => client,
          () => server,
          (s: Any) => ({ n: s.n }),
          isEqual,
        );
        log.push("render " + v.n);
        return Compat.createElement("p", null, v.n);
      }
      Compat.hydrateRoot(c as unknown as Element, Compat.createElement(Read), {
        onRecoverableError: (e: Any) => void log.push("recoverable " + e.message),
      });
      await tasks();
      return [...log, markup(c)];
    };
    const noSubscription = () => () => {};
    const one = { n: 1 };
    expect(await run(one, one)).toEqual(["render 1", "<p>1</p>"]);
    expect(await run(one, { n: 1 }, (a, b) => a.n === b.n)).toEqual(["render 1", "<p>1</p>"]);
    expect(await run(one, { n: 2 })).toEqual(["render 1", "render 2", "<p>2</p>"]);
    // Without a server snapshot, the root renders on the client.
    const c = box();
    c.innerHTML = "<p>1</p>";
    const errors: string[] = [];
    Compat.hydrateRoot(
      c as unknown as Element,
      Compat.createElement(function Read() {
        const n = Compat.useSyncExternalStoreWithSelector(
          noSubscription,
          () => one,
          null,
          (s: Any) => s.n,
        );
        return Compat.createElement("p", null, n);
      }),
      { onRecoverableError: (e: Any) => void errors.push(short(e) + " cause " + short(e.cause)) },
    );
    await tasks();
    expect(errors).toEqual(["423 cause 407"]);
    expect(markup(c)).toBe("<p>1</p>");
  });
});

// #endregion

// #region Hydration passes

describe("hydration passes", () => {
  // React's client, outside flushSync, reads window.event for an update's lane; Activity hides
  // content with a style declaration, here one that writes the element's style attribute.
  beforeEach(() => void ((globalThis as Any).window = { event: undefined }));
  afterEach(() => void delete (globalThis as Any).window);
  const styles = new WeakMap<object, Any>();
  extend(FakeElement.prototype, {
    style: {
      get(this: FakeElement) {
        let s = styles.get(this);
        if (s !== undefined) return s;
        const el = this,
          props = new Map<string, string>();
        for (const part of (el.getAttribute("style") ?? "").split(";")) {
          const at = part.indexOf(":");
          if (at > 0) props.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
        }
        const write = (k: string, v: string): void => {
          if (v === "") props.delete(k);
          else props.set(k, v);
          el.setAttribute("style", [...props].map(([n, x]) => `${n}:${x}`).join(";"));
        };
        s = new Proxy(
          {},
          {
            get: (_, k: string) =>
              k === "setProperty"
                ? (n: string, v: string, important?: string) => write(n, v + (important ? " !" + important : ""))
                : k === "removeProperty"
                  ? (n: string) => write(n, "")
                  : (props.get(k) ?? ""),
            set: (_, k: string, v: string) => (write(k, "" + v), true),
          },
        );
        styles.set(this, s);
        return s;
      },
    },
  });

  /** An error's code (with #418's first argument) or message. */
  const short = (e: Any): string => {
    const m = /^Minified React error #(\d+);[^?]*(?:\?args\[\]=(\w+))?/.exec(e?.message ?? "");
    return m ? m[1] + (m[2] ? " " + m[2] : "") : String(e?.message ?? e);
  };
  /** Long enough for each library's tasks: React's scheduler and compat's passes. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };

  type Step = (c: Any, log: string[], L: Lib) => unknown;

  /**
   * Hydrates `html` with `client(L, log)` on React's client and on compat's, outside flushSync
   * unless `sync`, runs `now` as hydrateRoot returns, then each step after the work before it
   * settled, and expects the same of
   * both: the log, in order, of what the tree logs, what the root's callbacks get (component
   * stacks to their first frame), "returned" when hydrateRoot returns and the markup after each
   * step, and which of the server's nodes stayed (Y) or were replaced (n).
   */
  async function timeline(
    html: string,
    client: (L: Lib, log: string[]) => Any,
    { sync = false, now, steps = [] }: { sync?: boolean; now?: Step; steps?: Step[] } = {},
  ): Promise<{ log: string[]; kept: string }> {
    const run = async (L: Lib) => {
      const c = box();
      c.innerHTML = html;
      const before = nodes(c);
      const log: string[] = [];
      const options = {
        onRecoverableError: (e: Any, info: Any) =>
          void log.push(
            `recoverable ${short(e)}${e.cause === undefined ? "" : " cause " + short(e.cause)} ${info.componentStack?.split("\n")[1]?.trim()}`,
          ),
        onCaughtError: (e: Any) => void log.push("caught " + short(e)),
        onUncaughtError: (e: Any) => void log.push("uncaught " + short(e)),
      };
      const hydrate = () => (L === React ? ReactClient : L).hydrateRoot(c, client(L, log), options);
      if (sync) (L === React ? ReactDOM : L).flushSync(hydrate);
      else hydrate();
      log.push("returned");
      if (now) now(c, log, L);
      for (const step of [() => {}, ...steps]) {
        await step(c, log, L);
        await settle();
        log.push(markup(c));
      }
      return {
        log,
        kept: nodes(c)
          .map((n) => (before.includes(n) ? "Y" : "n"))
          .join(""),
      };
    };
    const react = await run(React);
    const compat = await run(Compat);
    expect(compat).toEqual(react);
    return compat;
  }

  /** A component that logs its renders and its layout and passive effects (and their cleanups). */
  const Logs = (L: Lib, log: string[]) =>
    function Logs(props: Any) {
      log.push("render " + props.n);
      L.useLayoutEffect(() => (log.push("layout " + props.n), () => void log.push("unlayout " + props.n)), []);
      L.useEffect(() => void log.push("passive " + props.n), []);
      return props.children ?? null;
    };

  test("the shell hydrates in a task, then each level of Suspense boundaries in a pass of its own", async () => {
    const tree = (L: Lib, log: string[]) => {
      const h = L.createElement,
        E = Logs(L, log);
      return h(
        "main",
        null,
        h(E, { n: "shell" }),
        h(
          L.Suspense,
          { fallback: "." },
          h("p", null, h(E, { n: "a" }), h(L.Suspense, { fallback: "," }, h(E, { n: "a.a" }, h("i", null, "in")))),
        ),
        h(L.Suspense, { fallback: "." }, h(E, { n: "b" }, h("p", null, "b"))),
        h(E, { n: "shell 2" }),
      );
    };
    const html = ReactServer.renderToString(tree(React, []));
    const r = await timeline(html, tree);
    expect(r.log.slice(0, 2)).toEqual(["returned", "render shell"]);
    expect(r.log.indexOf("render a")).toBeGreaterThan(r.log.indexOf("passive shell 2"));
    expect(r.log.indexOf("render a.a")).toBeGreaterThan(r.log.indexOf("passive b"));
    expect(r.kept).not.toContain("n");
    // Inside flushSync the shell hydrates before hydrateRoot returns; the boundaries still wait.
    const s = await timeline(html, tree, { sync: true });
    expect(s.log.indexOf("returned")).toBe(s.log.indexOf("passive shell 2") + 1);
  });

  test("a boundary the server could not finish renders on the client first, in a pass of its own", async () => {
    function Fails(): never {
      throw new Error("server only");
    }
    const server = (L: Lib, inner: Any) =>
      L.createElement(
        "main",
        null,
        L.createElement(L.Suspense, { fallback: "." }, L.createElement("p", null, "a")),
        L.createElement(L.Suspense, { fallback: "!" }, L.createElement("p", null, inner)),
      );
    const html = ReactServer.renderToString(server(React, React.createElement(Fails)));
    const client = (L: Lib, log: string[]) => {
      const E = Logs(L, log);
      return L.createElement(
        "main",
        null,
        L.createElement(E, { n: "shell" }),
        L.createElement(L.Suspense, { fallback: "." }, L.createElement(E, { n: "a" }, L.createElement("p", null, "a"))),
        L.createElement(L.Suspense, { fallback: "!" }, L.createElement(E, { n: "b" }, L.createElement("p", null, "b"))),
      );
    };
    const r = await timeline(html, client);
    expect(r.log.indexOf("recoverable 419 undefined")).toBeLessThan(r.log.indexOf("render a"));
    await timeline(html, client, { sync: true });
  });

  test("a mismatch is reported with the layout effects of the pass it was found in", async () => {
    const h = (L: Lib) => L.createElement;
    const r = await timeline(
      ReactServer.renderToString(
        h(React)("main", null, h(React)("b"), h(React)(React.Suspense, { fallback: "." }, h(React)("p", null, "a"))),
      ),
      (L, log) =>
        h(L)(
          "main",
          null,
          h(L)(Logs(L, log), { n: "shell" }),
          h(L)("b"),
          h(L)(L.Suspense, { fallback: "." }, h(L)(Logs(L, log), { n: "a" }, h(L)("span", null, "a"))),
        ),
    );
    expect(r.log).toContain("recoverable 418 HTML at span (<anonymous>)");
    expect(r.kept).toBe("YYnn");
    // In the shell: the root renders on the client, boundaries and all, in that render.
    await timeline(
      ReactServer.renderToString(
        h(React)("main", null, h(React)("b"), h(React)(React.Suspense, { fallback: "." }, h(React)("p", null, "a"))),
      ),
      (L, log) =>
        h(L)(
          "main",
          null,
          h(L)(Logs(L, log), { n: "shell" }),
          h(L)("i"),
          h(L)(L.Suspense, { fallback: "." }, h(L)(Logs(L, log), { n: "a" }, h(L)("p", null, "a"))),
        ),
    );
  });

  test("content that suspends while hydrating keeps the server's HTML, and hydrates once ready", async () => {
    const h = (L: Lib) => L.createElement;
    const html = ReactServer.renderToString(
      h(React)(
        "main",
        null,
        h(React)(React.Suspense, { fallback: "…" }, h(React)("p", null, "a"), h(React)("p", null, "b")),
      ),
    );
    const go: Record<string, () => void> = {};
    const r = await timeline(
      html,
      (L, log) => {
        let ready = false;
        const p = new Promise<void>((r) => (go[L === React ? "react" : "compat"] = r)).then(() => void (ready = true));
        function Late() {
          log.push("render late " + ready);
          if (!ready) throw p;
          return h(L)("p", null, "b");
        }
        return h(L)(
          "main",
          null,
          h(L)(Logs(L, log), { n: "shell" }),
          h(L)(L.Suspense, { fallback: "…" }, h(L)(Logs(L, log), { n: "a" }, h(L)("p", null, "a")), h(L)(Late)),
        );
      },
      { steps: [(_c, log, L) => (log.push("resolve"), go[L === React ? "react" : "compat"]!())] },
    );
    expect(r.kept).not.toContain("n");
    expect(r.log.filter((l) => l.startsWith("render late"))).toEqual(["render late false", "render late true"]);
    const key = (L: Lib) => (L === React ? "react" : "compat");
    /** Content that suspends until `go[key(L)]` runs. */
    const late = (L: Lib, log: string[]) => {
      let ready = false;
      const p = new Promise<void>((r) => (go[key(L)] = r)).then(() => void (ready = true));
      return function Late() {
        log.push("render late " + ready);
        if (!ready) throw p;
        return h(L)("p", null, "b");
      };
    };
    const resolve: Step = (_c, log, L) => (log.push("resolve"), go[key(L)]!());
    // In the shell, with no boundary above it: the root waits, keeping the server's HTML, and
    // hydrates once more first, as React's prerender.
    const flat = ReactServer.renderToString(h(React)("main", null, h(React)("p", null, "a"), h(React)("p", null, "b")));
    const shell = await timeline(flat, (L, log) => h(L)("main", null, h(L)("p", null, "a"), h(L)(late(L, log))), {
      steps: [resolve],
    });
    expect(shell.kept).not.toContain("n");
    // An Activity that mounts while a boundary waits mounts as on the client.
    const toggles: Record<string, () => void> = {};
    await timeline(
      html,
      (L, log) => {
        function Toggle() {
          const [on, set] = L.useState(false);
          toggles[key(L)] = () => set(true);
          return on ? h(L)(L.Activity, { mode: "visible" }, h(L)("i", null, "x")) : null;
        }
        return h(L)(
          "main",
          null,
          h(L)(Logs(L, log), { n: "shell" }),
          h(L)(L.Suspense, { fallback: "…" }, h(L)("p", null, "a"), h(L)(late(L, log))),
          h(L)(Toggle),
        );
      },
      { steps: [(_c, log, L) => (log.push("toggle"), toggles[key(L)]!()), resolve] },
    );
  });

  test("a boundary still streaming in waits for the server, through _reactRetry and the document's load", async () => {
    const h = (L: Lib) => L.createElement;
    const loaded: Any[] = [];
    Object.defineProperties(fakeDoc, {
      readyState: { configurable: true, writable: true, value: "loading" },
      addEventListener: {
        configurable: true,
        writable: true,
        value: (type: string, fn: Any) => void loaded.push(type, fn),
      },
      removeEventListener: {
        configurable: true,
        writable: true,
        value: (_type: string, fn: Any) => void loaded.splice(loaded.indexOf(fn) - 1, 2),
      },
    });
    const client = (L: Lib, log: string[]) =>
      h(L)(
        "main",
        null,
        h(L)(Logs(L, log), { n: "shell" }),
        h(L)(L.Suspense, { fallback: "…" }, h(L)(Logs(L, log), { n: "b" }, h(L)("p", null, "b"))),
      );
    /** What React's streaming runtime does as the boundary's content arrives ($RV), or fails ($RX). */
    const arrive = (c: Any, as: string) => {
      const start = c.firstChild.firstChild;
      while (start.nextSibling.nodeType !== 8) c.firstChild.removeChild(start.nextSibling);
      if (as === "$") c.firstChild.insertBefore(new FakeElement("P"), start.nextSibling).appendChild(new FakeText("b"));
      start.data = as;
      return start._reactRetry;
    };
    const pending = '<main><!--$?--><template id="B:0"></template>…<!--/$--></main>';
    // While the document loads, nothing hydrates until the content arrives.
    const r = await timeline(pending, client, {
      steps: [
        (c, log) => void log.push("retry " + typeof c.firstChild.firstChild._reactRetry, "listeners " + loaded.length),
        (c) => arrive(c, "$")(),
      ],
    });
    expect(r.log).toContain("render b");
    expect(loaded).toHaveLength(0);
    // The document loads first: the boundary renders on the client.
    await timeline(pending, client, {
      steps: [() => ((fakeDoc.readyState = "complete"), loaded[1]()), () => void (fakeDoc.readyState = "loading")],
    });
    // The server fails it ($RX).
    await timeline(pending, client, { steps: [(c) => arrive(c, "$!")()] });
    // `<!--$~-->`: complete, waiting to be revealed, which calls _reactRetry.
    await timeline("<main><!--$~--><p>b</p><!--/$--></main>", client, {
      steps: [(c) => void (c.firstChild.firstChild.data = "$"), (c) => c.firstChild.firstChild._reactRetry()],
    });
    // Once the document has loaded, a boundary still pending renders on the client at once.
    fakeDoc.readyState = "complete";
    await timeline(pending, client);
    // The shared document goes back to how other files find it.
    delete fakeDoc.readyState;
    delete fakeDoc.addEventListener;
    delete fakeDoc.removeEventListener;
  });

  test("an Activity hydrates in a pass of its own and recovers on its own; a hidden one renders on the client", async () => {
    const h = (L: Lib) => L.createElement;
    const html = ReactServer.renderToString(
      h(React)(
        "main",
        null,
        h(React)(React.Activity, { mode: "visible" }, h(React)("p", null, "a")),
        h(React)(React.Activity, { mode: "hidden" }, h(React)("p", null, "h")),
        h(React)(React.Suspense, { fallback: "." }, h(React)("p", null, "c")),
      ),
    );
    const client = (tag: string) => (L: Lib, log: string[]) =>
      h(L)(
        "main",
        null,
        h(L)(Logs(L, log), { n: "shell" }),
        h(L)(L.Activity, { mode: "visible" }, h(L)(Logs(L, log), { n: "a" }, h(L)(tag, null, "a"))),
        h(L)(L.Activity, { mode: "hidden" }, h(L)(Logs(L, log), { n: "h" }, h(L)("p", null, "h"))),
        h(L)(L.Suspense, { fallback: "." }, h(L)(Logs(L, log), { n: "c" }, h(L)("p", null, "c"))),
      );
    // The hidden Activity's nodes are new, put where React puts them: before the next host node.
    expect((await timeline(html, client("p"))).kept).toBe("YYYYYYnnYYY");
    expect((await timeline(html, client("i"))).log).toContain("recoverable 418 HTML at i (<anonymous>)");
  });

  test("an error thrown while hydrating renders the root or the boundary on the client, reported as #423 or #422", async () => {
    const h = (L: Lib) => L.createElement;
    const flat = ReactServer.renderToString(h(React)("main", null, h(React)("p", null, "a")));
    const boundary = ReactServer.renderToString(
      h(React)("main", null, h(React)(React.Suspense, { fallback: "." }, h(React)("p", null, "a"))),
    );
    /** A boundary that renders "caught" for any error below it. */
    const Catch = (L: Lib) =>
      class Catch extends L.Component<Any, Any> {
        state = { e: null };
        static getDerivedStateFromError(e: Any) {
          return { e };
        }
        render() {
          return this.state.e ? "caught" : this.props.children;
        }
      };
    /**
     * A client tree whose Boom throws on its first `throws` renders (every render, for
     * Infinity). It logs each call, those that build component stacks included, unless `quiet`.
     */
    const client =
      (where: "shell" | "boundary", catches: "none" | "inside" | "outside", throws: number, quiet = false) =>
      (L: Lib, log: string[]) => {
        let n = 0;
        function Boom(props: Any) {
          if (!quiet || props.n) log.push("boom");
          if (n++ < throws) throw new Error("boom");
          return h(L)("p", null, "a");
        }
        const C = Catch(L);
        let tree = h(L)(Boom, { n: 1 });
        if (catches === "inside") tree = h(L)(C, null, tree);
        if (where === "boundary") tree = h(L)(L.Suspense, { fallback: "." }, tree);
        if (catches === "outside") tree = h(L)(C, null, tree);
        return h(L)("main", null, h(L)(Logs(L, log), { n: "shell" }), tree);
      };
    const root = await timeline(flat, client("shell", "none", 1));
    expect(root.log).toContain("recoverable 423 cause boom at Boom (<anonymous>)");
    expect(root.kept).toBe("nnn");
    await timeline(flat, client("shell", "inside", 1));
    await timeline(flat, client("shell", "outside", 1));
    for (const catches of ["none", "inside", "outside"] as const) {
      const once = await timeline(boundary, client("boundary", catches, 1));
      expect(once.log).toContain("recoverable 422 cause boom at Boom (<anonymous>)");
    }
    // An error the client render throws again: an error boundary catches it, and the pass reports
    // nothing it recovered from; with none, it is uncaught.
    for (const catches of ["none", "inside", "outside"] as const) {
      await timeline(flat, client("shell", catches, Infinity, true));
      await timeline(boundary, client("boundary", catches, Infinity, true));
    }
  });

  test("the latest continuous event of each kind waits for its target to hydrate, which goes first, then is dispatched again", async () => {
    const h = (L: Lib) => L.createElement;
    const tree = (L: Lib, log: string[]) => {
      const on = (n: string) => {
        const props: Any = {};
        for (const k of ["MouseOver", "MouseEnter", "MouseOut", "PointerOver", "PointerEnter", "Focus", "DragEnter"])
          props["on" + k] = (e: Any) => void log.push(`${k} ${n}${e.pointerId === undefined ? "" : " " + e.pointerId}`);
        return props;
      };
      return h(L)(
        "main",
        on("main"),
        h(L)(Logs(L, log), { n: "shell" }),
        h(L)(
          L.Suspense,
          { fallback: "." },
          h(L)(
            Logs(L, log),
            { n: "a" },
            h(L)("p", on("p"), "a"),
            h(L)(L.Suspense, { fallback: "," }, h(L)(Logs(L, log), { n: "a.a" }, h(L)("b", on("b"), "in"))),
          ),
        ),
        h(L)(L.Suspense, { fallback: "." }, h(L)(Logs(L, log), { n: "c" }, h(L)("i", on("i"), "c"))),
      );
    };
    const html = ReactServer.renderToString(tree(React, []));
    /** Dispatches each [type, tag, pointerId] from the first element named tag. */
    const fire =
      (...events: [string, string, number?][]): Step =>
      (c, log) => {
        for (const [type, tag, id] of events) {
          const at = nodes(c).find((n) => n.nodeName === tag) as FakeElement;
          log.push(`fire ${type} ${tag}`);
          at.dispatchEvent(new FakeEvent(type, id === undefined ? undefined : { pointerId: id }));
        }
      };
    // The latest of a kind replaces the one before; each pointer keeps its own. What blocks them
    // hydrates before the other boundary, inner boundaries in turn.
    await timeline(html, tree, {
      sync: true,
      now: fire(
        ["mouseover", "P"],
        ["mouseover", "B"],
        ["pointerover", "P", 1],
        ["pointerover", "B", 2],
        ["focusin", "P"],
        ["dragenter", "I"],
        ["gotpointercapture", "B", 1],
      ),
    });
    // One that drops its kind: nothing is dispatched again, and nothing hydrates sooner.
    await timeline(html, tree, {
      sync: true,
      now: fire(["mouseover", "P"], ["mouseout", "P"], ["focusin", "P"], ["focusout", "MAIN"]),
    });
    // Before the shell hydrated: it waits for the shell; once all hydrated, it goes at once.
    await timeline(html, tree, { now: fire(["mouseover", "MAIN"]), steps: [fire(["mouseover", "I"])] });
  });

  test("a click inside a dehydrated boundary hydrates it, outermost first, before its handlers run", async () => {
    const h = (L: Lib) => L.createElement;
    const tree = (late: boolean) => (L: Lib, log: string[]) => {
      // Content that suspends while it hydrates, until the step that resolves it.
      let ready = !late;
      const p = new Promise<void>((r) => (go[L === React ? "react" : "compat"] = r)).then(() => void (ready = true));
      function Late(props: Any) {
        if (!ready) throw p;
        return props.children;
      }
      const on = (n: string) => ({
        onClick: () => void log.push("click " + n),
        onWheel: () => void log.push("wheel " + n),
      });
      return h(L)(
        "main",
        { onClickCapture: () => void log.push("capture main"), ...on("main") },
        h(L)(Logs(L, log), { n: "shell" }),
        h(L)(
          L.Suspense,
          { fallback: "." },
          h(L)(
            Logs(L, log),
            { n: "a" },
            h(L)(
              "p",
              on("p"),
              "a",
              h(L)(
                L.Suspense,
                { fallback: "," },
                h(L)(Late, null, h(L)(Logs(L, log), { n: "a.a" }, h(L)("b", on("b"), "in"))),
              ),
            ),
            h(L)(L.Suspense, { fallback: "," }, h(L)("u", null, "u")),
            h(L)("i", on("i"), "i"),
          ),
        ),
        h(L)(L.Suspense, { fallback: "." }, h(L)(Logs(L, log), { n: "c" }, h(L)("p", null, "c"))),
      );
    };
    const go: Record<string, () => void> = {};
    const html = ReactServer.renderToString(tree(false)(React, []));
    /** Dispatches `type` from the first element named `tag` in `c`, logging around it. */
    const fire =
      (tag: string, type = "click"): Step =>
      (c, log) => {
        const at = nodes(c).find((n) => n.nodeName === tag) as FakeElement;
        log.push("fire " + type + " " + tag);
        at.dispatchEvent(new FakeEvent(type));
        log.push("fired");
      };
    // Each boundary the target is in hydrates, outermost first, its passive effects included,
    // then the handlers run; the other boundary waits for its pass.
    const r = await timeline(html, tree(false), { sync: true, now: fire("B") });
    expect(r.log.indexOf("click b")).toBeGreaterThan(r.log.indexOf("passive a.a"));
    expect(r.log.indexOf("render c")).toBeGreaterThan(r.log.indexOf("fired"));
    // Past a boundary nested in the one it is in, only the outer one hydrates.
    await timeline(html, tree(false), { sync: true, now: fire("I") });
    // Before the shell hydrated, it hydrates first; after, on the shell, nothing has to.
    await timeline(html, tree(false), { now: fire("MAIN") });
    await timeline(html, tree(false), { sync: true, now: fire("MAIN") });
    // A node no root rendered, in the shell: the shell's handlers get it at once.
    await timeline(html, tree(false), {
      sync: true,
      now: (c, log) => {
        const stray = new FakeElement("S");
        c.firstChild.appendChild(stray);
        const e = new FakeEvent("click");
        e.target = stray;
        (c.firstChild as FakeElement).dispatchEvent(e);
        log.push("fired");
      },
    });
    // Once it all hydrated, a click is dispatched as any.
    await timeline(html, tree(false), { steps: [fire("B")] });
    // An event React does not replay reaches no handler while its target is dehydrated.
    await timeline(html, tree(false), { sync: true, now: fire("B", "wheel"), steps: [fire("B", "wheel")] });
    // Content that cannot hydrate yet stops the click, and hydrates once it can.
    await timeline(html, tree(true), {
      sync: true,
      now: fire("B"),
      steps: [(_c, log, L) => (log.push("resolve"), go[L === React ? "react" : "compat"]!()), fire("B")],
    });
  });

  test("a claimed element keeps the server's attributes until a prop changes; fields take what React's hydrateInstance writes", () => {
    const server =
      '<div title="server" class="s" style="color:red" data-x="1">t</div>' +
      '<input name="sn" value="sv" checked=""/><input type="checkbox" checked=""/><input type="submit"/>' +
      '<textarea>tx</textarea><textarea>old</textarea><my-el foo="1" class="s"></my-el>';
    const tree = (L: Lib, n: number) => {
      const h = L.createElement;
      return h(
        L.Fragment,
        null,
        h("div", { title: "client" + n, className: "c", style: { color: "blue" } }, "t"),
        h("input", { name: "cn", defaultValue: "cv", defaultChecked: false, onChange: () => {} }),
        h("input", { type: "checkbox", checked: n > 0, onChange: () => {} }),
        h("input", { type: "submit" }),
        h("textarea", { defaultValue: "tx" }),
        h("textarea", { value: "new", onChange: () => {} }),
        h("my-el", { foo: 2, className: "c" }),
      );
    };
    // The markup, and the fields' properties. React's updateInput clears a field's name before
    // it writes or removes it: in a browser, where name reflects the attribute, that is no change.
    const snap = (c: FakeElement) =>
      markup(c) +
      JSON.stringify(
        nodes(c)
          .filter((n: Any) => n.nodeName === "INPUT" || n.nodeName === "TEXTAREA" || n.nodeName === "MY-EL")
          .map((n: Any) => [n.value, n.defaultValue, n.checked, n.defaultChecked, n.name || null, n.foo]),
      );
    const run = (L: Lib) => {
      const c = box();
      c.innerHTML = server;
      const sync = (L === React ? ReactDOM : L).flushSync;
      let root: Any;
      sync(() => void (root = (L === React ? ReactClient : L).hydrateRoot(c, tree(L, 0))));
      const out = [snap(c)];
      sync(() => root.render(tree(L, 1)));
      out.push(snap(c));
      return out;
    };
    const react = run(React);
    // The server's attributes stay; the changed title is written, the rest is not.
    expect(react[1]).toContain('<div class="s" title="client1" style="color:red" data-x="1">');
    expect(run(Compat)).toEqual(react);
  });

  test("a claimed textarea takes its children as its value, and throws React's errors for both or several", async () => {
    const h = (L: Lib) => L.createElement;
    for (const props of [{ children: ["a"] }, { children: "a", defaultValue: "a" }, { children: ["a", "b"] }])
      await timeline("<textarea>a</textarea>", (L) => h(L)("textarea", props));
  });

  test("an update that reaches a dehydrated boundary hydrates it first, with what it had, then renders", async () => {
    const h = (L: Lib) => L.createElement;
    const key = (L: Lib) => (L === React ? "react" : "compat");
    const sets: Record<string, (v: string) => void> = {};
    const ctxs = new Map<Lib, Any>();
    /**
     * A shell whose state reaches two boundaries, the logging one last: by its props, by context,
     * or by neither (its element made once). React renders the shell before it hydrates each
     * boundary it reaches, a render it drops, and once more after.
     */
    const tree = (by: "props" | "context" | "neither") => (L: Lib, log: string[]) => {
      if (!ctxs.has(L)) ctxs.set(L, L.createContext("c0"));
      const Ctx = ctxs.get(L);
      function Leaf(p: Any) {
        const c = L.useContext(Ctx);
        log.push(`render leaf ${p.v} ${c}`);
        L.useLayoutEffect(() => (log.push(`layout leaf ${p.v} ${c}`), () => void log.push("unlayout leaf")));
        L.useEffect(() => void log.push(`passive leaf ${p.v} ${c}`));
        return h(L)("p", null, p.v + c);
      }
      function App() {
        const [v, set] = L.useState("a");
        sets[key(L)] = set;
        log.push("render app " + v);
        const once = L.useMemo(() => h(L)(Leaf, { v: "a" }), []);
        const body = h(L)(
          "main",
          null,
          h(L)("b", null, v),
          h(L)(L.Suspense, { fallback: "." }, h(L)("i", null, "x")),
          h(L)(L.Suspense, { fallback: "." }, by === "props" ? h(L)(Leaf, { v }) : once),
        );
        return by === "context" ? h(L)(Ctx.Provider, { value: v === "a" ? "c0" : "c1" }, body) : body;
      }
      return h(L)(App);
    };
    const update =
      (sync: boolean): Step =>
      (_c, log, L) => {
        log.push("update");
        const go = () => sets[key(L)]!("b");
        if (sync) (L === React ? ReactDOM : L).flushSync(go);
        else go();
        log.push("updated");
      };
    for (const by of ["props", "context", "neither"] as const) {
      const html = ReactServer.renderToString(tree(by)(React, []));
      for (const sync of [true, false]) {
        const r = await timeline(html, tree(by), { sync: true, now: update(sync) });
        expect(r.kept).not.toContain("n");
      }
    }
    // Content that cannot hydrate yet renders on the client when the update reaches it, as
    // React's client render without hydrating, and nothing is reported.
    const never = new Promise<void>(() => {});
    const late = (L: Lib, log: string[]) => {
      function Late(): never {
        throw never;
      }
      function App() {
        const [v, set] = L.useState("a");
        sets[key(L)] = set;
        log.push("render app " + v);
        return h(L)("main", null, h(L)("b", null, v), h(L)(L.Suspense, { fallback: "F" }, h(L)(Late, { v })));
      }
      return h(L)(App);
    };
    const served = ReactServer.renderToString(
      h(React)(
        "main",
        null,
        h(React)("b", null, "a"),
        h(React)(React.Suspense, { fallback: "F" }, h(React)("p", null, "a")),
      ),
    );
    // (Once the content is ready they differ as they do for any client render that suspended:
    // React mounts it hidden, then reveals it.)
    for (const sync of [true, false]) await timeline(served, late, { sync: true, now: update(sync) });
  });

  // React's clearContainerSparingly reads a link's rel.
  extend(FakeElement.prototype, {
    rel: {
      get(this: FakeElement) {
        return this.getAttribute("rel") ?? "";
      },
    },
  });

  test("a whole document that renders on the client keeps its <html>, <head> and <body>, as React's singletons do", async () => {
    // A document: its doctype and the server's markup, and what React reads of one.
    const page = (inner: string): Any => {
      const d: Any = new FakeElement("#document");
      Object.defineProperty(d, "nodeType", { value: 9 });
      d.isDocument = true;
      d.appendChild(new FakeNode(10));
      const tmp = new FakeElement("DIV");
      tmp.innerHTML = inner;
      for (const n of [...tmp.childNodes]) d.appendChild(n);
      const named = (p: Any, name: string): Any => (p?.childNodes ?? []).find((n: Any) => n.nodeName === name) ?? null;
      Object.defineProperties(d, {
        documentElement: { get: () => named(d, "HTML") },
        head: { get: () => named(named(d, "HTML"), "HEAD") },
        body: { get: () => named(named(d, "HTML"), "BODY") },
      });
      for (const k of ["createElement", "createTextNode"]) d[k] = (document as Any)[k].bind(document);
      d.defaultView = { document: d, HTMLIFrameElement: class {}, getSelection: () => null };
      return d;
    };
    // What the client renders drops all but its scripts, styles and stylesheets.
    const server =
      '<html lang="en" data-x="1"><head><noscript>n</noscript><script src="a.js"></script><title>t</title>' +
      '<link rel="stylesheet" href="s.css"></link><link rel="icon"></link><style>p{}</style></head>' +
      '<body class="s"><!--x--><p>server</p><div>d</div><script>1</script></body></html><!--after-->';
    const run = async (L: Lib, throws: number, sync: boolean) => {
      const d = page(server);
      const before = [d.documentElement, d.head, d.body];
      const log: string[] = [];
      const h = L.createElement;
      let n = 0;
      function Fails(): Any {
        if (n++ < throws) throw new Error("boom");
        return "server";
      }
      (globalThis as Any).window.HTMLIFrameElement = class {};
      const go = () =>
        (L === React ? ReactClient : L).hydrateRoot(
          d,
          h(
            "html",
            { lang: "fr" },
            h("head", null, h("style", null, "p{}")),
            h(
              "body",
              { className: "c", onClick: () => void log.push("click") },
              h("p", null, throws ? h(Fails) : "client"),
              h("div", null, "d"),
            ),
          ),
          {
            onRecoverableError: (e: Any) =>
              void log.push("recoverable " + short(e) + (e.cause ? " cause " + short(e.cause) : "")),
            onUncaughtError: (e: Any) => void log.push("uncaught " + short(e)),
          },
        );
      if (sync) (L === React ? ReactDOM : L).flushSync(go);
      else go();
      await settle();
      (d.body.lastChild as FakeElement).dispatchEvent(new FakeEvent("click"));

      return { log, markup: markup(d), kept: [d.documentElement, d.head, d.body].map((n, i) => n === before[i]) };
    };
    // A mismatch, an error that is not one (#423), and one the client render throws again: the
    // root unmounts, and the singletons stay, emptied.
    const logs = ["recoverable 418 text", "recoverable 423 cause boom"];
    for (const throws of [0, 1, Infinity])
      for (const sync of [true, false]) {
        const react = await run(React, throws, sync);
        expect(react.kept).toEqual([true, true, true]);
        expect(react.log).toEqual(throws === Infinity ? ["uncaught boom"] : [logs[throws]!, "click"]);
        expect(await run(Compat, throws, sync)).toEqual(react);
      }
  });
});

// #endregion

// #region Errors

describe("errors", () => {
  // React's production client throws minified errors: a code and its arguments in a react.dev
  // link. Each test makes both libraries throw in one situation and expects the same message.

  /** What `fn` throws, as its message. */
  const thrown = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as Error).message;
    }
    return "(nothing thrown)";
  };

  /** Expects both libraries to throw one message from `fn(L)`, React's error `code`; returns it. */
  function throwsSame(fn: (L: Lib, dom: Any) => unknown, code: number): string {
    const message = thrown(() => fn(React, ReactDOM));
    expect(message).toStartWith(`Minified React error #${code}; visit https://react.dev/errors/${code}`);
    expect(thrown(() => fn(Compat, Compat))).toBe(message);
    return message;
  }

  /**
   * Renders `make(L)` into a root with each library and expects each to report one error to
   * onUncaughtError with the same message, React's error `code`; returns it.
   */
  async function reportsSame(make: (L: Lib) => Any, code: number): Promise<string> {
    const run = async (L: Lib, createRoot: (c: Any, o: Any) => Any, flush: (fn: () => void) => void) => {
      const out: string[] = [];
      const root = createRoot(box(), { onUncaughtError: (e: Any) => void out.push(e.message) });
      flush(() => root.render(make(L)));
      await tasks();
      return out;
    };
    const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
    const compat = await run(Compat, (c, o) => Compat.createRoot(c as unknown as Element, o), Compat.flushSync);
    expect(react).toHaveLength(1);
    expect(react[0]).toStartWith(`Minified React error #${code}; visit https://react.dev/errors/${code}`);
    expect(compat).toEqual(react);
    return react[0]!;
  }

  /** Renders once with React, so its hooks outside a render throw as after any render. */
  const renderedOnce = (): void => ReactDOM.flushSync(() => ReactClient.createRoot(box()).render(null));

  test("the message is React's, the arguments encoded into the link (#31)", async () => {
    expect(await reportsSame((L) => L.createElement("div", null, { x: 1, "a b": 2 }), 31)).toBe(
      "Minified React error #31; visit https://react.dev/errors/31?args[]=object%20with%20keys%20%7Bx%2C%20a%20b%7D for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
    );
    await reportsSame((L) => L.createElement("div", null, new Date(0)), 31);
  });

  test("an element from an older React (#525)", () =>
    reportsSame(
      (L) => L.createElement("div", null, { $$typeof: Symbol.for("react.element"), type: "b", props: {} }),
      525,
    ));

  test("an element type that is not one (#130)", async () => {
    await reportsSame((L) => L.createElement("div", null, L.createElement(undefined)), 130);
    await reportsSame((L) => L.createElement("div", null, L.createElement(null)), 130);
    await reportsSame((L) => L.createElement("div", null, L.createElement({})), 130);
    await reportsSame((L) => L.createElement("div", null, L.createElement(5)), 130);
  });

  /** A lazy type whose thenable resolves to `type` as it is read, so it renders at once. */
  const lazyOf = (L: Lib, type: Any) => L.lazy(() => ({ then: (ok: Any) => ok({ default: type }) }));

  test("a lazy type that loads what is not a component (#306)", async () => {
    await reportsSame((L) => L.createElement(lazyOf(L, "div")), 306);
    await reportsSame((L) => L.createElement(lazyOf(L, undefined)), 306);
    await reportsSame((L) => L.createElement(lazyOf(L, L.Suspense)), 306);
    await reportsSame((L) => L.createElement(lazyOf(L, {})), 306);
    // What it may load: a function, forwardRef, memo or context.
    const ok = async (make: (L: Lib) => Any) => {
      const c = box();
      const root = Compat.createRoot(c as unknown as Element);
      Compat.flushSync(() => root.render(make(Compat)));
      expect(markup(c)).toBe("<p>x</p>");
    };
    const P = (L: Lib) => () => L.createElement("p", null, "x");
    await ok((L) => L.createElement(lazyOf(L, P(L))));
    await ok((L) => L.createElement(lazyOf(L, L.forwardRef(P(L)))));
    await ok((L) => L.createElement(lazyOf(L, L.memo(P(L)))));
    await ok((L) => L.createElement(lazyOf(L, L.createContext(0)), { value: 1 }, L.createElement(P(L))));
  });

  // React names what a lazy type loaded with getComponentNameFromType, so a lazy type that loads
  // another names every type the inner one can load.
  test("a lazy type that loads a lazy type is named by what that one loads, as React names it (#306)", async () => {
    const types = (L: Lib): Any[] => {
      const Ctx = L.createContext(0);
      const Theme = L.createContext(0);
      Theme.displayName = "Theme";
      return [
        L.Fragment,
        L.Profiler,
        L.StrictMode,
        L.Suspense,
        Symbol.for("react.suspense_list"),
        L.Activity,
        L.ViewTransition,
        "b",
        (L === React ? ReactDOM : L).createPortal("x", new FakeElement("DIV")),
        Ctx,
        Theme,
        Ctx.Consumer,
        Theme.Consumer,
        L.forwardRef(function Named() {
          return null;
        }),
        L.forwardRef(() => null),
        Object.assign(
          L.forwardRef(() => null),
          { displayName: "Shown" },
        ),
        L.memo(function Inner() {
          return null;
        }),
        L.memo(() => null),
        Object.assign(
          L.memo(() => null),
          { displayName: "Outer" },
        ),
        function Plain() {},
        Object.assign(() => {}, { displayName: "Shown" }),
        () => {},
        Object.assign(function Client() {}, { $$typeof: Symbol.for("react.client.reference") }),
        L.lazy(() => new Promise(() => {})),
        { $$typeof: Symbol("other") },
      ];
    };
    const names: string[] = [];
    for (let i = 0; i < types(React).length; i++) {
      const message = await reportsSame((L) => L.createElement(lazyOf(L, lazyOf(L, types(L)[i]))), 306);
      names.push(decodeURIComponent(/\?args\[\]=(.*?)&/.exec(message)![1]!));
    }
    expect(names).toEqual([
      "Fragment",
      "Profiler",
      "StrictMode",
      "Suspense",
      "SuspenseList",
      "Activity",
      "ViewTransition",
      "b",
      "Portal",
      "Context",
      "Theme",
      "Context.Consumer",
      "Theme.Consumer",
      "ForwardRef(Named)",
      "ForwardRef",
      "Shown",
      "Inner",
      "Memo",
      "Outer",
      "Plain",
      "Shown",
      "[object Object]",
      "[object Object]",
      "[object Object]",
      "[object Object]",
    ]);
  });

  test("a style prop that is not an object (#62)", () =>
    reportsSame((L) => L.createElement("div", { style: "color: red" }), 62));

  test("a component that sets state on every render (#301)", () =>
    reportsSame((L) => {
      function Loop() {
        const [n, set] = L.useState(0);
        set(n + 1);
        return null;
      }
      return L.createElement(Loop);
    }, 301));

  /**
   * Renders each element `make(L, log)` returns into one root with each library, one flushSync
   * apiece, and expects the same: the log the tree writes, the errors reported (code, then
   * component stack) in order with it, and the markup. Returns compat's log.
   */
  async function logsSame(make: (L: Lib, log: string[]) => Any[]): Promise<string[]> {
    const run = async (L: Lib, createRoot: (c: Any, o: Any) => Any, flush: (fn: () => void) => void) => {
      const log: string[] = [],
        c = box();
      const report = (kind: string) => (e: Any, info: Any) =>
        void log.push(`${kind} ${e.message.replace(/^Minified React error #(\d+);.*$/s, "#$1")}${info.componentStack}`);
      const root = createRoot(c, {
        onUncaughtError: report("uncaught"),
        onCaughtError: report("caught"),
        onRecoverableError: report("recoverable"),
      });
      for (const el of make(L, log)) {
        flush(() => root.render(el));
        await tasks();
      }
      log.push("dom " + markup(c));
      return log;
    };
    const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
    const compat = await run(Compat, (c, o) => Compat.createRoot(c as unknown as Element, o), Compat.flushSync);
    expect(compat).toEqual(react);
    return compat;
  }

  test("a layout effect, ref or componentDidUpdate that updates on every commit (#185)", async () => {
    // React counts the commits in a row that leave an update to render, and its 52nd throws #185
    // from the setState that would queue the next, to the nearest error boundary or the root.
    const layout = await logsSame((L, log) => {
      function Loop() {
        const [n, set] = L.useState(0);
        L.useLayoutEffect(() => {
          log.push("layout " + n);
          set(n + 1);
        });
        return L.createElement("p", null, n);
      }
      return [L.createElement("div", null, L.createElement(Loop))];
    });
    expect(layout.length).toBe(55);
    expect(layout.at(-2)).toStartWith("uncaught #185\n    at Loop (");
    // A ref callback: a new one each render, so each commit detaches the old and attaches the new.
    await logsSame((L, log) => {
      function Loop() {
        const [n, set] = L.useState(0);
        return L.createElement("p", {
          ref: (el: Any) => {
            log.push("ref " + n + " " + (el === null ? "null" : "p"));
            set(n + 1);
          },
        });
      }
      return [L.createElement(Loop)];
    });
    // componentDidUpdate, under an error boundary that catches the error.
    await logsSame((L, log) => {
      class Loop extends L.Component<Any> {
        state = { n: 0 };
        componentDidMount() {
          this.setState({ n: 1 });
        }
        componentDidUpdate() {
          log.push("update " + this.state.n);
          this.setState({ n: this.state.n + 1 });
        }
        render() {
          return this.state.n;
        }
      }
      class Boundary extends L.Component<Any> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          return this.state.failed ? "failed" : this.props.children;
        }
      }
      return [L.createElement(Boundary, null, L.createElement(Loop))];
    });
    // A passive effect and a layout effect taking turns count too: each commit leaves an update.
    await logsSame((L, log) => {
      function Turns() {
        const [n, set] = L.useState(0);
        const [m, setM] = L.useState(0);
        L.useEffect(() => {
          log.push("passive " + n);
          set(n + 1);
        });
        L.useLayoutEffect(() => {
          log.push("layout " + m);
          setM(m + 1);
        }, [n]);
        return n + "," + m;
      }
      return [L.createElement(Turns)];
    });
  });

  test("a passive effect that updates on every commit runs on, unlimited (no #185 in production)", async () => {
    // React's production build has no limit on passive updates (NESTED_PASSIVE_UPDATE_LIMIT is a
    // development warning): each renders in a task of its own, so the page keeps running.
    const log = await logsSame((L, log) => {
      function Count() {
        const [n, set] = L.useState(0);
        L.useEffect(() => {
          if (n < 200) set(n + 1);
          else log.push("reached " + n);
        });
        return n;
      }
      return [L.createElement(Count)];
    });
    expect(log).toEqual(["reached 200", "dom 200"]);
  });

  test("#185 counts the commits of each root: two roots updating each other take turns, unlimited", async () => {
    // React's nestedUpdateCount starts over when the root that commits is another: two roots
    // whose layout effects update each other never reach the limit, however many turns they take.
    // A root that updates itself still throws.
    const run = async (L: Lib, createRoot: (c: Any, o?: Any) => Any, flush: (fn: () => void) => void) => {
      const log: string[] = [],
        setters: Record<string, (n: number) => void> = {};
      function Ping(props: { name: string; peer: string; limit: number }) {
        const [n, set] = L.useState(0);
        setters[props.name] = set;
        L.useLayoutEffect(() => {
          if (n > 0 && n < props.limit) setters[props.peer]!(n + 1);
        });
        log.push(props.name + " " + n);
        return n;
      }
      const roots = { a: createRoot(box()), b: createRoot(box()) };
      for (const [name, peer] of [
        ["a", "b"],
        ["b", "a"],
      ] as const)
        flush(() => roots[name].render(L.createElement(Ping, { name, peer, limit: 70 })));
      flush(() => setters["a"]!(1));
      await tasks();
      const self = createRoot(box(), {
        onUncaughtError: (e: Any) => void log.push("uncaught " + e.message.slice(0, 25)),
      });
      flush(() => self.render(L.createElement(Ping, { name: "s", peer: "s", limit: 1000 })));
      flush(() => setters["s"]!(1));
      await tasks();
      return log;
    };
    const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
    const compat = await run(Compat, (c, o) => Compat.createRoot(c as unknown as Element, o), Compat.flushSync);
    expect(compat).toEqual(react);
    expect(react).toContain("b 70");
    expect(react.at(-1)).toBe("uncaught Minified React error #185");
  });

  test("hooks that differ from the last render's (#300, #310, #311, #467)", async () => {
    // The renders that fail log nothing: React calls a component whose render failed again
    // (it replays the failed work and retries the render) more times than compat does before
    // the error is reported. Fewer hooks than the last render (#300), more (#310).
    const counts = (L: Lib) =>
      function Counts(props: { more: boolean }) {
        L.useState(0);
        if (props.more) L.useState(1);
        return null;
      };
    const fewer = await logsSame((L) => {
      const C = counts(L);
      return [L.createElement(C, { more: true }), L.createElement(C, { more: false })];
    });
    expect(fewer.at(-2)).toStartWith("uncaught #300\n    at Counts (");
    const more = await logsSame((L) => {
      const C = counts(L);
      return [L.createElement(C, { more: false }), L.createElement(C, { more: true })];
    });
    expect(more.at(-2)).toStartWith("uncaught #310\n");
    // A state hook where the last render had a hook of another kind (#311): an effect, a ref, a
    // memo, an id; the other way round, a ref reads the state, as in React.
    for (const other of ["effect", "ref", "memo", "id"])
      await logsSame((L, log) => {
        function Swaps(props: { state: boolean }) {
          if (props.state) log.push("state " + L.useReducer((s: number) => s, 1)[0]);
          else if (other === "effect") L.useEffect(() => {});
          else if (other === "ref") L.useRef(0);
          else if (other === "memo") L.useMemo(() => 2, []);
          else L.useId();
          return null;
        }
        return [L.createElement(Swaps, { state: false }), L.createElement(Swaps, { state: true })];
      });
    await logsSame((L, log) => {
      function Reads(props: { asRef: boolean }) {
        log.push("read " + (props.asRef ? L.useRef(5) : L.useState(7)[0]));
        return null;
      }
      return [L.createElement(Reads, { asRef: false }), L.createElement(Reads, { asRef: true })];
    });
    // A render that sets state renders again at once: on a mount, a hook that pass adds is #467;
    // on an update, #310. Fewer hooks in a later pass of a mount are kept for the next render,
    // which then has too few (#300).
    const passes = (L: Lib) =>
      function Passes(props: { go: boolean; drop?: boolean }) {
        const [n, set] = L.useState(0);
        if (props.drop && n === 0) L.useRef(0);
        if (props.go && n === 0) set(1);
        if (!props.drop && n === 1) L.useState(2);
        return null;
      };
    expect((await logsSame((L) => [L.createElement(passes(L), { go: true })]))[0]).toStartWith("uncaught #467\n");
    const update = await logsSame((L) => {
      const P = passes(L);
      return [L.createElement(P, { go: false }), L.createElement(P, { go: true })];
    });
    expect(update[0]).toStartWith("uncaught #310\n");
    const kept = await logsSame((L) => {
      const P = passes(L);
      return [L.createElement(P, { go: true, drop: true }), L.createElement(P, { go: true, drop: true })];
    });
    expect(kept[0]).toStartWith("uncaught #300\n");
  });

  test("a component that stops calling hooks mounts them anew when it calls them again, as React does", async () => {
    // React's renderWithHooks compares nothing when a render calls no hook: the next render with
    // hooks mounts them, its state starting over, and the old effects never clean up.
    const log = await logsSame((L, log) => {
      function Toggle(props: { on: boolean; n: number }) {
        if (props.on) {
          const [v] = L.useState(() => (log.push("init " + props.n), props.n));
          L.useEffect(() => {
            log.push("effect " + v);
            return () => void log.push("cleanup " + v);
          }, []);
          log.push("render " + v);
        }
        return null;
      }
      return [
        L.createElement(Toggle, { on: true, n: 1 }),
        L.createElement(Toggle, { on: false, n: 2 }),
        L.createElement(Toggle, { on: true, n: 3 }),
        null,
      ];
    });
    expect(log).toEqual(["init 1", "render 1", "effect 1", "init 3", "render 3", "effect 3", "cleanup 3", "dom "]);
  });

  test("use() of a value it cannot read (#438)", async () => {
    const Use = (L: Lib, v: Any) =>
      function Use() {
        L.use(v);
        return null;
      };
    expect(await reportsSame((L) => L.createElement(Use(L, 5)), 438)).toContain("?args[]=5 ");
    await reportsSame((L) => L.createElement(Use(L, {})), 438);
  });

  test("a useEffectEvent function called while rendering (#440)", () =>
    reportsSame((L) => {
      function Early() {
        const fn = L.useEffectEvent(() => 1);
        fn();
        return null;
      }
      return L.createElement(Early);
    }, 440));

  test("hooks called outside a render (#321, #308)", () => {
    renderedOnce();
    throwsSame((L) => L.useState(0), 321);
    throwsSame((L) => L.useContext(L.createContext(0)), 321);
    // use() of a context reads it, and reading one outside a render is #308.
    throwsSame((L) => L.use(L.createContext(0)), 308);
  });

  test("render() of an unmounted root (#409)", () => {
    throwsSame((L, D) => {
      // Unmounting takes the root's listeners off its container.
      const c = Object.assign(box(), { removeEventListener: () => {} });
      const root = L === React ? ReactClient.createRoot(c) : Compat.createRoot(c as unknown as Element);
      D.flushSync(() => root.render(null));
      root.unmount();
      root.render(null);
    }, 409);
  });

  test("requestFormReset of a form React did not render (#522)", () => {
    throwsSame((_L, D) => D.requestFormReset(new FakeElement("FORM")), 522);
  });

  test("a Fragment ref's scrollIntoView with options (#566)", () => {
    throwsSame((L, D) => {
      const ref = L.createRef();
      const root = L === React ? ReactClient.createRoot(box()) : Compat.createRoot(box() as unknown as Element);
      D.flushSync(() => root.render(L.createElement(L.Fragment, { ref }, L.createElement("p"))));
      ref.current.scrollIntoView({});
    }, 566);
  });

  test("hydration mismatches, text and HTML (#418)", async () => {
    // The hydration tests above compare every message whole, #419 included; here, the exact text.
    const messages: string[] = [];
    const c = box();
    c.innerHTML = ReactServer.renderToString(React.createElement("p", null, "a"));
    Compat.hydrateRoot(c as unknown as Element, Compat.createElement("p", null, "b"), {
      onRecoverableError: (e: Any) => void messages.push(e.message),
    });
    const d = box();
    d.innerHTML = ReactServer.renderToString(React.createElement("div", null, React.createElement("p")));
    Compat.hydrateRoot(d as unknown as Element, Compat.createElement("div", null, Compat.createElement("b")), {
      onRecoverableError: (e: Any) => void messages.push(e.message),
    });
    await tasks();
    const tail =
      " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
    expect(messages).toEqual([
      "Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]=" + tail,
      "Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]=" + tail,
    ]);
  });

  test("React's Children throw their error in full, even in production, and pass over functions", () => {
    // React's isomorphic package keeps its messages: they are not minified.
    const message = throwsFull((L) => L.Children.toArray({ x: 1 }));
    expect(message).toBe(
      "Objects are not valid as a React child (found: object with keys {x}). If you meant to render a collection of children, use an array instead.",
    );
    // An object's String() form, as React names it (a date's, not its tag).
    throwsFull((L) => L.Children.toArray([new Date(0)]));
    throwsFull((L) => L.Children.only([]));
    for (const L of [React, Compat]) {
      expect(L.Children.toArray([() => 1, Symbol.for("x"), "a"])).toHaveLength(1);
      expect(L.Children.count(() => 1)).toBe(0);
    }
  });

  /** The root API of `L`: react-dom/client's for React. */
  const client = (L: Lib): Any => (L === React ? ReactClient : L);

  /**
   * Renders each tree `steps(L)` gives into one root in turn, with each library, and expects the
   * same errors reported (onUncaughtError) and, unless `errorsOnly`, the same markup after each
   * render. Returns the errors.
   */
  async function rendersSame(steps: (L: Lib) => Any[], errorsOnly = false): Promise<string[]> {
    const run = async (L: Lib) => {
      const out: string[] = [];
      const c = box();
      const root = client(L).createRoot(c, { onUncaughtError: (e: Any) => void out.push(e.message) });
      for (const tree of steps(L)) {
        (L === React ? ReactDOM : L).flushSync(() => root.render(tree));
        await tasks();
        if (!errorsOnly) out.push(markup(c));
      }
      return out;
    };
    const react = await run(React);
    expect(await run(Compat)).toEqual(react);
    return react.filter((m) => m.startsWith("Minified"));
  }

  test("a root or portal container that is not an element, a document or a fragment (#299)", () => {
    for (const c of [null, undefined, {}, new FakeText("x"), new FakeNode(8)]) {
      throwsSame((L) => client(L).createRoot(c), 299);
      throwsSame((L) => client(L).hydrateRoot(c, null), 299);
      throwsSame((_L, D) => D.createPortal(null, c), 299);
    }
    // What a container may be: an element, a document (9) and a fragment (11).
    for (const c of [box(), new FakeNode(9), new FakeNode(11)])
      expect(Compat.createPortal(null, c as Any).containerInfo).toBe(c);
  });

  test("dangerouslySetInnerHTML not in the form {__html} (#61), or with children (#60)", async () => {
    const div = (L: Lib, html: Any, ...children: Any[]) =>
      L.createElement("div", { dangerouslySetInnerHTML: html }, ...children);
    await reportsSame((L) => div(L, "<b>x</b>"), 61);
    await reportsSame((L) => div(L, {}), 61);
    await reportsSame((L) => div(L, 5), 61);
    await reportsSame((L) => div(L, { __html: "x" }, "y"), 60);
    await reportsSame((L) => div(L, { __html: "x" }, L.createElement("b")), 60);
    await reportsSame((L) => L.createElement("my-el", { dangerouslySetInnerHTML: "x" }), 61);
    // Checked when the prop changes: kept as it was, children may come and go, and text children
    // that change are written over the HTML. The HTML is written again when its text changes.
    const kept = { __html: "<i>x</i>" };
    expect(
      await rendersSame((L) => [
        div(L, kept),
        div(L, kept, "y"),
        div(L, kept, 5),
        div(L, kept),
        div(L, { __html: "<i>x</i>" }),
        div(L, { __html: "<i>w</i>" }),
        div(L, kept, L.createElement("b")),
        div(L, kept, L.createElement("b"), "c"),
        div(L, { __html: "z" }, "y"),
      ]),
    ).toHaveLength(3);
    // Element children with the HTML kept: React leaves them to its reconciler, under the HTML.
    expect(await rendersSame((L) => [div(L, kept), div(L, kept, L.createElement("b"))])).toEqual([]);
    expect(await rendersSame((L) => [div(L, { __html: "x" }), div(L, "y")])).toHaveLength(1);
    // No HTML (__html null or undefined): the children render.
    expect(
      await rendersSame((L) => [
        div(L, { __html: null }, "a"),
        div(L, { __html: undefined }, L.createElement("b", null, "c")),
        div(L, { __html: "<i>h</i>" }),
        div(L, { __html: null }, L.createElement("b", null, "c")),
        div(L, { __html: null }, L.createElement("b", null, "d"), "e"),
        div(L, { __html: "<i>h</i>" }),
        div(L, { __html: null }),
      ]),
    ).toEqual([]);
  });

  test("a textarea's dangerouslySetInnerHTML (#91), children with defaultValue (#92), several children (#93)", async () => {
    const area = (L: Lib, props: Any, ...children: Any[]) => L.createElement("textarea", props, ...children);
    await reportsSame((L) => area(L, { dangerouslySetInnerHTML: { __html: "x" } }), 91);
    await reportsSame((L) => area(L, { defaultValue: "a" }, "b"), 92);
    await reportsSame((L) => area(L, null, "a", "b"), 93);
    await reportsSame((L) => area(L, { defaultValue: "a" }, "b", "c"), 92);
    expect(
      await rendersSame((L) => [area(L, null), area(L, { dangerouslySetInnerHTML: { __html: "x" } })]),
    ).toHaveLength(1);
    // A value wins over children; one child in an array is the text; none is empty.
    const defaults = (make: (L: Lib) => Any) =>
      [React, Compat].map((L) => {
        const c = box();
        const root = client(L).createRoot(c);
        (L === React ? ReactDOM : L).flushSync(() => root.render(make(L)));
        return (c.firstChild as Any).defaultValue;
      });
    expect(defaults((L) => area(L, { value: "v", onChange() {} }, "a", "b"))).toEqual(["v", "v"]);
    expect(defaults((L) => area(L, null, ["a"]))).toEqual(["a", "a"]);
    expect(defaults((L) => area(L, null, []))).toEqual(["", ""]);
  });

  test("children or dangerouslySetInnerHTML on a void element (#137)", async () => {
    const el = (L: Lib, tag: string, props: Any, ...children: Any[]) => L.createElement(tag, props, ...children);
    expect(await reportsSame((L) => el(L, "img", null, "x"), 137)).toContain("?args[]=img ");
    await reportsSame((L) => el(L, "br", null, el(L, "b", null)), 137);
    await reportsSame((L) => el(L, "hr", null, false), 137);
    await reportsSame((L) => el(L, "input", { dangerouslySetInnerHTML: { __html: "x" } }), 137);
    await reportsSame((L) => el(L, "meta", { name: "a", content: "b" }, "x"), 137);
    await reportsSame((L) => el(L, "div", null, el(L, "wbr", null, [])), 137);
    // As one gets them on an update: text, elements, raw HTML.
    for (const next of [
      (L: Lib) => el(L, "br", null, "x"),
      (L: Lib) => el(L, "br", null, el(L, "b", null)),
      (L: Lib) => el(L, "br", { dangerouslySetInnerHTML: { __html: "x" } }),
      // Children that render no node.
      (L: Lib) => el(L, "br", null, false),
      (L: Lib) => el(L, "br", null, true),
      (L: Lib) => el(L, "br", null, []),
      (L: Lib) => el(L, "br", null, [null, false]),
      (L: Lib) =>
        el(
          L,
          "br",
          null,
          L.createElement(() => null),
        ),
    ])
      expect(await rendersSame((L) => [el(L, "br", null), next(L)])).toHaveLength(1);
    // null children are none.
    expect(await rendersSame((L) => [el(L, "img", { alt: "a" }, null), el(L, "img", { alt: "b" }, undefined)])).toEqual(
      [],
    );
  });

  test("a ref that is neither a function nor an object (#284)", async () => {
    class C extends Compat.Component {
      override render() {
        return null;
      }
    }
    class R extends React.Component {
      render() {
        return null;
      }
    }
    for (const ref of ["r", 5, true, Symbol.for("r")]) {
      await reportsSame((L) => L.createElement("div", { ref }), 284);
      await reportsSame((L) => L.createElement(L === React ? R : C, { ref }), 284);
      await reportsSame((L) => L.createElement(L.Fragment, { ref }, "x"), 284);
    }
    expect(
      await rendersSame((L) => [L.createElement("div", { ref: null }), L.createElement("div", { ref: "r" })]),
    ).toHaveLength(1);
  });

  test("an event handler prop that is set but not a function (#231)", () => {
    /** Renders `make(L)` with each library; expects one error from dispatching `type` on its innermost node. */
    const firesSame = (make: (L: Lib) => Any, type: string, init: Any = {}): string =>
      throwsSame((L) => {
        const c = box();
        const root = client(L).createRoot(c);
        (L === React ? ReactDOM : L).flushSync(() => root.render(make(L)));
        let at = c.firstChild!;
        while (at.firstChild !== null) at = at.firstChild;
        (at as FakeElement).dispatchEvent(Object.assign(new FakeEvent(type), init));
      }, 231);
    expect(firesSame((L) => L.createElement("button", { onClick: "go" }), "click")).toContain(
      "?args[]=onClick&args[]=string ",
    );
    firesSame((L) => L.createElement("button", { onClickCapture: {} }), "click");
    firesSame((L) => L.createElement("button", { onClick: true }), "click");
    firesSame((L) => L.createElement("div", { onScroll: 1 }), "scroll");
    firesSame((L) => L.createElement("div", { onMouseEnter: "in" }), "mouseover", { relatedTarget: null });
    firesSame((L) => L.createElement("p", null, L.createElement("b", { onMouseEnter: 1 })), "mouseover", {
      relatedTarget: null,
    });
    // A compiled block's handler.
    firesSame(
      (L) =>
        L === React
          ? L.createElement("button", { onClick: "go" })
          : Compat.__block(Compat.__template(["button", { onClick: { h: 0 } }]), null, ["go"]),
      "click",
    );
  });

  test("optimistic state set, or an action dispatched, while rendering (#479, #485)", async () => {
    // React's microtask scheduling reads window.event after the failed render.
    (globalThis as Any).window = {};
    try {
      await whileRendering();
    } finally {
      delete (globalThis as Any).window;
    }
  });
  const whileRendering = async (): Promise<void> => {
    await reportsSame((L) => {
      function Optimistic() {
        const [, set] = L.useOptimistic(0);
        set(1);
        return null;
      }
      return L.createElement(Optimistic);
    }, 479);
    await reportsSame((L) => {
      function Action() {
        const [, dispatch] = L.useActionState((s: number) => s + 1, 0);
        dispatch();
        return null;
      }
      return L.createElement(Action);
    }, 485);
  };

  test("cloneElement of null or undefined, and setState of what is not state, throw React's full messages", () => {
    for (const v of [null, undefined])
      expect(throwsFull((L) => L.cloneElement(v))).toBe(`The argument must be a React element, but you passed ${v}.`);
    for (const v of [5, "s", true, Symbol.for("s")])
      expect(throwsFull((L) => new L.Component({}).setState(v))).toBe(
        "takes an object of state variables to update or a function which returns an object of state variables.",
      );
  });

  test("React's Children read thenables and lazy types, throwing what they throw", () => {
    /** What `fn` returns, as keys and types, or what it throws. */
    const result = (fn: () => Any): Any => {
      try {
        return fn().map((c: Any) => (c !== null && typeof c === "object" ? [c.key, c.type] : c));
      } catch (e) {
        return { thrown: e };
      }
    };
    const both = (make: (L: Lib) => Any) => {
      const react = result(() => React.Children.toArray(make(React)));
      expect(result(() => Compat.Children.toArray(make(Compat)))).toEqual(react);
      return react;
    };
    const fulfilled = { then() {}, status: "fulfilled", value: "a" };
    expect(both(() => [fulfilled, "b"])).toEqual(["a", "b"]);
    expect(both((L) => ({ then() {}, status: "fulfilled", value: L.createElement("b", { key: "k" }) }))).toEqual([
      [".$k", "b"],
    ]);
    const reason = new Error("no");
    expect(both(() => ({ then() {}, status: "rejected", reason }))).toEqual({ thrown: reason });
    // Read as React's use() reads one: settled at once, or thrown.
    expect(both(() => ({ then: (ok: Any) => ok("now") }))).toEqual(["now"]);
    expect(both(() => ({ then: (_: Any, no: Any) => no(reason) }))).toEqual({ thrown: reason });
    const pending: Any = { then() {} };
    expect(both(() => [pending])).toEqual({ thrown: pending });
    expect(pending.status).toBe("pending");
    const promise = Promise.resolve("p");
    expect(both(() => promise)).toEqual({ thrown: promise });
    // A lazy type is read through its loader: a loaded one gives what it loaded.
    expect(both((L) => [L.lazy(() => ({ then: (ok: Any) => ok({ default: L.createElement("i") }) })), "z"])).toEqual([
      [".0", "i"],
      "z",
    ]);
    expect(both((L) => L.lazy(() => ({ then: (_: Any, no: Any) => no(reason) })))).toEqual({ thrown: reason });
    for (const L of [React, Compat]) expect(L.Children.count([fulfilled, () => 1])).toBe(1);
  });

  /** Expects both libraries to throw one message from `fn(L)`, not a minified one; returns it. */
  function throwsFull(fn: (L: Lib) => unknown): string {
    const message = thrown(() => fn(React));
    expect(message).not.toStartWith("Minified");
    expect(message).not.toBe("(nothing thrown)");
    expect(thrown(() => fn(Compat))).toBe(message);
    return message;
  }
});

// #endregion

// #region The render loop

describe("the render loop", () => {
  // React reads window.event as it schedules an update made outside flushSync.
  beforeEach(() => void ((globalThis as Any).window = globalThis));
  afterEach(() => void delete (globalThis as Any).window);

  /** What a step does with a library: render into its root, set state, flush. */
  type Step = (root: Any, flush: (fn: () => void) => void, L: Lib) => void;

  /**
   * Runs the steps `make(L, log)` returns with each library, on one root apiece, and expects the
   * same: the log the tree writes, the errors reported in order with it (React's code or the
   * message, a cause's, then the component stack, locations and all) and the markup after each
   * step. Returns compat's log.
   */
  async function stepsSame(make: (L: Lib, log: string[]) => Step[]): Promise<string[]> {
    const message = (e: Any): string =>
      String(e?.message ?? e).replace(/^Minified React error #(\d+);.*$/s, "#$1") +
      (e?.cause ? " cause " + message(e.cause) : "");
    const run = async (L: Lib, createRoot: (c: Any, o: Any) => Any, flush: (fn: () => void) => void) => {
      const log: string[] = [],
        c = box();
      const report = (kind: string) => (e: Any, info: Any) =>
        void log.push(`${kind} ${message(e)}${info.componentStack}`);
      const root = createRoot(c, {
        onUncaughtError: report("uncaught"),
        onCaughtError: report("caught"),
        onRecoverableError: report("recoverable"),
      });
      for (const step of make(L, log)) {
        step(root, flush, L);
        await tasks();
        log.push("dom " + markup(c));
      }
      return log;
    };
    const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
    const compat = await run(Compat, (c, o) => Compat.createRoot(c as unknown as Element, o), Compat.flushSync);
    expect(compat).toEqual(react);
    return compat;
  }

  test("useSyncExternalStore checks the store after a commit whose snapshot or getSnapshot changed", async () => {
    // React's updateStoreInstance: after a commit that rendered a new snapshot, or with a new
    // getSnapshot (or subscribe), a passive effect calls getSnapshot once more and renders again
    // if the store moved on meanwhile. It runs after the subscription's own effect.
    const log = await stepsSame((L, log) => {
      let value = 0,
        setP: Any = null;
      const listeners = new Set<() => void>();
      const get = () => (log.push("get " + value), value);
      const subscribe = (cb: () => void) => {
        log.push("subscribe");
        listeners.add(cb);
        return () => void (log.push("unsubscribe"), listeners.delete(cb));
      };
      const other = (cb: () => void) => subscribe(cb);
      function Read() {
        const [p, set] = L.useState(0);
        setP = set;
        // An odd p brings a getSnapshot of its own, 10 another subscribe.
        const v = L.useSyncExternalStore(p === 10 ? other : subscribe, p % 2 ? () => get() : get);
        L.useEffect(() => void log.push("passive"));
        // The store moves on after this render without notifying: after 6, no check sees it
        // (nothing changed); after 7, a new getSnapshot's check does, and renders again.
        L.useLayoutEffect(() => {
          if (p === 6 || p === 7) value = p - 4;
        });
        log.push("render " + v + " " + p);
        return v;
      }
      const notify = () => {
        for (const l of listeners) l();
      };
      return [
        (root, flush) => flush(() => root.render(L.createElement(Read))),
        (_, flush) => flush(() => setP(2)),
        (_, flush) => flush(() => setP(3)),
        (_, flush) => flush(() => setP(5)),
        (_, flush) => flush(() => setP(4)),
        (_, flush) =>
          flush(() => {
            value = 1;
            notify();
          }),
        (_, flush) => flush(() => setP(6)),
        (_, flush) => flush(() => setP(7)),
        (_, flush) => flush(() => setP(10)),
        (_, flush) => flush(() => setP(12)),
        // A transition that changes neither: React checks a store whose snapshot or getSnapshot
        // changed once more as a transition finishes rendering, before it commits, where compat,
        // rendering it at once, has no such check.
        (_, __, L) => L.startTransition(() => setP(14)),
      ];
    });
    expect(log.filter((l) => l.startsWith("get")).length).toBeGreaterThan(10);
  });

  // A render that throws an error is not reported at once: React renders the root again, in one
  // synchronous pass, and only an error that pass throws too is caught or reported (else the
  // first is recoverable, #520). Each throw captures the error's component stack twice (once for
  // #520's wrapper), and React's production build gets a component's frame by calling it without
  // props: those calls are logged as "probe".

  /** A function component named `name` that logs each call and renders `body(props)`. */
  const named = (log: string[], name: string, body: (props: Any) => Any) => {
    const C = (props: Any) => {
      log.push((props ? "render " : "probe ") + name);
      return body(props);
    };
    Object.defineProperty(C, "name", { value: name });
    return C;
  };
  /** A component that throws `message` (an Error, unless `raw`) whenever it renders with `fail`. */
  const thrower = (log: string[], name = "Boom", raw?: Any) =>
    named(log, name, (props) => {
      if (props?.fail ?? true) throw raw ?? new Error(name.toLowerCase());
      return "ok";
    });
  /**
   * A component with a layout effect that runs once (compat runs a layout cleanup as its component
   * renders, React as it commits) and a passive effect that runs after every commit, rendering its
   * children.
   */
  const withEffects = (L: Lib, log: string[], name: string) =>
    named(log, name, (props) => {
      L.useLayoutEffect(() => {
        log.push("layout " + name);
        return () => void log.push("layout cleanup " + name);
      }, []);
      L.useEffect(() => {
        log.push("passive " + name);
        return () => void log.push("passive cleanup " + name);
      });
      return props.children ?? name;
    });
  /** An error boundary class: getDerivedStateFromError unless `didCatchOnly`, and componentDidCatch. */
  const boundary = (L: Lib, log: string[], name = "B", didCatchOnly = false) => {
    class Boundary extends L.Component<Any> {
      state = { failed: false };
      constructor(props: Any) {
        super(props);
        log.push("construct " + name);
      }
      componentDidCatch(e: Any) {
        log.push(name + " did catch " + e.message);
      }
      render() {
        log.push("render " + name + (this.state.failed ? " failed" : ""));
        return this.state.failed ? name + " failed" : this.props.children;
      }
    }
    if (!didCatchOnly) (Boundary as Any).getDerivedStateFromError = () => ({ failed: true });
    Object.defineProperty(Boundary, "name", { value: name });
    return Boundary;
  };

  test("insertion effects, layout cleanups, ref detaches and componentWillUnmount wait for the whole render", async () => {
    // React runs them in its commit's mutation phase, after every component rendered, children
    // before parents, a removed subtree's where its parent's are.
    const make = (L: Lib, log: string[], failIn = "") => {
      const h = L.createElement;
      const refs: Record<string, Any> = {};
      const ref = (name: string) => (refs[name] ??= (el: Any) => void log.push(`ref ${name} ${el ? "set" : "null"}`));
      const Fx = named(log, "Fx", ({ name, k, children }) => {
        L.useInsertionEffect(() => {
          log.push(`insertion ${name} ${k}`);
          return () => void log.push(`insertion cleanup ${name} ${k}`);
        }, [k]);
        L.useLayoutEffect(() => {
          log.push(`layout ${name} ${k}`);
          return () => {
            log.push(`layout cleanup ${name} ${k}`);
            if (failIn === name && k === 0) throw new Error("cleanup " + name);
          };
        }, [k]);
        L.useEffect(() => {
          log.push(`passive ${name} ${k}`);
          return () => void log.push(`passive cleanup ${name} ${k}`);
        }, [k]);
        return h("p", { ref: ref(name + k) }, children ?? name);
      });
      class Gone extends L.Component<Any> {
        componentWillUnmount() {
          log.push("willUnmount Gone");
        }
        render() {
          return h(Fx, { name: "inGone", k: 0 });
        }
      }
      const B = boundary(L, log);
      const App = named(log, "App", ({ k }) =>
        h(
          "main",
          null,
          h(Fx, { name: "a", k }),
          k === 0 ? h(Gone, { ref: ref("gone") }) : null,
          h(B, null, h(Fx, { name: "b", k }, h(Fx, { name: "inner", k }))),
          h(Fx, { name: "c", k }),
        ),
      );
      const steps: Step[] = [
        (root, flush) => flush(() => root.render(h(App, { k: 0 }))),
        (root, flush) => flush(() => root.render(h(App, { k: 1 }))),
      ];
      return steps;
    };
    await stepsSame((L, log) => make(L, log));
    // A cleanup that throws: the commit goes on, then its boundary (or the root) has the error.
    await stepsSame((L, log) => make(L, log, "inner"));
    await stepsSame((L, log) => make(L, log, "c"));
  });

  test("an update's invalid props throw as it commits: the render goes on, the element starts the stack", async () => {
    const bad: Record<string, (L: Lib) => Any> = {
      html: (L) => L.createElement("div", { id: "b", dangerouslySetInnerHTML: { __html: "h" } }, "t"),
      form: (L) => L.createElement("div", { id: "b", dangerouslySetInnerHTML: "h" }),
      area: (L) => L.createElement("textarea", { dangerouslySetInnerHTML: { __html: "h" } }),
      style: (L) => L.createElement("div", { id: "b", style: "color: red" }, "t"),
      text: (L) => L.createElement("br", { id: "b" }, "t"),
      nodes: (L) => L.createElement("br", { id: "b" }, L.createElement("i")),
    };
    for (const kind of Object.keys(bad))
      for (const caught of [true, false])
        await stepsSame((L, log) => {
          const h = L.createElement,
            B = boundary(L, log);
          const first =
            kind === "text" || kind === "nodes"
              ? h("br", { id: "a" })
              : kind === "area"
                ? h("textarea")
                : h("div", { id: "a" }, "t");
          const Inner = withEffects(L, log, "Inner");
          const Mid = named(log, "Mid", (p) => h(Inner, null, p.on ? bad[kind]!(L) : first));
          const After = withEffects(L, log, "After");
          const tree = (on: boolean) => {
            const mid = h(Mid, { on });
            return h("section", null, h(After, null, "before"), caught ? h(B, null, mid, h(After)) : mid, h(After));
          };
          return [
            (root, flush) => flush(() => root.render(tree(false))),
            (root, flush) => flush(() => root.render(tree(true))),
          ];
        });
  });

  test("an error no boundary catches renders the root again before it is reported", async () => {
    const mount = await stepsSame((L, log) => {
      const h = L.createElement,
        App = withEffects(L, log, "App"),
        Sib = withEffects(L, log, "Sib"),
        Boom = thrower(log);
      return [
        (root, flush) =>
          flush(() => root.render(h(App, null, h(Sib, { key: 1 }), h(Boom, { key: 2 }), h(Sib, { key: 3 })))),
      ];
    });
    expect(mount.filter((l) => l === "render Boom")).toHaveLength(2);
    // An update, outside flushSync, in a transition, and inside Suspense (which errors pass).
    await stepsSame((L, log) => {
      const h = L.createElement,
        App = withEffects(L, log, "App"),
        Sib = withEffects(L, log, "Sib"),
        Boom = thrower(log);
      // The children are made in Page's render: elements passed through from above (the same
      // objects in both passes) are not rendered again in compat's retry, where React's renders
      // them again from the last commit.
      const Page = named(log, "Page", (props) =>
        h(App, null, h(Sib, { key: 1 }), h(Boom, { key: 2, fail: props.fail })),
      );
      return [
        (root, flush) => flush(() => root.render(h(Page, { fail: false }))),
        (root, flush) => flush(() => root.render(h(Page, { fail: true }))),
      ];
    });
    for (const how of ["default", "transition", "suspense"])
      await stepsSame((L, log) => {
        const h = L.createElement,
          el = h("div", null, h(thrower(log)));
        return [
          (root, _, L) =>
            how === "default"
              ? root.render(el)
              : how === "transition"
                ? L.startTransition(() => root.render(el))
                : root.render(h(L.Suspense, { fallback: "…" }, el)),
        ];
      });
    // The same error object thrown again keeps the stack it was captured with: only #520's
    // wrapper captures one; a string is captured anew each time.
    for (const raw of [new Error("same"), "a string"])
      await stepsSame((L, log) => [
        (root, flush) => flush(() => root.render(L.createElement(thrower(log, "Boom", raw)))),
      ]);
  });

  test("an update rendered again calls getSnapshotBeforeUpdate once, with the props and state before it", async () => {
    // Compat takes the snapshot before the class renders (it writes the DOM as it renders), React
    // as it commits: the log keeps the snapshots and updates, not where they fall among renders.
    for (const where of ["self", "child", "class"])
      for (const withDidUpdate of [true, false]) {
        const run = async (L: Lib, createRoot: (c: Any, o: Any) => Any, flush: (fn: () => void) => void) => {
          const log: string[] = [];
          let throws = 0;
          class Snap extends L.Component<Any> {
            getSnapshotBeforeUpdate(pp: Any, ps: Any) {
              log.push(`snapshot ${pp.k} ${ps.n} -> ${this.props.k} ${this.state.n}`);
              return "snap" + pp.k;
            }
            state = { n: 0 };
            render() {
              if (where === "class" && this.props.k === 1 && throws-- > 0) throw new Error("once");
              return this.props.children;
            }
          }
          if (withDidUpdate)
            (Snap.prototype as Any).componentDidUpdate = function (pp: Any, ps: Any, snap: Any) {
              log.push(`didUpdate ${pp.k} ${ps.n} ${snap}`);
            };
          const Leaf = ({ k }: Any) => {
            if (where === "child" && k === 1 && throws-- > 0) throw new Error("once");
            return "leaf" + k;
          };
          const C = ({ k }: Any) => {
            if (where === "self" && k === 1 && throws-- > 0) throw new Error("once");
            return L.createElement(Leaf, { k });
          };
          const root = createRoot(box(), { onRecoverableError: () => void log.push("recoverable") });
          let snap: Any;
          const App = ({ k }: Any) =>
            L.createElement(Snap, { k, ref: (s: Any) => void (snap = s) }, L.createElement(C, { k }));
          flush(() => root.render(L.createElement(App, { k: 0 })));
          throws = 1;
          flush(() => root.render(L.createElement(App, { k: 1 })));
          await tasks();
          // Later updates take their own snapshot: a state change, then forceUpdate twice.
          flush(() => snap.setState({ n: 1 }));
          flush(() => snap.forceUpdate());
          flush(() => snap.forceUpdate());
          await tasks();
          return log;
        };
        const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
        expect(await run(Compat, (c, o) => Compat.createRoot(c as unknown as Element, o), Compat.flushSync)).toEqual(
          react,
        );
      }
  });

  test("a component whose own update throws renders again, then its boundary or root has the error", async () => {
    for (const caught of [true, false])
      for (const how of ["sync", "default"])
        await stepsSame((L, log) => {
          const h = L.createElement,
            B = boundary(L, log);
          let set: Any = null;
          const Boom = named(log, "Boom", () => {
            const [n, s] = L.useState(0);
            set = s;
            log.push("state " + n);
            if (n) throw new Error("boom");
            return n;
          });
          const Parent = named(log, "Parent", () => h(Boom));
          return [
            (root, flush) => flush(() => root.render(caught ? h(B, null, h(Parent)) : h(Parent))),
            (_, flush) => (how === "sync" ? flush(() => set(1)) : set(1)),
          ];
        });
    // A class whose update throws below it renders again from its state before the update, so
    // shouldComponentUpdate sees the change again.
    await stepsSame((L, log) => {
      const h = L.createElement,
        B = boundary(L, log);
      let inst: Any = null;
      const Child = thrower(log, "Child");
      class P extends L.PureComponent<Any> {
        state = { n: 0 };
        constructor(props: Any) {
          super(props);
          inst = this;
        }
        shouldComponentUpdate(_: Any, s: Any) {
          log.push("should update " + s.n);
          return s.n !== this.state.n;
        }
        render() {
          log.push("render P " + this.state.n);
          return h(Child, { fail: this.state.n > 0 });
        }
      }
      return [
        (root, flush) => flush(() => root.render(h(B, null, h(P)))),
        (_, flush) => flush(() => inst.setState({ n: 1 })),
      ];
    });
  });

  test("an error boundary's first render: the whole root renders twice, the boundary's fallback in each", async () => {
    const h = (L: Lib) => L.createElement;
    // getDerivedStateFromError, with siblings, effects and a parent around the boundary.
    await stepsSame((L, log) => {
      const B = boundary(L, log),
        App = withEffects(L, log, "App"),
        Pre = withEffects(L, log, "Pre"),
        Rest = withEffects(L, log, "Rest");
      return [
        (root, flush) =>
          flush(() =>
            root.render(
              h(L)(App, null, h(L)(Pre, { key: 0 }), h(L)(B, { key: 1 }, h(L)(thrower(log))), h(L)(Rest, { key: 2 })),
            ),
          ),
      ];
    });
    // componentDidCatch only (the fallback renders nothing), two boundaries, a class that throws
    // (constructed again), and a fallback that throws to the boundary above.
    await stepsSame((L, log) => [
      (root, flush) => flush(() => root.render(h(L)(boundary(L, log, "B", true), null, h(L)(thrower(log))))),
    ]);
    await stepsSame((L, log) => {
      const B = boundary(L, log);
      return [
        (root, flush) =>
          flush(() => root.render([h(L)(B, { key: 1 }, h(L)(thrower(log))), h(L)(B, { key: 2 }, h(L)(thrower(log)))])),
      ];
    });
    await stepsSame((L, log) => {
      class K extends L.Component<Any> {
        constructor(props: Any) {
          super(props);
          log.push("construct K");
        }
        render(): Any {
          log.push("render K");
          throw new Error("k");
        }
      }
      return [(root, flush) => flush(() => root.render(h(L)(boundary(L, log), null, h(L)(K))))];
    });
    await stepsSame((L, log) => {
      class Inner extends L.Component<Any> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          log.push("render Inner " + this.state.failed);
          if (this.state.failed) throw new Error("fallback");
          return this.props.children;
        }
      }
      return [
        (root, flush) =>
          flush(() => root.render(h(L)(boundary(L, log, "Outer"), null, h(L)(Inner, null, h(L)(thrower(log)))))),
      ];
    });
  });

  test("an error boundary that catches in an update renders again before its fallback commits", async () => {
    // The boundary's own update makes a child throw, and a parent's update mounts a child that
    // throws: the boundary renders from before the update again (React renders the whole root).
    await stepsSame((L, log) => {
      const h = L.createElement;
      let inst: Any = null;
      class B extends boundary(L, log) {
        override state = { failed: false, n: 0 };
        constructor(props: Any) {
          super(props);
          inst = this;
        }
        override render() {
          log.push("state " + this.state.n);
          return this.state.failed ? "failed" : h(thrower(log), { fail: this.state.n > 0 });
        }
      }
      return [(root, flush) => flush(() => root.render(h(B))), (_, flush) => flush(() => inst.setState({ n: 1 }))];
    });
    await stepsSame((L, log) => {
      const h = L.createElement,
        B = boundary(L, log),
        Boom = thrower(log);
      const New = named(log, "New", () => {
        L.useState(() => log.push("init New"));
        return h(Boom);
      });
      const P = named(log, "P", (props) => (props.show ? h(New) : "none"));
      return [
        (root, flush) => flush(() => root.render(h(B, null, h(P, { show: false })))),
        (root, flush) => flush(() => root.render(h(B, null, h(P, { show: true })))),
      ];
    });
    // A component's own update throws under a boundary whose fallback throws too: the boundary
    // above catches that.
    await stepsSame((L, log) => {
      const h = L.createElement;
      let set: Any = null;
      class Inner extends L.Component<Any> {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        render() {
          log.push("render Inner " + this.state.failed);
          if (this.state.failed) throw new Error("fallback");
          return this.props.children;
        }
      }
      const Mine = named(log, "Mine", () => {
        const [n, s] = L.useState(0);
        set = s;
        if (n) throw new Error("mine");
        return n;
      });
      return [
        (root, flush) => flush(() => root.render(h(boundary(L, log, "Outer"), null, h(Inner, null, h(Mine))))),
        (_, flush) => flush(() => set(1)),
      ];
    });
  });

  test("a first render whose shell suspends with no boundary above renders once more, as React's prerender", async () => {
    // React's prerender: after the shell suspends, the root renders once more, nothing of it
    // committed; not in a transition. Waits that follow (`waits` of them) are each a render.
    const h = (L: Lib) => L.createElement;
    for (const how of ["sync", "default", "transition"] as const)
      for (const waits of [1, 2])
        await stepsSame((L, log) => {
          log.push("case " + how + " " + waits);
          let left = waits,
            go: () => void = () => {},
            p = Promise.resolve();
          const wait = (): void => {
            p = new Promise<void>((r) => (go = r)).then(() => void left--);
          };
          wait();
          const Late = named(log, "Late", () => {
            L.useState(() => log.push("init Late"));
            if (left) throw p;
            return "late";
          });
          const App = withEffects(L, log, "App"),
            Sib = named(log, "Sib", () => "sib");
          const tree = h(L)(App, null, h(L)(Sib), h(L)(Late));
          const render: Step =
            how === "sync"
              ? (root, flush) => flush(() => root.render(tree))
              : how === "transition"
                ? (root, _, L) => L.startTransition(() => root.render(tree))
                : (root) => root.render(tree);
          const settle: Step = () => {
            const ready = go;
            if (left > 1) wait();
            ready();
          };
          return waits === 1 ? [render, settle] : [render, settle, settle];
        });
  });

  test("a render that throws once and then renders is a recoverable error (#520) with its first stack", async () => {
    const h = (L: Lib) => L.createElement;
    const flaky = (log: string[]) => {
      let calls = 0;
      return named(log, "Flaky", (props) => {
        if (props && calls++ === 0) throw new Error("flaky");
        return "f";
      });
    };
    // On a root's first render, under a boundary, and in an update the component itself makes.
    await stepsSame((L, log) => [
      (root, flush) => flush(() => root.render(h(L)(withEffects(L, log, "App"), null, h(L)(flaky(log))))),
    ]);
    await stepsSame((L, log) => [
      (root, flush) =>
        flush(() =>
          root.render(h(L)(withEffects(L, log, "App"), null, h(L)(boundary(L, log), null, h(L)(flaky(log))))),
        ),
    ]);
    await stepsSame((L, log) => {
      let set: Any = null,
        calls = 0;
      const Once = named(log, "Once", () => {
        const [n, s] = L.useState(0);
        set = s;
        if (n && calls++ === 0) throw new Error("once");
        return n;
      });
      const Sib = withEffects(L, log, "Sib");
      const Parent = named(log, "Parent", () => [h(L)(Sib, { key: 1 }), h(L)(Once, { key: 2 })]);
      return [(root, flush) => flush(() => root.render(h(L)(Parent))), (_, flush) => flush(() => set(1))];
    });
    // The parent's update: a class before the child that throws once runs componentDidUpdate
    // once, after the retry, and a ref that changed is detached once and attached once.
    const refs: string[][] = [];
    await stepsSame((L, log) => {
      let set: Any = null,
        calls = 0;
      class K extends L.Component<Any> {
        componentDidUpdate() {
          log.push("K did update " + this.props.n);
        }
        render() {
          log.push("render K " + this.props.n);
          return this.props.n;
        }
      }
      const Once = named(log, "Once", (props) => {
        if (props.n && calls++ === 0) throw new Error("once");
        return "o";
      });
      // A ref that changes with the update: compat detaches the old one as the element renders,
      // React as it commits, so its calls are compared apart, in order (see below).
      const refLog = (refs[L === React ? 0 : 1] = [] as string[]);
      const Parent = named(log, "Parent", () => {
        const [n, s] = L.useState(0);
        set = s;
        return [
          h(L)(K, { key: 1, n }),
          h(L)("i", { key: 2, ref: (x: Any) => void refLog.push("ref " + n + " " + !!x) }),
          h(L)(Once, { key: 3, n }),
        ];
      });
      return [(root, flush) => flush(() => root.render(h(L)(Parent))), (_, flush) => flush(() => set(1))];
    });
    expect(refs[1]).toEqual(refs[0]!);
    expect(refs[0]).toEqual(["ref 0 true", "ref 0 false", "ref 1 true"]);
  });

  test("the retry computes again the useMemo values the failed render computed", async () => {
    const h = (L: Lib) => L.createElement;
    await stepsSame((L, log) => {
      let set: Any = null,
        calls = 0;
      const Once = named(log, "Once", () => {
        const [n, s] = L.useState(0);
        set = s;
        // Changed deps (computed in the failed render), unchanged deps and none.
        const a = L.useMemo(() => (log.push("memo a " + n), n), [n]);
        const b = L.useMemo(() => (log.push("memo b"), 1), []);
        const c = L.useMemo(() => (log.push("memo c " + n), n));
        if (n && calls++ === 0) throw new Error("once");
        return a + b + c;
      });
      return [(root, flush) => flush(() => root.render(h(L)(Once))), (_, flush) => flush(() => set(1))];
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

  test("without the retry module, an error a render throws counts at once", async () => {
    const Core = await core();
    const seen: string[] = [];
    const root = Core.createRoot(box() as unknown as Element, {
      onUncaughtError: (e: Any) => void seen.push("uncaught " + e.message),
      onRecoverableError: (e: Any) => void seen.push("recoverable " + e.message),
    });
    let calls = 0;
    const Once = () => {
      seen.push("render");
      if (calls++ === 0) throw new Error("once");
      return "ok";
    };
    Core.flushSync(() => root.render(Core.createElement(Once)));
    expect(seen).toEqual(["render", "uncaught once"]);
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
