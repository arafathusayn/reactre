// @reactre/compat's transitions, suspended updates and deferred values against React's production
// client (react-dom@19.3.1), on the fake DOM.
//
// React's client renders concurrently: an update in a transition renders in a task of its own,
// after urgent ones, and an update that suspends where content already shows keeps the screen as
// it was until the data arrives. Each test runs one scene with each library, on a root apiece,
// and expects the same log: what the components and effects write, and the markup at each point
// the scene looks at (synchronously, after the microtasks, after a task, once all settled).
// Renders are in the log too, those of a transition that suspends and is undone included, except
// where React's order depends on the transition lane each transition got: React hands them out
// in a cycle of 14 shared by every root of the page, so which of two transitions waiting at once
// renders first depends on how many came before. Compat renders them in the order they started.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, FakeNode, installFakeDocument } from "@reactre/testdom";

import * as Compat from "../src/index.ts";

// biome-ignore lint: both libraries are used through one untyped interface.
type Any = any;
type Lib = Any;

const load = (specifier: string): Promise<Any> => import(specifier);
const prevEnv = process.env["NODE_ENV"];
process.env["NODE_ENV"] = "production";
const React: Lib = await load("react");
const ReactDOM: Any = await load("react-dom");
// Loaded first, as client.test.ts loads it, so the handlers kept below are the same whichever file
// runs first.
await load("react-dom/server.browser");
// React's client installs its own handlers (flushSync's and preload's) when it first loads, and
// React's server builds a later file loads hand what they cannot place to the ones before it:
// this file's tests have the client's, which go back after it.
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

// React reads window.event as it picks an update's lane, and its document's window (for the
// focused element and the selection) and listeners. They go after each test, so other files see
// the plain fake DOM.
const fakeDoc = new FakeNode(9).ownerDocument as Any;
beforeEach(() => {
  installFakeDocument();
  (globalThis as Any).window = globalThis;
  Object.defineProperty(fakeDoc, "addEventListener", { configurable: true, value: () => {} });
  Object.defineProperty(fakeDoc, "defaultView", {
    configurable: true,
    value: { document: fakeDoc, HTMLIFrameElement: class {}, getSelection: () => null },
  });
});
afterEach(() => {
  delete (globalThis as Any).window;
  delete fakeDoc.addEventListener;
  delete fakeDoc.defaultView;
  delete (FakeElement.prototype as Any).style;
});

// A style declaration, as Suspense hides content with one: it reads and writes the element's
// style attribute each time, as the DOM's reflects it (so a transition undone puts it back).
beforeEach(() =>
  Object.defineProperty(FakeElement.prototype, "style", {
    configurable: true,
    get(this: FakeElement) {
      const el = this;
      const props = (): Map<string, string> => {
        const m = new Map<string, string>();
        for (const part of (el.getAttribute("style") ?? "").split(";")) {
          const at = part.indexOf(":");
          if (at > 0) m.set(part.slice(0, at), part.slice(at + 1));
        }
        return m;
      };
      const write = (k: string, v: string): void => {
        const m = props();
        if (v === "") m.delete(k);
        else m.set(k, v);
        if (m.size) el.setAttribute("style", [...m].map(([n, x]) => `${n}:${x}`).join(";"));
        else el.removeAttribute("style");
      };
      return new Proxy(
        {},
        {
          get: (_, k: string) =>
            k === "setProperty"
              ? (n: string, v: string, important?: string) => write(n, v + (important ? " !" + important : ""))
              : k === "removeProperty"
                ? (n: string) => write(n, "")
                : (props().get(k) ?? ""),
          set: (_, k: string, v: string) => (write(k, "" + v), true),
        },
      );
    },
  }),
);

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

