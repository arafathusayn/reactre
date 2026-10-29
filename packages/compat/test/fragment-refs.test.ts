// Unit tests for @reactre/compat's Fragment refs (React 19.3's FragmentInstance) on the fake DOM.
//
// Covered here: when a Fragment's ref attaches and detaches, each FragmentInstance method as
// react-dom 19.3.1 implements it (listeners, dispatch, focus, observers, rects, root node,
// document position, scrolling), the listeners and observers hosts get and lose as they mount,
// unmount, hide and show, and how hidden content, portals and compiled blocks take part.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeComment, FakeElement, FakeFragment, FakeNode, FakeText, installFakeDocument } from "@reactre/testdom";

import {
  __block,
  __template,
  Activity,
  createElement as h,
  createPortal,
  createRef,
  createRoot,
  flushSync,
  Fragment,
  type Root,
  StrictMode,
  Suspense,
  useLayoutEffect,
  useState,
} from "../src/core.ts";

// #region Fixtures

// biome-ignore lint: fake nodes and instances are untyped here.
type Any = any;

let container: FakeElement;
let root: Root;
const render = (el: unknown): void => flushSync(() => root.render(el));
/** A portal into a fake node. */
const portal = (children: unknown, at: FakeNode): unknown => createPortal(children, at as unknown as Element);
const nextTask = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 1000): Promise<void> {
  for (const end = performance.now() + ms; !ok();) {
    if (performance.now() > end) throw new Error("timed out");
    await nextTask(5);
  }
}

/** A short name for a node: its tag lowercased, `#` and its data for text, `<!>` for a comment. */
const name = (n: Any): string =>
  n.nodeType === 3 ? "#" + n.data : n.nodeType === 8 ? "<!>" : String(n.tagName ?? n.nodeName).toLowerCase();
const el = (tag: string, under: FakeNode = container): Any => {
  const walk = (n: FakeNode): Any => {
    for (let c = n.firstChild; c !== null; c = c.nextSibling) {
      if (c instanceof FakeElement && c.tagName === tag.toUpperCase()) return c;
      const x = walk(c);
      if (x !== null) return x;
    }
    return null;
  };
  return walk(under);
};

// What the fake DOM lacks and these tests need, added while this file runs: an EventTarget on
// every node (listeners keyed by type, function and capture, as a browser keeps them, with
// bubbling dispatch), getRootNode, contains, parentElement and compareDocumentPosition, and on
// elements focus, blur, getClientRects, scrollIntoView and a style declaration. The fake
// document gets listeners and createRange, and a `window` with scrolling stands in.
const LISTENERS = Symbol("listeners");
const captures = (o: Any): boolean => (typeof o === "boolean" ? o : !!o?.capture);
/** Every addEventListener and removeEventListener call: [kind, node name, type, options]. */
let calls: Any[][] = [];
/** The listeners `n` holds for `type`. */
const listening = (n: Any, type = "ping"): number => n[LISTENERS]?.get(type)?.length ?? 0;
function addListener(this: Any, type: string, fn: Any, o?: Any): void {
  calls.push(["add", name(this), type, o]);
  if (fn == null) return;
  const m: Map<string, { fn: Any; capture: boolean }[]> = (this[LISTENERS] ??= new Map());
  const list = m.get(type) ?? [];
  if (!list.some((e) => e.fn === fn && e.capture === captures(o))) m.set(type, [...list, { fn, capture: captures(o) }]);
}
function removeListener(this: Any, type: string, fn: Any, o?: Any): void {
  calls.push(["remove", name(this), type, o]);
  const m = this[LISTENERS];
  const list = m?.get(type);
  if (list !== undefined)
    m.set(
      type,
      list.filter((e: Any) => !(e.fn === fn && e.capture === captures(o))),
    );
}
function dispatch(this: Any, e: Any): boolean {
  e.target ??= this;
  for (let n = this; n != null; n = e.bubbles ? n.parentNode : null) {
    e.currentTarget = n;
    for (const { fn } of n[LISTENERS]?.get(e.type) ?? []) {
      if (typeof fn === "function") fn.call(n, e);
      else fn.handleEvent(e);
    }
  }
  return !e.defaultPrevented;
}
const ev = (type: string, bubbles = true): Any => ({ type, bubbles, target: null, currentTarget: null });

// Document position, as the DOM computes it for nodes in one tree or two.
function position(this: Any, other: Any): number {
  if (this === other) return 0;
  const up = (n: Any): Any[] => {
    const a = [n];
    while (n.parentNode !== null) a.push((n = n.parentNode));
    return a;
  };
  const a = up(this),
    b = up(other);
  if (a.at(-1) !== b.at(-1)) return 1 | 32 | 4;
  if (b.includes(this)) return 16 | 4;
  if (a.includes(other)) return 8 | 2;
  let i = a.length - 1,
    j = b.length - 1;
  while (a[i - 1] === b[j - 1]) {
    i--;
    j--;
  }
  for (let s = a[i - 1].nextSibling; s !== null; s = s.nextSibling) if (s === b[j - 1]) return 4;
  return 2;
}

const doc: Any = new FakeText("").ownerDocument;
const FOCUSABLE = new Set(["A", "BUTTON", "INPUT"]);
let focusCalls: Any[][] = [];
let blurred: string[] = [];
let scrolls: Any[][] = [];
let rootNodeOptions: Any;
const styles = new WeakMap<object, Any>();

