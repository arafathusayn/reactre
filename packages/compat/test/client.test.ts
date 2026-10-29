// @reactre/compat's client against React's own (react-dom@19.3.1, production builds), on the fake
// DOM.
//
// React's production client runs on the fake DOM with the few additions below (a window for its
// selection code, localName and splitText for hydration). Each test builds one tree twice, once
// from React and once from compat, renders each with its own library and expects the same: the
// ids useId gives while hydrating server HTML, the rows and their state when keys repeat, the
// component stacks errors are reported with, and the errors themselves: React's production codes.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

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
const ReactServer: Any = await load("react-dom/server.browser");
// React's client installs its own handlers for preload, preconnect and the rest, which React's
// server builds a later file loads hand what they cannot place to: the ones before it go back
// after this file.
const internals = ReactDOM.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const dispatcher = internals.d;
afterAll(() => void (internals.d = dispatcher));
const ReactClient: Any = await load("react-dom/client");
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
      root.render(h(Compat.Suspense, null, h("div", null, h(Compat.SuspenseList, null, h(Boom))))),
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
          void log.push(`recoverable ${code(e)}${e.digest === undefined ? "" : " " + e.digest}${info.componentStack}`),
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
    const { messages, ...compat } = await run(Compat, (c, el, o) => Compat.hydrateRoot(c, el, o));
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