// A <select> and its <option>s, as both libraries read them: the options in tree order, each
// option's selectedness (one per single select), value and disabledness.
class Opt extends FakeElement {
  #on = false;
  defaultSelected = false;
  get selected(): boolean {
    return this.#on;
  }
  set selected(v: boolean) {
    this.#on = v;
    const s = this.parentNode as Any;
    if (v && s instanceof Sel && !s.multiple) for (const o of s.options) if (o !== this) o.#on = false;
  }
  get value(): string {
    return this.getAttribute("value") ?? this.textContent;
  }
  set value(v: string) {
    this.setAttribute("value", v);
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
}
class Sel extends FakeElement {
  multiple = false;
  get options(): Opt[] {
    const out: Opt[] = [];
    for (let c = this.firstChild; c !== null; c = c.nextSibling) if (c instanceof Opt) out.push(c);
    return out;
  }
}

/** Runs `fn` with both libraries making selects and options as Sel and Opt, through the fake document. */
async function withSelects(fn: () => Promise<unknown>): Promise<void> {
  const make = (tag: string): FakeElement =>
    tag === "select" ? new Sel("SELECT") : tag === "option" ? new Opt("OPTION") : new FakeElement(tag.toUpperCase());
  const docMake = Object.getOwnPropertyDescriptor(fakeDoc, "createElement")!;
  const globalMake = (globalThis as Any).document.createElement;
  Object.defineProperty(fakeDoc, "createElement", { configurable: true, writable: true, value: make });
  (globalThis as Any).document.createElement = make;
  try {
    await fn();
  } finally {
    Object.defineProperty(fakeDoc, "createElement", docMake);
    (globalThis as Any).document.createElement = globalMake;
  }
}

/** A promise with its resolve, as tests hand data to components. */
function deferred<T = void>(): { p: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
}

/** What a scene gets: its library, its log, its root and container, and ways to wait. */
interface Kit {
  L: Lib;
  /** createPortal: react-dom's, or compat's. */
  createPortal: (children: Any, container: FakeElement) => Any;
  log: string[];
  root: Any;
  c: FakeElement;
  flushSync: (fn: () => void) => void;
  /** Writes the container's markup to the log, after `label`. */
  snap: (label: string) => void;
  /** Lets every queued microtask run (and the ones they queue). */
  micro: () => Promise<void>;
  /** Lets one macrotask pass: a timer of 0 ms, after which the libraries' tasks have run. */
  task: () => Promise<void>;
  /** Lets everything settle: several timers. */
  settle: () => Promise<void>;
  /** Dispatches a click from the element named `tag`, the first or the `nth`. */
  click: (tag: string, nth?: number) => void;
}

/** Every node under `n`, in document order. */
function nodes(n: FakeNode, out: FakeNode[] = []): FakeNode[] {
  for (let c = n.firstChild; c !== null; c = c.nextSibling) out.push(c, ...nodes(c));
  return out;
}

/**
 * Runs `scene` with React and with compat and expects the same log, without the renders unless
 * `renders`. Returns compat's.
 */
async function same(scene: (k: Kit) => Promise<void>, renders = true): Promise<string[]> {
  const run = async (L: Lib, createRoot: (c: Any) => Any, flushSync: (fn: () => void) => void) => {
    const c = new FakeElement("DIV");
    c.isDocument = true;
    const log: string[] = [];
    const root = createRoot(c);
    const k: Kit = {
      L,
      createPortal: (L === React ? ReactDOM : L).createPortal,
      log,
      root,
      c,
      flushSync,
      snap: (label) => void log.push(label + " " + markup(c)),
      micro: async () => {
        for (let i = 0; i < 10; i++) await null;
      },
      task: () => new Promise((r) => setTimeout(r, 0)),
      settle: async () => {
        for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
      },
      click: (tag, nth = 0) => {
        const at = nodes(c).filter((n) => n.nodeName === tag.toUpperCase())[nth] as FakeElement;
        at.dispatchEvent(new FakeEvent("click"));
      },
    };
    await scene(k);
    await k.settle();
    k.snap("end");
    root.unmount();
    // What the unmount leaves for later runs before the test's window goes.
    await k.settle();
    return renders ? log : log.filter((l) => !l.startsWith("render "));
  };
  const react = await run(React, ReactClient.createRoot, ReactDOM.flushSync);
  const compat = await run(Compat, (c) => Compat.createRoot(c as unknown as Element), Compat.flushSync);
  expect(compat).toEqual(react);
  return compat;
}

/** A component named `name` that logs its renders with what `body` returns, and its effects. */
function logs(L: Lib, log: string[], name: string, body: (props: Any) => Any, effects = true) {
  const C = (props: Any) => {
    const out = body(props);
    log.push(`render ${name} ${typeof out === "string" ? out : ""}`.trimEnd());
    if (effects) {
      L.useLayoutEffect(() => void log.push("layout " + name));
      L.useEffect(() => void log.push("passive " + name));
    }
    return out;
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}

// #region Transitions

describe("transitions", () => {
  test("a transition started outside an event renders in a task, after the code that started it", () =>
    same(async ({ L, log, root, flushSync, snap, micro, task }) => {
      let set: Any;
      const App = logs(L, log, "App", () => {
        const [x, s] = L.useState(0);
        set = s;
        return "x" + x;
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set(1));
      log.push("started");
      snap("sync");
      await micro();
      snap("micro");
      await task();
      snap("task");
    }));

  test("useTransition from a click: isPending renders first, urgently, then the transition", () =>
    same(async ({ L, log, root, flushSync, snap, micro, task, click }) => {
      const App = logs(L, log, "App", () => {
        const [x, setX] = L.useState(0);
        const [pending, start] = L.useTransition();
        return L.createElement("button", { onClick: () => start(() => setX(x + 1)) }, `x${x} ${pending}`);
      });
      flushSync(() => root.render(L.createElement(App)));
      click("button");
      log.push("clicked");
      snap("sync");
      await micro();
      snap("micro");
      await task();
      snap("task");
    }));

  test("useTransition outside an event: isPending and the transition each render in a task", () =>
    same(async ({ L, log, root, flushSync, snap, micro, task }) => {
      let go: Any;
      const App = logs(L, log, "App", () => {
        const [x, setX] = L.useState(0);
        const [pending, start] = L.useTransition();
        go = () => start(() => setX(x + 1));
        return `x${x} ${pending}`;
      });
      flushSync(() => root.render(L.createElement(App)));
      go();
      snap("sync");
      await micro();
      snap("micro");
      await task();
      snap("task");
    }));

  test("an urgent update while a transition waits renders first; the transition is rebased on it", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      let set: Any;
      const App = logs(L, log, "App", () => {
        const [x, s] = L.useState(1);
        set = s;
        return "x" + x;
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set((v: number) => v + 1));
      flushSync(() => set((v: number) => v * 10));
      snap("urgent");
      await task();
      snap("task");
    }));

  test("an urgent update from a click while a transition waits, on another component", () =>
    same(async ({ L, log, root, flushSync, snap, micro, task, click }) => {
      let setSlow: Any;
      const Slow = logs(L, log, "Slow", () => {
        const [v, s] = L.useState("a");
        setSlow = s;
        return v;
      });
      const Fast = logs(L, log, "Fast", () => {
        const [n, setN] = L.useState(0);
        return L.createElement("button", { onClick: () => setN(n + 1) }, "n" + n);
      });
      flushSync(() => root.render(L.createElement("div", null, L.createElement(Slow), L.createElement(Fast))));
      L.startTransition(() => setSlow("b"));
      click("button");
      snap("sync");
      await micro();
      snap("micro");
      await task();
      snap("task");
    }));

  test("transitions started apart render one after the other, each its own commit", () =>
    same(async ({ L, log, root, flushSync, snap, micro, task, click }) => {
      const Item = (name: string) =>
        logs(L, log, name, () => {
          const [x, setX] = L.useState(0);
          const [seen, setSeen] = L.useState(0);
          const [pending, start] = L.useTransition();
          // An urgent update from the first transition's passive effect renders before the second.
          L.useEffect(() => {
            if (x !== seen) setSeen(x);
          });
          return L.createElement(
            "button",
            { onClick: () => start(() => setX(x + 1)) },
            `${name}${x} ${pending} ${seen}`,
          );
        });
      const A = Item("A"),
        B = Item("B");
      flushSync(() => root.render(L.createElement("div", null, L.createElement(A), L.createElement(B))));
      click("button");
      await micro();
      snap("first");
      click("button", 1);
      await micro();
      snap("second");
      await task();
      snap("task");
    }));

  test("root.render() in a transition renders in its task; an urgent one made since replaces it", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const P = logs(L, log, "P", ({ v }) => v);
      flushSync(() => root.render(L.createElement(P, { v: "a" })));
      L.startTransition(() => root.render(L.createElement(P, { v: "b" })));
      snap("sync");
      await task();
      snap("task");
      L.startTransition(() => root.render(L.createElement(P, { v: "c" })));
      flushSync(() => root.render(L.createElement(P, { v: "d" })));
      snap("urgent");
      await task();
      snap("task");
    }));

  test("a class's setState in a transition waits for it; an urgent one renders first", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      let inst: Any;
      class Counter extends L.Component<Any, Any> {
        state = { a: 0, b: 0 };
        render() {
          inst = this;
          log.push(`render ${this.state.a} ${this.state.b}`);
          return `${this.state.a} ${this.state.b}`;
        }
      }
      flushSync(() => root.render(L.createElement(Counter)));
      L.startTransition(() => inst.setState({ a: 1 }));
      flushSync(() => inst.setState({ b: 1 }));
      snap("urgent");
      await task();
      snap("task");
    }));

  test("an async transition commits its updates when the action finishes", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      let go: Any;
      const d = deferred();
      const App = logs(L, log, "App", () => {
        const [x, setX] = L.useState(0);
        const [pending, start] = L.useTransition();
        go = () =>
          start(async () => {
            setX(1);
            await d.p;
          });
        return `x${x} ${pending}`;
      });
      flushSync(() => root.render(L.createElement(App)));
      go();
      await task();
      snap("waiting");
      d.resolve();
      await task();
      snap("done");
    }));
});