const nodeExtras: Record<string, PropertyDescriptor> = {
  addEventListener: { configurable: true, writable: true, value: addListener },
  removeEventListener: { configurable: true, writable: true, value: removeListener },
  dispatchEvent: { configurable: true, writable: true, value: dispatch },
  getRootNode: {
    configurable: true,
    value(this: Any, o: Any) {
      rootNodeOptions = o;
      let n = this;
      while (n.parentNode !== null) n = n.parentNode;
      return n;
    },
  },
  contains: {
    configurable: true,
    value(this: Any, other: Any) {
      for (let n = other; n !== null; n = n.parentNode) if (n === this) return true;
      return false;
    },
  },
  parentElement: {
    configurable: true,
    get(this: Any) {
      const p = this.parentNode;
      return p !== null && p.nodeType === 1 ? p : null;
    },
  },
  compareDocumentPosition: { configurable: true, value: position },
};
const elementExtras: Record<string, PropertyDescriptor> = {
  addEventListener: nodeExtras["addEventListener"]!,
  dispatchEvent: nodeExtras["dispatchEvent"]!,
  focus: {
    configurable: true,
    value(this: Any, o: Any) {
      focusCalls.push([name(this), o]);
      if (!FOCUSABLE.has(this.tagName)) return;
      doc.activeElement = this;
      doc.dispatchEvent(ev("focus", false));
    },
  },
  blur: {
    configurable: true,
    value(this: Any) {
      blurred.push(name(this));
      if (doc.activeElement === this) doc.activeElement = null;
    },
  },
  getClientRects: {
    configurable: true,
    value(this: Any) {
      return ["rect " + name(this)];
    },
  },
  scrollIntoView: {
    configurable: true,
    value(this: Any, a: Any) {
      scrolls.push([name(this), a]);
    },
  },
  style: {
    configurable: true,
    get(this: Any) {
      let s = styles.get(this);
      if (s === undefined) {
        s = {} as Any;
        Object.defineProperties(s, {
          setProperty: { value: (k: string, v: string) => void (s[k] = v) },
          removeProperty: { value: (k: string) => void delete s[k] },
        });
        styles.set(this, s);
      }
      return s;
    },
  },
};
const saved = new Map<string, PropertyDescriptor | undefined>();
const g = globalThis as Any;
beforeAll(() => {
  Object.defineProperties(FakeNode.prototype, nodeExtras);
  for (const k in elementExtras) saved.set(k, Object.getOwnPropertyDescriptor(FakeElement.prototype, k));
  Object.defineProperties(FakeElement.prototype, elementExtras);
  doc.addEventListener = addListener;
  doc.removeEventListener = removeListener;
  doc.dispatchEvent = dispatch;
  doc.createRange = () => {
    let node: Any = null;
    return {
      selectNodeContents: (n: Any) => void (node = n),
      getClientRects: () => ["range " + name(node)],
      getBoundingClientRect: () => ({ left: 1, top: 2, bottom: 3 }),
    };
  };
  g.window = {
    scrollX: 10,
    scrollY: 20,
    innerHeight: 100,
    scrollTo: (x: number, y: number) => void scrolls.push(["window", x, y]),
  };
});
afterAll(() => {
  for (const k in nodeExtras) delete (FakeNode.prototype as Any)[k];
  for (const k in elementExtras) {
    delete (FakeElement.prototype as Any)[k];
    const d = saved.get(k);
    if (d !== undefined) Object.defineProperty(FakeElement.prototype, k, d);
  }
  for (const k of ["addEventListener", "removeEventListener", "dispatchEvent", "createRange", "body"]) delete doc[k];
  delete g.window;
});

beforeEach(() => {
  installFakeDocument();
  g.document.head = new FakeElement("HEAD");
  container = new FakeElement("DIV");
  container.isDocument = true;
  root = createRoot(container as unknown as Element);
  calls = [];
  focusCalls = [];
  blurred = [];
  scrolls = [];
  doc.activeElement = null;
  doc.body = undefined;
});

/** A fake observer that logs what it observes and unobserves; an IntersectionObserver has rootMargin. */
function observer(intersection: boolean): Any {
  const log: string[] = [];
  const o: Any = {
    log,
    observe: (n: Any) => void log.push("observe " + name(n)),
    unobserve: (n: Any) => void log.push("unobserve " + name(n)),
  };
  if (intersection) o.rootMargin = "0px";
  return o;
}

/** A list whose items a test sets: `<li>` rows, each with a `<b>` inside. */
let setItems!: (v: string[]) => void;
function List({ init = ["a", "b"] }: { init?: string[] }) {
  const [items, set] = useState(init);
  setItems = set;
  return items.map((k) => h("li", { key: k, title: k }, h("b", null, k)));
}
const items = (): string[] => [...el("ul").childNodes].map((n: Any) => n.getAttribute("title"));

// #endregion

describe("Fragment refs", () => {
  test("a Fragment's ref gets its FragmentInstance before the children's refs and layout effects", () => {
    const log: string[] = [];
    function Child() {
      useLayoutEffect(() => void log.push("child effect"));
      return null;
    }
    const ref = (fi: Any) => void log.push(fi === null ? "fragment null" : "fragment " + typeof fi.focusLast);
    render(h(Fragment, { ref }, h("div", { ref: () => void log.push("div ref") }), h(Child)));
    expect(log).toEqual(["fragment function", "div ref", "child effect"]);
  });

  test("an object ref, a changed ref, a cleanup function and unmount, as host refs have them", () => {
    const a = createRef<Any>();
    render(h(Fragment, { ref: a }, h("p")));
    const fi = a.current;
    expect(typeof fi.compareDocumentPosition).toBe("function");
    const log: string[] = [];
    const withCleanup = (v: Any) => {
      log.push(v === fi ? "same instance" : "other");
      return () => void log.push("cleanup");
    };
    render(h(Fragment, { ref: withCleanup }, h("p")));
    expect(a.current).toBe(null);
    expect(log).toEqual(["same instance"]);
    render(h(Fragment, null, h("p")));
    expect(log).toEqual(["same instance", "cleanup"]);
    const plain = (v: Any) => void log.push(v === null ? "null" : "plain");
    render(h(Fragment, { ref: plain }, h("p")));
    render(h("i"));
    expect(log).toEqual(["same instance", "cleanup", "plain", "null"]);
  });

  test("other built-ins rendered as fragments ignore a ref, as React does", () => {
    const r = createRef<Any>();
    render(h(StrictMode, { ref: r }, h("p")));
    render(h(StrictMode, { ref: null }, h("p")));
    expect(r.current).toBe(null);
  });
});

describe("listeners", () => {
  test("addEventListener reaches each top-level node, text included, not the nodes inside them", () => {
    const r = createRef<Any>();
    render(h("ul", null, h(Fragment, { ref: r }, h(List, {}), "t")));
    const fi = r.current;
    const fn = () => {};
    fi.addEventListener("ping", fn);
    const ul = el("ul");
    expect([...ul.childNodes].map((n: Any) => listening(n))).toEqual([1, 1, 1]);
    expect(listening(el("b"))).toBe(0);
    expect(listening(ul)).toBe(0);
    // The same type, function and capture flag again adds nothing; another capture flag does.
    fi.addEventListener("ping", fn, false);
    fi.addEventListener("ping", fn, { capture: true });
    fi.addEventListener("ping", fn, true);
    expect(listening(ul.firstChild)).toBe(2);
    fi.removeEventListener("ping", fn, { capture: true });
    expect(listening(ul.firstChild)).toBe(1);
    fi.removeEventListener("ping", () => {});
    fi.removeEventListener("ping", fn);
    expect([...ul.childNodes].map((n: Any) => listening(n))).toEqual([0, 0, 0]);
  });

  test("hosts that mount get the listeners, hosts that unmount lose them, hosts that move keep them", () => {
    const r = createRef<Any>();
    render(h("ul", null, h(Fragment, { ref: r }, h(List, {}))));
    r.current.addEventListener("ping", () => {}, { passive: true });
    calls = [];
    flushSync(() => setItems(["a", "c", "b"]));
    expect(calls).toEqual([["add", "li", "ping", { passive: true }]]);
    expect(listening(el("ul").childNodes[1])).toBe(1);
    calls = [];
    flushSync(() => setItems(["c", "a"]));
    // b goes; a moves and keeps its listener; nothing is added again.
    expect(calls).toEqual([["remove", "li", "ping", { passive: true }]]);
    expect(items()).toEqual(["c", "a"]);
    expect([...el("ul").childNodes].map((n: Any) => listening(n))).toEqual([1, 1]);
  });

  test("text that mounts gets them too, and a host inside a new host does not", () => {
    const r = createRef<Any>();
    let set!: (v: boolean) => void;
    function Text() {
      const [on, setOn] = useState(false);
      set = setOn;
      return on ? ["x", h("p", null, h("span"), "y")] : null;
    }
    render(h("div", null, h(Fragment, { ref: r }, h(Text))));
    r.current.addEventListener("ping", () => {});
    flushSync(() => set(true));
    const [x, p] = el("div").childNodes;
    expect([listening(x), listening(p), listening(el("span"))]).toEqual([1, 1, 0]);
  });

  test("nested fragments with refs give a new host the inner one's listeners, then the outer one's", () => {
    const outer = createRef<Any>(),
      inner = createRef<Any>();
    render(h("ul", null, h(Fragment, { ref: outer }, h(Fragment, { ref: inner }, h(List, {})))));
    outer.current.addEventListener("outer", () => {});
    inner.current.addEventListener("inner", () => {});
    calls = [];
    flushSync(() => setItems(["a", "b", "c"]));
    expect(calls.map((c) => c[2])).toEqual(["inner", "outer"]);
  });

  test("a once listener runs once, from every node, and handleEvent objects are called", () => {
    const r = createRef<Any>();
    render(h("div", null, h(Fragment, { ref: r }, h("p"), h("i"))));
    const fi = r.current;
    const seen: string[] = [];
    fi.addEventListener(
      "ping",
      function (this: Any) {
        seen.push("once " + name(this));
      },
      { once: true, passive: true },
    );
    fi.addEventListener("ping", { handleEvent: (e: Any) => void seen.push("object " + name(e.currentTarget)) });
    fi.addEventListener(
      "ping",
      { handleEvent: (e: Any) => void seen.push("once object " + name(e.target)) },
      { once: true },
    );
    // The once flag is the instance's to keep: nodes get only capture and passive.
    expect(calls.filter((c) => c[1] === "p")[0]![3]).toEqual({ capture: undefined, passive: true });
    el("i").dispatchEvent(ev("ping", false));
    el("p").dispatchEvent(ev("ping", false));
    expect(seen).toEqual(["once i", "object i", "once object i", "object p"]);
    expect([listening(el("p")), listening(el("i"))]).toEqual([1, 1]);
  });

  test("a signal: an aborted one adds nothing, aborting removes the listener, removing it drops the abort listener", () => {
    const r = createRef<Any>();
    render(h("div", null, h(Fragment, { ref: r }, h("p"))));
    const fi = r.current;
    const aborted = new AbortController();
    aborted.abort();
    fi.addEventListener("ping", () => {}, { signal: aborted.signal });
    expect(listening(el("p"))).toBe(0);
    const ac = new AbortController();
    fi.addEventListener("ping", () => {}, { signal: ac.signal, capture: true });
    expect(calls.at(-1)).toEqual(["add", "p", "ping", { capture: true, passive: undefined }]);
    expect(listening(el("p"))).toBe(1);
    ac.abort();
    expect(listening(el("p"))).toBe(0);
    // A signal-like object: its abort listener comes and goes with the fragment's listener.
    const abortListeners = new Set<Any>();
    const signal = {
      aborted: false,
      addEventListener: (_: string, fn: Any) => void abortListeners.add(fn),
      removeEventListener: (_: string, fn: Any) => void abortListeners.delete(fn),
    };
    const fn = () => {};
    fi.addEventListener("ping", fn, { signal });
    expect(abortListeners.size).toBe(1);
    fi.removeEventListener("ping", fn);
    expect(abortListeners.size).toBe(0);
  });

  test("dispatchEvent: on the parent, or on a temporary node that carries the fragment's listeners", () => {
    const r = createRef<Any>();
    render(h("main", null, h(Fragment, { ref: r }, h("p"))));
    const fi = r.current,
      main = el("main");
    const seen: string[] = [];
    main.addEventListener("ping", (e: Any) => void seen.push("main sees " + name(e.target)));
    // No listeners: a bubbling event is the parent's own; one that does not bubble goes nowhere.
    expect(fi.dispatchEvent(ev("ping"))).toBe(true);
    expect(fi.dispatchEvent(ev("ping", false))).toBe(true);
    expect(seen).toEqual(["main sees main"]);
    fi.addEventListener("ping", (e: Any) => {
      seen.push("fragment sees " + name(e.target));
      e.defaultPrevented = true;
    });
    expect(fi.dispatchEvent(ev("ping"))).toBe(false);
    expect(seen).toEqual(["main sees main", "fragment sees #", "main sees #"]);
    expect(main.childNodes.length).toBe(1);
    expect(listening(main.firstChild)).toBe(1);
  });

  test("dispatchEvent in a document uses a comment; an unmounted fragment dispatches nothing", () => {
    const d: Any = new FakeNode(9);
    d.createComment = (s: string) => new FakeComment(s);
    const r = createRef<Any>();
    const dr = createRoot(d);
    flushSync(() => dr.render(h(Fragment, { ref: r }, h("p"))));
    const fi = r.current;
    const seen: string[] = [];
    fi.addEventListener("ping", (e: Any) => void seen.push(name(e.target)));
    fi.dispatchEvent(ev("ping"));
    expect(seen).toEqual(["<!>"]);
    flushSync(() => dr.render(null));
    expect(fi.dispatchEvent(ev("ping"))).toBe(true);
    expect(seen).toEqual(["<!>"]);
  });
});