// #endregion

// #region Suspending

describe("updates that suspend", () => {
  /** Data a component reads with use(): one promise per key, made once. */
  function data() {
    const gates: Record<string, { p: Promise<string>; resolve: (v: string) => void }> = {};
    const gate = (k: string) => (gates[k] ??= deferred<string>());
    return {
      read: (L: Lib, k: string) => L.use(gate(k).p),
      resolve: (k: string) => gate(k).resolve(k.toUpperCase()),
      // Settled and read before: use() reads it at once.
      ready: async (k: string) => {
        gate(k).resolve(k.toUpperCase());
        await gate(k).p;
        Object.assign(gate(k).p, { status: "fulfilled", value: k.toUpperCase() });
      },
    };
  }

  test("a transition that suspends in a boundary already shown keeps it, and commits once the data comes", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = data();
      await d.ready("a");
      let go: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const App = logs(L, log, "App", () => {
        const [k, setK] = L.useState("a");
        const [pending, start] = L.useTransition();
        go = (n: string) => start(() => setK(n));
        return L.createElement(
          "div",
          null,
          L.createElement("h1", null, `${k} ${pending}`),
          L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      go("b");
      await task();
      snap("waiting");
      await task();
      snap("still");
      d.resolve("b");
      await task();
      snap("resolved");
    }));

  test("a transition undone puts back the DOM, refs, effects, context, classes and portals it changed", () =>
    same(async ({ L, log, root, flushSync, snap, task, createPortal }) => {
      const d = data();
      await d.ready("a");
      const out = new FakeElement("SECTION");
      out.isDocument = true;
      let set: Any;
      const Ctx = L.createContext("none");
      const Reader = logs(L, log, "Reader", () => "ctx " + L.useContext(Ctx));
      class Kept extends L.Component<Any> {
        componentDidUpdate() {
          log.push("class updated " + this.props.k);
        }
        componentWillUnmount() {
          log.push("class unmounted");
        }
        render() {
          return "class " + this.props.k;
        }
      }
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const Effects = ({ k }: Any) => {
        L.useInsertionEffect(() => {
          log.push("insertion " + k);
          return () => void log.push("insertion cleanup " + k);
        }, [k]);
        L.useLayoutEffect(() => {
          log.push("layout " + k);
          return () => void log.push("layout cleanup " + k);
        }, [k]);
        L.useEffect(() => {
          log.push("passive " + k);
          return () => void log.push("passive cleanup " + k);
        }, [k]);
        return null;
      };
      const ref = (n: string) => (el: Any) => void log.push(`ref ${n} ${el === null ? "null" : el.tagName}`);
      const refA = ref("a"),
        refB = ref("b");
      const App = () => {
        const [k, s] = L.useState("a");
        set = s;
        return L.createElement(
          "div",
          { className: "k-" + k, title: k === "a" ? "first" : undefined },
          k === "a" ? L.createElement("p", { key: "a" }, "only a") : L.createElement("i", { key: "b" }, "only b"),
          L.createElement(Ctx.Provider, { value: k }, L.createElement(Reader)),
          k === "a" ? L.createElement(Kept, { k }) : null,
          L.createElement(Kept, { k: k + "2" }),
          L.createElement(Effects, { k }),
          createPortal(L.createElement("b", null, "portal " + k), out),
          L.createElement(
            L.Suspense,
            { fallback: "loading" },
            L.createElement("u", null, "u " + k),
            L.createElement(Page, { k }),
          ),
          L.createElement("h1", { ref: k === "a" ? refA : refB }, "title " + k),
        );
      };
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set("b"));
      await task();
      snap("waiting");
      log.push("portal " + markup(out));
      d.resolve("b");
      await task();
      snap("resolved");
      log.push("portal " + markup(out));
    }));

  test("a transition undone puts back the document metadata it hoisted to <head>, and only that", async () => {
    // A <head> for both libraries: React's (the fake nodes' document) and compat's (`document`).
    const head = new FakeElement("HEAD");
    const doc = document as Any;
    Object.assign(fakeDoc, {
      head,
      querySelector: (sel: string) =>
        sel === "head > title" ? (head.childNodes.find((n) => n.nodeName === "TITLE") ?? null) : null,
    });
    doc.head = head;
    try {
      await same(async ({ L, log, root, flushSync, task }) => {
        head.textContent = "";
        const d = data();
        await d.ready("a");
        let set: Any;
        const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
        // What other code puts in <head> as the transition renders (a CSS-in-JS library) stays.
        const Styles = ({ k }: Any) => {
          if (k === "b") {
            const style =
              head.childNodes.find((n) => n.nodeName === "STYLE") ?? head.appendChild(new FakeElement("STYLE"));
            (style as FakeElement).setAttribute("data-k", k);
          }
          return null;
        };
        const App = () => {
          const [k, s] = L.useState("a");
          set = s;
          return L.createElement(
            "div",
            null,
            L.createElement(Styles, { k }),
            L.createElement("title", null, "page " + k),
            L.createElement("meta", { name: "page", content: k }),
            k === "a" ? L.createElement("meta", { name: "only-a" }) : L.createElement("meta", { name: "only-b" }),
            L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
          );
        };
        flushSync(() => root.render(L.createElement(App)));
        log.push("head " + markup(head));
        L.startTransition(() => set("b"));
        await task();
        log.push("waiting " + markup(head));
        d.resolve("b");
        await task();
        log.push("resolved " + markup(head));
      });
    } finally {
      delete fakeDoc.head;
      delete fakeDoc.querySelector;
      delete doc.head;
    }
  });

  test("a transition undone puts back the form fields' values and checkedness it changed", () =>
    same(async ({ L, log, root, flushSync, task, c }) => {
      const d = data();
      await d.ready("a");
      let set: Any;
      const fields = () => {
        const all = nodes(c) as Any[];
        const [text, box] = all.filter((n) => n.nodeName === "INPUT");
        const area = all.find((n) => n.nodeName === "TEXTAREA");
        log.push(`fields ${text.value} ${box.checked} ${area.value}`);
      };
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const App = () => {
        const [k, s] = L.useState("a");
        set = s;
        return L.createElement(
          "form",
          null,
          L.createElement("input", { value: "text " + k, onChange() {} }),
          L.createElement("input", { type: "checkbox", checked: k !== "a", onChange() {} }),
          L.createElement("textarea", { value: "area " + k, onChange() {} }),
          L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
        );
      };
      flushSync(() => root.render(L.createElement(App)));
      fields();
      L.startTransition(() => set("b"));
      await task();
      fields();
      d.resolve("b");
      await task();
      fields();
    }));

  test("a transition undone puts back its selects' selection", async () => {
    await withSelects(() =>
      same(async ({ L, log, root, flushSync, task, c }) => {
        const d = data();
        await d.ready("a");
        let set: Any;
        const chosen = () => {
          const opts = (nodes(c).find((n) => n.nodeName === "SELECT") as Any).options as Any[];
          log.push("selected " + opts.map((o) => (o.selected ? o.value : "-")).join(" "));
        };
        const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
        const App = () => {
          const [k, s] = L.useState("a");
          set = s;
          return L.createElement(
            "form",
            null,
            L.createElement(
              "select",
              { value: k, onChange() {} },
              ["a", "b", "c"].map((v) => L.createElement("option", { key: v, value: v }, v)),
              // An option the transition removes, put back as it is undone.
              k === "c" ? null : L.createElement("option", { key: "x", value: "x" }, "x"),
            ),
            L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
          );
        };
        flushSync(() => root.render(L.createElement(App)));
        chosen();
        L.startTransition(() => set("c"));
        await task();
        chosen();
        d.resolve("c");
        await task();
        chosen();
      }),
    );
  });

  test("an urgent update renders a transition that waits for data again, over it", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = data();
      await d.ready("a");
      await d.ready("c");
      let set: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const App = logs(L, log, "App", () => {
        const [k, s] = L.useState("a");
        set = s;
        return L.createElement(
          "div",
          null,
          L.createElement("h1", null, k),
          L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set((k: string) => k + "b"));
      await task();
      snap("waiting");
      // Replayed over this, the transition's state is "c" too: its data is there.
      flushSync(() => set("c"));
      snap("urgent");
      await task();
      snap("task");
    }));

  test("a transition whose updates leave state as it was renders the component, and not its children", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      let set: Any, setF: Any;
      const Child = logs(L, log, "Child", ({ v }) => "child " + v);
      const Plain = logs(L, log, "Plain", () => {
        const [v, s] = L.useState(1);
        set = s;
        return L.createElement(Child, { v });
      });
      const Fwd = L.forwardRef(function Fwd(props: Any, ref: Any) {
        const [v, s] = L.useState(1);
        setF = s;
        log.push(`render Fwd ${props.p} ${ref === null ? "no ref" : "ref"}`);
        L.useLayoutEffect(() => void log.push("layout Fwd"));
        return L.createElement(Child, { v });
      });
      flushSync(() =>
        root.render(L.createElement("div", null, L.createElement(Plain), L.createElement(Fwd, { p: "p" }))),
      );
      // Replayed over the urgent updates made since, each transition's leaves the state as they set it.
      L.startTransition(() => {
        set((v: number) => v + 1);
        setF((v: number) => v + 1);
      });
      flushSync(() => {
        set(5);
        setF(5);
      });
      snap("urgent");
      await task();
      snap("task");
    }));

  test("what a transition renders around content that suspends in a shown boundary", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = data();
      await d.ready("a");
      let set: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const Before = logs(L, log, "Before", ({ k }) => "before " + k);
      const After = logs(L, log, "After", ({ k }) => "after " + k);
      const Out = logs(L, log, "Out", ({ k }) => "out " + k);
      const Fallback = logs(L, log, "Fallback", () => "loading");
      const App = logs(L, log, "App", () => {
        const [k, s] = L.useState("a");
        set = s;
        return L.createElement(
          "div",
          null,
          L.createElement(
            L.Suspense,
            { fallback: L.createElement(Fallback) },
            L.createElement(Before, { k }),
            L.createElement(Page, { k }),
            L.createElement(After, { k }),
          ),
          L.createElement(Out, { k }),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set("b"));
      await task();
      snap("waiting");
      d.resolve("b");
      await task();
      snap("resolved");
    }));

  test("two transitions on one state, started apart, render together; another waits for none", () =>
    same(async ({ L, log, root, flushSync, snap, task, micro }) => {
      const d = data();
      await d.ready("a");
      let set: Any, setO: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const Other = logs(L, log, "Other", () => {
        const [o, s] = L.useState(0);
        setO = s;
        return "o" + o;
      });
      let setN: Any;
      const App = logs(L, log, "App", () => {
        const [k, s] = L.useState("a");
        const [n, sn] = L.useState(0);
        set = s;
        setN = sn;
        return L.createElement(
          "div",
          null,
          "n" + n,
          L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
          L.createElement(Other),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set("b"));
      await micro();
      // Its other update waits with the first transition too.
      L.startTransition(() => {
        setN(1);
        set((k: string) => k + "x");
      });
      await task();
      snap("waiting");
      L.startTransition(() => setO(1));
      await task();
      snap("other");
      d.resolve("bx");
      await task();
      snap("resolved");
      // Which renders first, the first two transitions or the third, depends on their lanes.
    }, false));

  test("startTransition that suspends with no boundary above keeps the screen", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = data();
      await d.ready("a");
      let set: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const App = logs(L, log, "App", () => {
        const [k, s] = L.useState("a");
        set = s;
        return L.createElement("div", null, L.createElement("h1", null, k), L.createElement(Page, { k }));
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set("b"));
      await task();
      snap("waiting");
      d.resolve("b");
      await task();
      snap("resolved");
    }));

  test("a transition that mounts a boundary whose content suspends shows its fallback and commits the rest", () =>
    same(async ({ L, log, root, flushSync, snap, settle }) => {
      const d = data();
      let set: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const App = logs(L, log, "App", () => {
        const [k, s] = L.useState("");
        set = s;
        return L.createElement(
          "div",
          null,
          L.createElement("h1", null, k || "none"),
          k ? L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })) : null,
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set("b"));
      // Once its effects ran: one task races React's passive effects' task.
      await settle();
      snap("waiting");
      // React renders the content once its data comes and shows it 300 ms after the fallback
      // appeared; compat waits, then renders.
      d.resolve("b");
      await new Promise((r) => setTimeout(r, 350));
      snap("resolved");
    }));

  test("an update outside a transition that suspends in a shown boundary shows its fallback", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = data();
      await d.ready("a");
      let set: Any;
      const Page = logs(L, log, "Page", ({ k }) => d.read(L, k));
      const App = logs(L, log, "App", () => {
        const [k, s] = L.useState("a");
        set = s;
        return L.createElement(
          "div",
          null,
          L.createElement("h1", null, k),
          L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page, { k })),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      set("b");
      await task();
      snap("waiting");
      d.resolve("b");
      await new Promise((r) => setTimeout(r, 350));
      snap("resolved");
    }));
});