describe("focus and blur", () => {
  test("focus and focusLast search inside hosts for the first and the last element that takes focus", () => {
    const r = createRef<Any>();
    render(h("div", null, h(Fragment, { ref: r }, "x", h("p", null, h("span"), h("button")), h("a"), "y")));
    const fi = r.current;
    fi.focus({ preventScroll: true });
    expect(focusCalls).toEqual([
      ["p", { preventScroll: true }],
      ["span", { preventScroll: true }],
      ["button", { preventScroll: true }],
    ]);
    expect(name(doc.activeElement)).toBe("button");
    // An element already focused counts as focused, with no call.
    focusCalls = [];
    fi.focus();
    expect(focusCalls.map((c) => c[0])).toEqual(["p", "span"]);
    focusCalls = [];
    fi.focusLast();
    expect(focusCalls.map((c) => c[0])).toEqual(["a"]);
    expect(name(doc.activeElement)).toBe("a");
    expect(listening(doc, "focus")).toBe(0);
    // Nothing takes focus: every element is tried.
    focusCalls = [];
    render(h("div", null, h(Fragment, { ref: r }, h("p"))));
    r.current.focusLast();
    expect(focusCalls.map((c) => c[0])).toEqual(["p"]);
  });

  test("focus searches a compiled block's elements, its slots' nodes among them", () => {
    const T = __template(["div", 0, ["em", 0], ["button", 0, "go"], 0]);
    const r = createRef<Any>();
    render(h("section", null, h(Fragment, { ref: r }, __block(T, null, [h("input")]))));
    const fi = r.current;
    fi.focus();
    expect(focusCalls.map((c) => c[0])).toEqual(["div", "em", "button"]);
    focusCalls = [];
    fi.focusLast();
    expect(focusCalls.map((c) => c[0])).toEqual(["input"]);
    fi.addEventListener("ping", () => {});
    expect(listening(el("div", el("section")))).toBe(1);
  });

  test("blur blurs the focused element when it is in the fragment", () => {
    const r = createRef<Any>();
    render(h("div", null, h("input"), h(Fragment, { ref: r }, "t", h("p", null, h("button")))));
    const fi = r.current;
    fi.blur();
    doc.activeElement = el("input");
    fi.blur();
    expect(blurred).toEqual([]);
    doc.activeElement = el("button");
    fi.blur();
    expect(blurred).toEqual(["button"]);
    // A fragment in a document reads the document's own active element.
    const d: Any = new FakeNode(9);
    const dr = createRoot(d);
    flushSync(() => dr.render(h(Fragment, { ref: r }, h("p"))));
    d.activeElement = d.firstChild;
    r.current.blur();
    expect(blurred).toEqual(["button", "p"]);
    // Unmounted: nothing.
    flushSync(() => dr.render(null));
    r.current ?? fi.blur();
  });
});

describe("observers", () => {
  test("observeUsing observes the top-level elements, and the hosts that mount; unmounting unobserves", () => {
    const r = createRef<Any>();
    render(h("ul", null, h(Fragment, { ref: r }, h(List, {}), "t")));
    const fi = r.current;
    const ro = observer(false);
    fi.observeUsing(ro);
    expect(ro.log).toEqual(["observe li", "observe li"]);
    flushSync(() => setItems(["a", "b", "c"]));
    flushSync(() => setItems(["b", "c"]));
    expect(ro.log.slice(2)).toEqual(["observe li", "unobserve li"]);
    fi.unobserveUsing(ro);
    expect(ro.log.slice(4)).toEqual(["unobserve li", "unobserve li"]);
    fi.unobserveUsing(ro);
    fi.unobserveUsing(observer(false));
    expect(ro.log.length).toBe(6);
  });

  test("an IntersectionObserver unobserves a removed host after paint, unless it comes back first", async () => {
    const r = createRef<Any>();
    let set!: (v: "visible" | "hidden") => void;
    function Box() {
      const [mode, setMode] = useState<"visible" | "hidden">("visible");
      set = setMode;
      return h(Activity, { mode }, h("q"));
    }
    render(h("ul", null, h(Fragment, { ref: r }, h(List, {}), h(Box))));
    const fi = r.current;
    const io = observer(true);
    fi.observeUsing(io);
    io.log.length = 0;
    flushSync(() => setItems(["b"]));
    expect(io.log).toEqual([]);
    await nextTask(30);
    expect(io.log).toEqual(["unobserve li"]);
    // Hidden and shown again before paint: observed again, and its waiting unobserve dropped
    // (another node's stays).
    io.log.length = 0;
    flushSync(() => setItems([]));
    flushSync(() => set("hidden"));
    flushSync(() => set("visible"));
    await nextTask(30);
    expect(io.log).toEqual(["observe q", "unobserve li"]);
    flushSync(() => setItems(["b"]));
    // unobserveUsing runs the waiting unobserves at once.
    io.log.length = 0;
    flushSync(() => set("hidden"));
    fi.unobserveUsing(io);
    expect(io.log).toEqual(["unobserve li", "unobserve q"]);
    await nextTask(30);
    expect(io.log.length).toBe(2);
  });

  test("reactFragments: top-level nodes hold their instances; text only when the ref attaches", () => {
    const r = createRef<Any>();
    let set!: (v: boolean) => void;
    function Text() {
      const [on, setOn] = useState(false);
      set = setOn;
      return on ? "late" : null;
    }
    render(h("ul", null, h(Fragment, { ref: r }, h(List, {}), "t", h(Text))));
    const fi = r.current,
      ul = el("ul");
    expect([...ul.childNodes].map((n: Any) => n.reactFragments?.has(fi))).toEqual([true, true, true]);
    expect(el("b").reactFragments).toBe(undefined);
    const a = ul.firstChild;
    flushSync(() => setItems(["b", "c"]));
    flushSync(() => set(true));
    expect(a.reactFragments.size).toBe(0);
    expect([...ul.childNodes].map((n: Any) => n.reactFragments?.has(fi))).toEqual([true, true, true, undefined]);
  });
});