describe("throttled reveals", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("content a boundary shows again within the throttle renders at once and commits when it ends", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = deferred<string>();
      const Page = logs(L, log, "Page", () => L.use(d.p));
      flushSync(() =>
        root.render(
          L.createElement("div", null, L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page))),
        ),
      );
      snap("fallback");
      await sleep(40);
      d.resolve("data");
      await task();
      await task();
      snap("rendered");
      await sleep(320);
      snap("committed");
    }));

  test("an update while a reveal waits to commit drops it; it renders again and commits when the throttle ends", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const d = deferred<string>();
      let set: Any;
      const Page = logs(L, log, "Page", () => L.use(d.p));
      const Count = logs(L, log, "Count", () => {
        const [n, s] = L.useState(0);
        set = s;
        return "n" + n;
      });
      flushSync(() =>
        root.render(
          L.createElement(
            "div",
            null,
            L.createElement(Count),
            L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(Page)),
          ),
        ),
      );
      await sleep(40);
      d.resolve("data");
      await task();
      await task();
      snap("rendered");
      flushSync(() => set(1));
      snap("updated");
      await task();
      await task();
      snap("again");
      await sleep(320);
      snap("committed");
    }));

  test("a held reveal makes again the text, attributes, nodes and fields it changed", () =>
    withSelects(() =>
      same(async ({ L, log, root, flushSync, snap, task, c }) => {
        const d = deferred<string>();
        let set: Any;
        const fields = () => {
          const all = nodes(c) as Any[];
          const input = all.find((n) => n.nodeName === "INPUT");
          const sel = all.find((n) => n.nodeName === "SELECT");
          log.push(`fields ${input.value} ${sel.options.map((o: Any) => (o.selected ? o.value : "-")).join(" ")}`);
        };
        const Page = logs(L, log, "Page", () => L.use(d.p));
        const App = () => {
          const [k, s] = L.useState("a");
          set = s;
          return L.createElement(
            "form",
            null,
            L.createElement("input", { value: "text " + k, onChange() {} }),
            L.createElement(
              "select",
              { value: k, onChange() {} },
              L.createElement("option", { value: "a" }, "a"),
              L.createElement("option", { value: "b" }, "b"),
            ),
            L.createElement(
              L.Suspense,
              { fallback: L.createElement("i", null, "loading") },
              "text",
              L.createElement("b", { style: { display: "flex" } }, "flex"),
              L.createElement(Page),
            ),
          );
        };
        flushSync(() => root.render(L.createElement(App)));
        flushSync(() => set("b"));
        fields();
        await sleep(40);
        d.resolve("data");
        await task();
        await task();
        snap("rendered");
        fields();
        await sleep(320);
        snap("committed");
        fields();
      }),
    ));

  test("a second boundary that can show its content while one waits renders with it", () =>
    same(async ({ L, log, root, flushSync, snap, task }) => {
      const a = deferred<string>(),
        b = deferred<string>();
      const A = logs(L, log, "A", () => L.use(a.p));
      const B = logs(L, log, "B", () => L.use(b.p));
      flushSync(() =>
        root.render(
          L.createElement(
            "div",
            null,
            L.createElement(L.Suspense, { fallback: "a…" }, L.createElement(A)),
            L.createElement(L.Suspense, { fallback: "b…" }, L.createElement(B)),
          ),
        ),
      );
      await sleep(40);
      a.resolve("a");
      await task();
      await task();
      snap("a rendered");
      await sleep(40);
      b.resolve("b");
      await task();
      await task();
      snap("b rendered");
      await sleep(320);
      snap("committed");
    }));
});