describe("geometry", () => {
  test("getClientRects lists the elements' rects and text ranges'; hoisted nodes are not the fragment's", () => {
    const r = createRef<Any>();
    render(h("div", null, h(Fragment, { ref: r }, h("title", null, "x"), h("p"), "txt", h("i"))));
    expect(r.current.getClientRects()).toEqual(["rect p", "range #txt", "rect i"]);
  });

  test("getRootNode asks the parent host; an unmounted fragment is its own root", () => {
    const r = createRef<Any>();
    render(h("div", null, h(Fragment, { ref: r }, h("p"))));
    const fi = r.current;
    expect(fi.getRootNode({ composed: true })).toBe(container);
    expect(rootNodeOptions).toEqual({ composed: true });
    render(null);
    expect(fi.getRootNode()).toBe(fi);
  });

  test("scrollIntoView scrolls the children from last to first, or first to last when alignToTop is false", () => {
    const r = createRef<Any>();
    render(h("div", null, h(Fragment, { ref: r }, h("p"), "txt", h("i"))));
    const fi = r.current;
    expect(() => fi.scrollIntoView({ block: "end" })).toThrow(
      "FragmentInstance.scrollIntoView() does not support scrollIntoViewOptions. Use the alignToTop boolean instead.",
    );
    fi.scrollIntoView();
    expect(scrolls).toEqual([
      ["i", undefined],
      ["window", 11, 22],
      ["p", undefined],
    ]);
    scrolls = [];
    fi.scrollIntoView(false);
    expect(scrolls).toEqual([
      ["p", false],
      ["window", 11, -77],
      ["i", false],
    ]);
  });

  test("an empty fragment scrolls a sibling (the next one first) or its parent", () => {
    const r = createRef<Any>();
    const Wrap = () => h("b");
    render(
      h(
        "div",
        null,
        h(Activity, { mode: "hidden" }, h("u")),
        h("title", null, "x"),
        h(Wrap),
        h(Fragment, { ref: r }),
        "tail",
        h("a"),
      ),
    );
    const fi = r.current;
    fi.scrollIntoView();
    fi.scrollIntoView(false);
    expect(scrolls).toEqual([
      ["window", 11, 22],
      ["b", false],
    ]);
    scrolls = [];
    render(h("div", null, h(Fragment, { ref: r })));
    const alone = r.current;
    alone.scrollIntoView();
    alone.scrollIntoView(false);
    expect(scrolls).toEqual([["div", undefined]]);
    // An unmounted one: nothing to scroll.
    render(null);
    alone.scrollIntoView();
    expect(scrolls.length).toBe(1);
    // One in hidden content finds no place among its parent's nodes: the last one comes before it.
    const tree = (mode: string) => h("div", null, h("b"), h(Activity, { mode }, h(Fragment, { ref: r })), h("a"));
    render(tree("visible"));
    const hidden = r.current;
    render(tree("hidden"));
    hidden.scrollIntoView(false);
    expect(scrolls.at(-1)).toEqual(["a", false]);
  });

  test("an empty fragment at the top of a document or a shadow root scrolls nothing, or the shadow host", () => {
    const r = createRef<Any>();
    const d: Any = new FakeNode(9);
    const dr = createRoot(d);
    flushSync(() => dr.render(h(Fragment, { ref: r })));
    r.current.scrollIntoView();
    const shadow: Any = new FakeFragment();
    shadow.host = new FakeElement("HOST");
    const sr = createRoot(shadow);
    flushSync(() => sr.render(h(Fragment, { ref: r })));
    r.current.scrollIntoView(true);
    const plain: Any = new FakeFragment();
    const pr = createRoot(plain);
    flushSync(() => pr.render(h(Fragment, { ref: r })));
    r.current.scrollIntoView();
    expect(scrolls).toEqual([["host", true]]);
  });
});

describe("compareDocumentPosition", () => {
  test("nodes inside, around and outside the fragment", () => {
    const r = createRef<Any>();
    render(h("div", null, h("b"), h(Fragment, { ref: r }, h("p", null, h("span")), "t", h("i")), h("a"), "z"));
    const fi = r.current,
      div = el("div");
    const t = el("p").nextSibling;
    expect(fi.compareDocumentPosition(el("span"))).toBe(16);
    expect(fi.compareDocumentPosition(el("p"))).toBe(16);
    expect(fi.compareDocumentPosition(t)).toBe(16);
    expect(fi.compareDocumentPosition(el("b"))).toBe(2);
    expect(fi.compareDocumentPosition(el("a"))).toBe(4);
    expect(fi.compareDocumentPosition(div.lastChild)).toBe(4);
    expect(fi.compareDocumentPosition(div)).toBe(10);
    // A node the fiber tree does not place there is implementation specific.
    const x = new FakeElement("X");
    div.insertBefore(x, t);
    expect(fi.compareDocumentPosition(x)).toBe(32);
    div.removeChild(x);
    // In another tree: disconnected.
    expect(fi.compareDocumentPosition(new FakeElement("Y"))).toBe(1 | 32 | 4);
    // Above the root: only the document, its element and its body are known to contain it.
    expect(fi.compareDocumentPosition(container)).toBe(32);
    doc.body = container;
    expect(fi.compareDocumentPosition(container)).toBe(10);
    // Unmounted: disconnected.
    render(null);
    expect(fi.compareDocumentPosition(div)).toBe(1);
  });

  test("portals: where the DOM and the fiber tree disagree, the position is implementation specific", () => {
    const top = new FakeElement("BODY");
    top.isDocument = true;
    const early = new FakeElement("EARLY"),
      late = new FakeElement("LATE"),
      other = new FakeElement("OTHER"),
      stray = new FakeElement("STRAY");
    top.appendChild(stray);
    top.appendChild(early);
    top.appendChild(container);
    top.appendChild(other);
    top.appendChild(late);
    const r = createRef<Any>();
    // Its first node sits outside its parent.
    render(h("div", null, h(Fragment, { ref: r }, portal(h("w"), early), h("p"))));
    expect(r.current.compareDocumentPosition(el("w", early))).toBe(32);
    render(h("div", null, portal(h("v"), late), h(Fragment, { ref: r }, h("p")), portal(h("q"), early)));
    const fi = r.current;
    // Before in the document, after in the tree; and the reverse.
    expect(fi.compareDocumentPosition(el("q", early))).toBe(32);
    expect(fi.compareDocumentPosition(el("v", late))).toBe(32);
    // Another root's node: no common ancestor. A node no root rendered: no fiber.
    const or = createRoot(other as unknown as Element);
    flushSync(() => or.render(h("s")));
    expect(fi.compareDocumentPosition(el("s", other))).toBe(32);
    expect(fi.compareDocumentPosition(stray)).toBe(32);
  });

  test("a fragment rendered in a portal compares from the portal's container", () => {
    const pc = new FakeElement("PC");
    container.appendChild(pc);
    const r = createRef<Any>(),
      e = createRef<Any>();
    render(h("div", null, portal([h(Fragment, { ref: r }, h("p")), h(Fragment, { ref: e })], pc)));
    expect(r.current.compareDocumentPosition(el("p", pc))).toBe(16);
    expect(e.current.compareDocumentPosition(pc)).toBe(8 | 32);
    // A container that is no element: the first node has no parent element.
    const frag = new FakeFragment();
    render(h("div", null, portal(h(Fragment, { ref: r }, h("p")), frag)));
    expect(r.current.compareDocumentPosition(el("p", frag))).toBe(1);
  });

  test("an empty fragment compares by its place among its parent's children", () => {
    const r = createRef<Any>();
    render(h("div", null, h("b"), h(Fragment, { ref: r }), h("a")));
    const fi = r.current;
    expect(fi.compareDocumentPosition(el("a"))).toBe(4 | 32);
    expect(fi.compareDocumentPosition(el("b"))).toBe(2 | 32);
    expect(fi.compareDocumentPosition(el("div"))).toBe(8 | 32);
    expect(fi.compareDocumentPosition(container)).toBe(10 | 32);
    render(h("div", null, h("b"), h(Fragment, { ref: r })));
    expect(r.current.compareDocumentPosition(el("b"))).toBe(2 | 32);
  });
});