// #endregion

// #region Deferred values

describe("useDeferredValue", () => {
  test("an urgent render shows the old value, then a background render the new one", () =>
    same(async ({ L, log, root, flushSync, snap, micro, task, click }) => {
      const List = logs(L, log, "List", ({ q }) => "list " + q);
      const App = logs(L, log, "App", () => {
        const [q, setQ] = L.useState("a");
        const dq = L.useDeferredValue(q);
        return L.createElement(
          "div",
          null,
          L.createElement("button", { onClick: () => setQ(q + "b") }, q),
          L.createElement(L.memo(List), { q: dq }),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      click("button");
      await micro();
      snap("micro");
      await task();
      snap("task");
    }));

  test("an initial value shows first, then a background render the value", () =>
    same(async ({ L, log, root, snap, micro, task }) => {
      const App = logs(L, log, "App", () => "v " + L.useDeferredValue("value", "initial"));
      root.render(L.createElement(App));
      await micro();
      snap("micro");
      await task();
      snap("task");
    }));

  test("a background render that suspends keeps the old value on screen", () =>
    same(async ({ L, log, root, flushSync, snap, task, click }) => {
      const gates: Record<string, Any> = {};
      const gate = (k: string) => (gates[k] ??= deferred<string>());
      gate("a").resolve("A");
      await gate("a").p;
      Object.assign(gate("a").p, { status: "fulfilled", value: "A" });
      const List = logs(L, log, "List", ({ q }) => L.use(gate(q).p));
      const App = logs(L, log, "App", () => {
        const [q, setQ] = L.useState("a");
        const dq = L.useDeferredValue(q);
        return L.createElement(
          "div",
          null,
          L.createElement("button", { onClick: () => setQ(q + "b") }, q),
          L.createElement(L.Suspense, { fallback: "loading" }, L.createElement(List, { q: dq })),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      click("button");
      await task();
      snap("waiting");
      gate("ab").resolve("AB");
      await task();
      snap("resolved");
    }));
});

// #endregion

// #region Timing

describe("timing", () => {
  for (const how of ["default", "transition"] as const)
    test(`a ${how} update's render and effects against timers and microtasks`, () =>
      same(async ({ L, log, root, flushSync, settle }) => {
        let set: Any;
        const App = logs(L, log, "App", () => {
          const [x, s] = L.useState(0);
          set = s;
          return "x" + x;
        });
        flushSync(() => root.render(L.createElement(App)));
        setTimeout(() => log.push("timeout before"), 0);
        if (how === "default") set(1);
        else L.startTransition(() => set(1));
        queueMicrotask(() => log.push("microtask"));
        setTimeout(() => log.push("timeout after"), 0);
        await settle();
      }));

  test("a store that moves while a transition renders makes it render again before it commits", () =>
    same(async ({ L, log, root, flushSync, settle }) => {
      let value = 0,
        set: Any;
      const get = () => (log.push("get " + value), value);
      const subscribe = () => () => {};
      const Moves = logs(L, log, "Moves", ({ p }) => {
        if (p === 1 && value === 0) value = 7;
        return "p" + p;
      });
      const App = logs(L, log, "App", () => {
        const [p, s] = L.useState(0);
        set = s;
        return L.createElement(
          "div",
          null,
          "v" + L.useSyncExternalStore(subscribe, get),
          L.createElement(Moves, { p }),
        );
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set(1));
      await settle();
    }));

  test("useSyncExternalStore is checked once more before a transition commits", () =>
    same(async ({ L, log, root, flushSync, settle }) => {
      let value = 0,
        set: Any;
      const get = () => (log.push("get " + value), value);
      const subscribe = () => () => {};
      const App = logs(L, log, "App", () => {
        const [p, s] = L.useState(0);
        set = s;
        return "v" + L.useSyncExternalStore(subscribe, get) + " " + p;
      });
      flushSync(() => root.render(L.createElement(App)));
      L.startTransition(() => set(1));
      await settle();
      // The store moves on while the transition waits for its task: the transition renders it.
      L.startTransition(() => set(2));
      value = 5;
      await settle();
    }));
});

// #endregion