describe("hidden content, portals and blocks", () => {
  test("hidden Activity content is not the fragment's; it loses the listeners when it hides and gets them back", () => {
    const r = createRef<Any>();
    const tree = (mode: string) => h("div", null, h(Fragment, { ref: r }, h("p"), h(Activity, { mode }, h("q"))));
    render(tree("visible"));
    const fi = r.current;
    fi.addEventListener("ping", () => {});
    expect(listening(el("q"))).toBe(1);
    render(tree("hidden"));
    expect(listening(el("q"))).toBe(0);
    expect(fi.getClientRects()).toEqual(["rect p"]);
    render(tree("visible"));
    expect(listening(el("q"))).toBe(1);
  });

  test("a fragment in hidden content attaches its ref when shown and detaches it when hidden", () => {
    const log: Any[] = [];
    const ref = (v: Any) => void log.push(v);
    const tree = (mode: string) => h(Activity, { mode }, h("div", null, h(Fragment, { ref }, h("p"))));
    render(tree("hidden"));
    expect(log).toEqual([]);
    render(tree("visible"));
    const fi = log[0];
    expect(typeof fi.getRootNode).toBe("function");
    // Hidden, its nodes are still its own.
    fi.addEventListener("ping", () => {});
    render(tree("hidden"));
    expect(log).toEqual([fi, null]);
    expect(listening(el("p"))).toBe(0);
    expect(fi.getClientRects()).toEqual(["rect p"]);
    render(tree("visible"));
    expect(log).toEqual([fi, null, fi]);
    expect(listening(el("p"))).toBe(1);
    render(null);
    expect(log).toEqual([fi, null, fi, null]);
  });

  test("a fragment whose instance is made while some of its hosts are hidden gives them listeners when they show", () => {
    const r = createRef<Any>();
    let show!: () => void;
    function Box() {
      const [mode, setMode] = useState("hidden");
      show = () => setMode("visible");
      return h(Activity, { mode }, h("q"));
    }
    render(h("div", null, h(Fragment, { ref: r }, h(Box))));
    r.current.addEventListener("ping", () => {});
    expect(listening(el("q"))).toBe(0);
    flushSync(show);
    expect(listening(el("q"))).toBe(1);
  });

  test("Suspense: content a fallback replaces is not the fragment's until it shows again", async () => {
    const r = createRef<Any>();
    let ready = false;
    let resolve!: () => void;
    const settled = new Promise<void>((res) => (resolve = res)).then(() => void (ready = true));
    let set!: (v: string) => void;
    function Data() {
      const [v, setV] = useState("a");
      set = setV;
      if (v === "b" && !ready) throw settled;
      return h("b", null, v);
    }
    const tree = (mode: string) =>
      h(Activity, { mode }, h("div", null, h(Fragment, { ref: r }, h(Suspense, { fallback: h("i") }, h(Data)))));
    render(tree("visible"));
    const fi = r.current;
    fi.addEventListener("ping", () => {});
    const b = el("b");
    expect(listening(b)).toBe(1);
    flushSync(() => set("b"));
    expect(listening(b)).toBe(0);
    expect(listening(el("i"))).toBe(1);
    expect(fi.getClientRects()).toEqual(["rect i"]);
    // An Activity around it hides and shows: what the fallback still hides stays without them.
    render(tree("hidden"));
    render(tree("visible"));
    expect(listening(b)).toBe(0);
    expect(listening(el("i"))).toBe(1);
    resolve();
    await settled;
    await until(() => el("i") === null);
    expect(listening(b)).toBe(1);
  });

  test("portals: their nodes are the fragment's, and so are hosts that mount in them later", () => {
    const pc = new FakeElement("PC");
    const r = createRef<Any>();
    let set!: (v: boolean) => void;
    function Late() {
      const [on, setOn] = useState(false);
      set = setOn;
      return on ? portal(h("v"), pc) : null;
    }
    render(h("ul", null, h(Fragment, { ref: r }, portal(h("ul", null, h(List, {})), pc), h(Late))));
    r.current.addEventListener("ping", () => {});
    flushSync(() => set(true));
    expect(listening(el("v", pc))).toBe(1);
    // The portal's <ul> is the fragment's; the rows inside it are not.
    expect(listening(el("ul", pc))).toBe(1);
    flushSync(() => setItems(["a", "b", "c"]));
    expect(listening(el("ul", pc).lastChild)).toBe(0);
  });

  test("a fragment in a portal: its parent is the host above the portal, and new rows get its listeners", () => {
    const pc = new FakeElement("PC");
    const r = createRef<Any>();
    render(h("main", null, portal(h(Fragment, { ref: r }, h(List, {})), pc)));
    const fi = r.current;
    fi.addEventListener("ping", () => {});
    flushSync(() => setItems(["a", "b", "c"]));
    expect(listening(pc.lastChild)).toBe(1);
    // The node that carries its listeners goes into <main>, not into the portal's container.
    const seen: string[] = [];
    el("main").addEventListener("pong", (e: Any) => void seen.push(name(e.target)));
    pc.addEventListener("pong", () => void seen.push("container"));
    fi.dispatchEvent(ev("pong"));
    expect(seen).toEqual(["#"]);
  });

  test("rows in a portal that clears them all at once lose the listeners", () => {
    const pc = new FakeElement("PC");
    const T = __template(["li", 0, 0]);
    function Row({ id }: { id: string }) {
      return __block(T, null, [id]);
    }
    const r = createRef<Any>();
    const tree = (ids: string[]) =>
      h(
        "div",
        null,
        h(
          Fragment,
          { ref: r },
          portal(
            ids.map((id) => h(Row, { key: id, id })),
            pc,
          ),
        ),
      );
    render(tree(["a", "b"]));
    r.current.addEventListener("ping", () => {});
    const rows = [...pc.childNodes];
    expect(rows.map((n: Any) => listening(n))).toEqual([1, 1]);
    render(tree([]));
    expect(rows.map((n: Any) => listening(n))).toEqual([0, 0]);
  });

  test("blocks: a block row and a component hosting one get the listeners, and lose them when they go", () => {
    const T = __template(["li", 0, 0]);
    const r = createRef<Any>();
    let set!: (v: number) => void;
    function Hosting() {
      const [n, setN] = useState(0);
      set = setN;
      return n === 0 ? null : n === 1 ? __block(T, null, ["hosted"]) : "text";
    }
    const tree = (rows: string[]) =>
      h(
        "ul",
        null,
        h(
          Fragment,
          { ref: r },
          rows.map((id) => __block(T, id, [id])),
          h(Hosting),
        ),
      );
    render(tree(["a"]));
    const fi = r.current;
    fi.addEventListener("ping", () => {});
    render(tree(["a", "b"]));
    const ul = el("ul");
    expect([...ul.childNodes].map((n: Any) => listening(n))).toEqual([1, 1]);
    // A component that starts hosting its block after it mounted.
    flushSync(() => set(1));
    const hosted = ul.lastChild;
    expect(listening(hosted)).toBe(1);
    flushSync(() => set(2));
    expect(listening(hosted)).toBe(0);
    expect(listening(ul.lastChild)).toBe(1);
    const b = ul.childNodes[1];
    render(tree(["a"]));
    expect(listening(b)).toBe(0);
  });

  test("a component hosting its block under a fragment ref gets the listeners when it mounts and unmounts", () => {
    const T = __template(["li", 0, 0]);
    function Row({ id }: { id: string }) {
      return __block(T, null, [id]);
    }
    const r = createRef<Any>();
    const tree = (ids: string[]) =>
      h(
        "ul",
        null,
        h(
          Fragment,
          { ref: r },
          ids.map((id) => h(Row, { key: id, id })),
          "t",
        ),
      );
    render(tree(["a"]));
    r.current.addEventListener("ping", () => {});
    render(tree(["a", "b"]));
    const b = el("ul").childNodes[1];
    expect(listening(b)).toBe(1);
    render(tree(["a"]));
    expect(listening(b)).toBe(0);
  });

  test("a fragment in a block's slot: its parent is the slot's element", () => {
    const T = __template(["nav", 0, ["em", 0], 0]);
    const r = createRef<Any>();
    render(__block(T, null, [h(Fragment, { ref: r }, h("p"))]));
    const seen: string[] = [];
    el("nav").addEventListener("ping", (e: Any) => void seen.push(name(e.target)));
    r.current.dispatchEvent(ev("ping"));
    expect(seen).toEqual(["nav"]);
  });
});
