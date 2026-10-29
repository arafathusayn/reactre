// Unit tests for @reactre/compat's fibers, child reconciliation, DOM placement, compiled blocks
// and hydration, on the fake DOM.
//
// Covered here: every element type a fiber can be made of (the wrapper types, consumers,
// forwardRef, lazy, memo of anything, invalid types), shallowEqual, children of every shape
// (nested arrays, iterables, portals, promises, objects), a swap with a changed middle, moves
// outside the document, a large fill of an empty host taken out of the document and when it is
// not, compiled blocks (static text, the element they stand for, style holes, a hole going from
// elements back to text, a throw in a hole) and hydration (claiming, splitting merged texts,
// mismatches, comments, a whole document, a block hydrated as its host element).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeNode, FakeText, HTML_NS, installFakeDocument, ops, resetOps } from "@reactre/testdom";

import {
  __block,
  __template,
  Activity,
  createContext,
  createElement as h,
  createPortal,
  createRoot,
  flushSync,
  forwardRef,
  Fragment,
  hydrateRoot,
  lazy,
  memo,
  Profiler,
  type Root,
  shallowEqual,
  StrictMode,
  Suspense,
  SuspenseList,
  useState,
  ViewTransition,
} from "../src/index.ts";

// #region Fixtures

let container: FakeElement;
let root: Root;
// What the root reported as uncaught (onUncaughtError), in order.
let uncaught: unknown[];

beforeEach(() => {
  installFakeDocument();
  // A container "in the document", so moves can keep state (moveBefore).
  container = new FakeElement("DIV");
  container.isDocument = true;
  uncaught = [];
  root = createRoot(container as unknown as Element, { onUncaughtError: (e) => void uncaught.push(e) });
});

// The rendered markup, tags lowercased, without attributes.
const html = (n: FakeNode | null = container): string => {
  if (n === null) return "";
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) out += `<${c.tagName.toLowerCase()}>${html(c)}</${c.tagName.toLowerCase()}>`;
    else out += c.textContent;
  }
  return out;
};
const render = (el: unknown): void => flushSync(() => root.render(el));
// A <ul> of keyed <li>s, one per key, each showing its key.
const items = (keys: string[]) => h("ul", null, ...keys.map((k) => h("li", { key: k }, k)));
// The children of the container's first element.
const kids = (): FakeNode[] => container.firstChild!.childNodes;

/**
 * Gives `proto` the properties in `props` (DOM features the fake DOM lacks) for the tests of the
 * enclosing describe block, and takes them off after each, so other files see the plain fake DOM.
 */
function extend(proto: object, props: Record<string, PropertyDescriptor>): void {
  beforeEach(() => {
    for (const k in props) Object.defineProperty(proto, k, { configurable: true, ...props[k] });
  });
  afterEach(() => {
    for (const k in props) delete (proto as Record<string, unknown>)[k];
  });
}

/**
 * A CSSStyleDeclaration over the element's style attribute, written as `name: value;` pairs:
 * enough for setStyle and Activity's display. Kept in the attribute, so a clone has it too.
 */
function styleOf(el: FakeElement): Record<string, unknown> {
  const read = () =>
    new Map(
      (el.getAttribute("style") ?? "")
        .split(";")
        .filter((s) => s.trim() !== "")
        .map((s) => [s.slice(0, s.indexOf(":")).trim(), s.slice(s.indexOf(":") + 1).trim()] as const),
    );
  const set = (k: string, v: string) => {
    const m = read();
    if (v === "") m.delete(k);
    else m.set(k, v);
    if (m.size) el.setAttribute("style", [...m].map(([a, b]) => `${a}: ${b};`).join(" "));
    else el.removeAttribute("style");
  };
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  return new Proxy({} as Record<string, unknown>, {
    get: (_, k) =>
      k === "setProperty"
        ? (n: string, v: string, prio?: string) => set(n, prio ? `${v} !${prio}` : v)
        : k === "removeProperty"
          ? (n: string) => set(n, "")
          : k === "cssText"
            ? (el.getAttribute("style") ?? "")
            : (read().get(kebab(String(k))) ?? ""),
    set: (_, k, v) => {
      if (k === "cssText") {
        if (v) el.setAttribute("style", String(v));
        else el.removeAttribute("style");
      } else set(kebab(String(k)), String(v));
      return true;
    },
  });
}
const withStyle = () =>
  extend(FakeElement.prototype, {
    style: {
      get: function (this: FakeElement) {
        return styleOf(this);
      },
    },
  });

// #endregion

describe("element types", () => {
  test("Fragment, StrictMode, Profiler, SuspenseList and ViewTransition render only their children", () => {
    const wrap = (n: string) =>
      h(
        "div",
        null,
        h(Fragment, null, "f", n),
        h(StrictMode, null, h("b", null, "s")),
        h(Profiler, { id: "p", onRender: () => {} }, "p"),
        h(SuspenseList, null, "l"),
        h(ViewTransition, null, "v"),
      );
    render(wrap("1"));
    expect(html()).toBe("<div>f1<b>s</b>plv</div>");
    const b = (container.firstChild as FakeElement).childNodes[2];
    render(wrap("2"));
    expect(html()).toBe("<div>f2<b>s</b>plv</div>");
    expect((container.firstChild as FakeElement).childNodes[2]).toBe(b!);
  });

  test("a context consumer renders its function child with the value, and again when it changes", () => {
    const Ctx = createContext("default");
    let set: (v: string) => void = () => {};
    function App() {
      const [v, setV] = useState("a");
      set = setV;
      return h(
        Ctx.Provider,
        { value: v },
        h(Ctx.Consumer, null, (x: string) => h("b", null, x)),
      );
    }
    render(
      h(
        "div",
        null,
        h(Ctx.Consumer, null, (x: string) => x),
        h(App),
      ),
    );
    expect(html()).toBe("<div>default<b>a</b></div>");
    flushSync(() => set("b"));
    expect(html()).toBe("<div>default<b>b</b></div>");
  });

  test("forwardRef gets the ref as its second argument and props without it, memoized or not", () => {
    const seen: unknown[] = [];
    const Input = forwardRef((props: { v: string }, ref: unknown) => {
      seen.push("ref" in props, ref);
      return h("input", { ref, value: props.v, readOnly: true });
    });
    const Memo = memo(Input);
    const a = { current: null as unknown };
    const b = { current: null as unknown };
    render(h("div", null, h(Input, { v: "x", ref: a }), h(Memo, { v: "y", ref: b })));
    expect(seen).toEqual([false, a, false, b]);
    expect(a.current).toBe((container.firstChild as FakeElement).childNodes[0]!);
    expect(b.current).toBe((container.firstChild as FakeElement).childNodes[1]!);
    // Equal props and the same ref: the memoized one is not called again.
    render(h("div", null, h(Input, { v: "x", ref: a }), h(Memo, { v: "y", ref: b })));
    expect(seen.length).toBe(6);
  });

  test("a lazy component whose load resolves synchronously renders at once", () => {
    function Loaded({ name }: { name: string }) {
      return h("b", null, name);
    }
    // A thenable that calls back at once, as a module already loaded can.
    const Lazy = lazy(
      () => ({ then: (ok: (m: { default: typeof Loaded }) => void) => ok({ default: Loaded }) }) as never,
    );
    render(h(Lazy, { name: "a" }));
    expect(html()).toBe("<b>a</b>");
    render(h(Lazy, { name: "b" }));
    expect(html()).toBe("<b>b</b>");
  });

  test("memo of a host element renders it, and skips it while the compare says the props are equal", () => {
    const B = memo("b" as never, (a: { n: number }, b: { n: number }) => a.n === b.n) as unknown as string;
    render(h(B, { n: 1, children: "one" }));
    expect(html()).toBe("<b>one</b>");
    render(h(B, { n: 1, children: "changed" }));
    expect(html()).toBe("<b>one</b>");
    render(h(B, { n: 2, children: "two" }));
    expect(html()).toBe("<b>two</b>");
    // Without a compare, props compare shallowly; a change updates the same element.
    const I = memo("i" as never) as unknown as string;
    render(h(I, { children: "x" }));
    const i = container.firstChild;
    render(h(I, { children: "y" }));
    expect(html()).toBe("<i>y</i>");
    expect(container.firstChild).toBe(i);
  });

  test("an invalid element type is an error naming what it got", () => {
    render(h("div", null, h(undefined as never)));
    render(h("div", null, h({} as never)));
    expect(uncaught.map((e) => (e as Error).message)).toEqual([
      expect.stringMatching(/^Element type is invalid: expected a string .*but got: undefined\./),
      expect.stringMatching(/^Element type is invalid: expected a string .*but got: object\./),
    ]);
    expect(html()).toBe("");
  });

  describe("Activity", () => {
    withStyle();
    test("a hidden Activity keeps its content and state, hidden with display: none", () => {
      let bump = () => {};
      function Count() {
        const [n, setN] = useState(0);
        bump = () => setN((x) => x + 1);
        return h("b", null, "n" + n);
      }
      const app = (mode: string) => h(Activity, { mode }, h(Count));
      render(app("visible"));
      flushSync(() => bump());
      const b = container.firstChild as FakeElement;
      render(app("hidden"));
      expect(b.getAttribute("style")).toBe("display: none !important;");
      render(app("visible"));
      expect(container.firstChild).toBe(b);
      expect(b.getAttribute("style")).toBe(null);
      expect(html()).toBe("<b>n1</b>");
    });
  });
});

describe("shallowEqual", () => {
  test("compares own keys with Object.is", () => {
    expect(shallowEqual({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    expect(shallowEqual({ a: NaN }, { a: NaN })).toBe(true);
    expect(shallowEqual({ a: 0 }, { a: -0 })).toBe(false);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    // A key set to undefined is not the same as a missing key.
    expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual(1, 1)).toBe(true);
  });

  test("a memo component re-renders exactly when its props change", () => {
    let renders = 0;
    const M = memo(function M(props: { a: number; b?: number }) {
      renders++;
      return h("b", null, "" + props.a);
    });
    render(h(M, { a: 1 }));
    render(h(M, { a: 1 }));
    expect(renders).toBe(1);
    render(h(M, { a: 1, b: undefined }));
    expect(renders).toBe(2);
    render(h(M, { a: 2, b: undefined }));
    expect(renders).toBe(3);
    expect(html()).toBe("<b>2</b>");
  });
});

describe("children of every shape", () => {
  test("nested arrays keep their nodes and reorder within themselves", () => {
    const list = (inner: string[]) =>
      h(
        "ul",
        null,
        h("li", { key: "first" }, "first"),
        inner.map((k) => h("li", { key: k }, k)),
        "end",
      );
    render(list(["a", "b", "c"]));
    const [, a, b, c] = kids();
    render(list(["c", "a", "b"]));
    expect(html()).toBe("<ul><li>first</li><li>c</li><li>a</li><li>b</li>end</ul>");
    expect(kids().slice(1, 4)).toEqual([c!, a!, b!]);
  });

  test("iterables render like arrays, nested or as the only child", () => {
    render(h("ul", null, new Set([h("li", { key: "a" }, "a"), h("li", { key: "b" }, "b")])));
    expect(html()).toBe("<ul><li>a</li><li>b</li></ul>");
    // An iterator (a Map's keys) is iterated once, like any iterable.
    render(h("p", null, "<", new Map([["x", 1]]).keys(), ">"));
    expect(html()).toBe("<p><x></p>");
    render(h("p", null, "<", new Set(["y", "z"]), ">"));
    expect(html()).toBe("<p><yz></p>");
  });

  test("a portal among children renders into its container and follows it when that changes", () => {
    const one = new FakeElement("SECTION");
    const two = new FakeElement("SECTION");
    const app = (to: FakeElement, text: string) =>
      h("div", null, h("i", null, "x"), createPortal(h("b", null, text), to as unknown as Element));
    render(app(one, "a"));
    expect(html()).toBe("<div><i>x</i></div>");
    expect(html(one)).toBe("<b>a</b>");
    const b = one.firstChild;
    render(app(one, "b"));
    expect(html(one)).toBe("<b>b</b>");
    expect(one.firstChild).toBe(b);
    render(app(two, "c"));
    expect(html(one)).toBe("");
    expect(html(two)).toBe("<b>c</b>");
  });

  test("a settled promise renders its value, wherever it sits in a list", () => {
    // React 19 reads a promise's result from the status fields it writes on it.
    const settled = <T>(v: T) => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
    // A thenable that calls back at once is read at once too.
    const now = <T>(v: T) => ({ then: (ok: (v: T) => void) => ok(v) });
    render(h("p", null, "a", settled("b")));
    expect(html()).toBe("<p>ab</p>");
    render(h("p", null, now("a"), settled("c")));
    expect(html()).toBe("<p>ac</p>");
    render(h("p", null, h("b", { key: "x" }, now("x")), h("i", { key: "y" }), settled("t")));
    expect(html()).toBe("<p><b>x</b><i></i>t</p>");
    render(h("p", null, h("i", { key: "y" }), h("b", { key: "x" }), now("u"), now("v")));
    expect(html()).toBe("<p><i></i><b></b>uv</p>");
  });

  test("a pending promise child suspends to the nearest boundary", () => {
    render(h(Suspense, { fallback: "loading" }, h("p", null, "a", new Promise(() => {}))));
    expect(html()).toBe("loading");
  });

  test("an object that is not an element is an error listing its keys", () => {
    render(h("p", null, h("i"), "b"));
    render(h("p", null, { x: 1, y: 2 }, "b"));
    expect((uncaught[0] as Error).message).toBe(
      "Objects are not valid as a React child (found: object with keys {x, y}). If you meant to render a collection of children, use an array instead.",
    );
  });
});

describe("placing nodes", () => {
  test("two rows that traded places around changed rows take two moves", () => {
    render(items(["a", "b", "c", "d", "e"]));
    const [a, b, c, d, e] = kids();
    resetOps();
    render(items(["a", "d", "c", "b", "e"]));
    expect(html()).toBe("<ul><li>a</li><li>d</li><li>c</li><li>b</li><li>e</li></ul>");
    expect(kids()).toEqual([a!, d!, c!, b!, e!]);
    expect(ops.moves).toBe(2);
    expect(ops.inserts).toBe(0);
  });

  test("a child that a duplicate key hid from the key map goes when its host is placed", () => {
    // React warns that duplicate keys are unsupported, and leaves such a child's node in the
    // DOM. Here the host's placement pass removes it, as a node of its own nothing renders.
    const List = ({ items }: { items: unknown[] }) => items;
    const Null = () => null;
    render(
      h(
        "div",
        null,
        h(List, { items: [h("b", { key: "a" }, "a"), h("i", { key: "k" }, "1"), h("i", { key: "k" }, "2")] }),
      ),
    );
    expect(html()).toBe("<div><b>a</b><i>1</i><i>2</i></div>");
    render(h("div", null, h(List, { items: [h("b", { key: "a" }, "a"), h(Null, { key: "n" })] })));
    expect(html()).toBe("<div><b>a</b></div>");
  });

  test("outside the document, nodes move with insertBefore", () => {
    container.isDocument = false;
    render(items(["a", "b", "c", "d"]));
    const [a, b, c, d] = kids();
    resetOps();
    render(items(["d", "a", "c", "b"]));
    expect(kids()).toEqual([d!, a!, c!, b!]);
    expect(ops.moves).toBeGreaterThan(0);
    expect(ops.stateMoves).toBe(0);
  });
});

describe("filling an empty host", () => {
  // What detach() reads: the DOM's contains, firstElementChild and a querySelector for tag lists.
  extend(FakeNode.prototype, {
    contains: {
      value(this: FakeNode, n: FakeNode | null) {
        for (; n !== null; n = n.parentNode) if (n === this) return true;
        return false;
      },
    },
    firstElementChild: {
      get(this: FakeNode) {
        let c = this.firstChild;
        while (c !== null && c.nodeType !== 1) c = c.nextSibling;
        return c;
      },
    },
    querySelector: {
      value(this: FakeNode, sel: string) {
        const tags = sel.toUpperCase().split(",");
        const find = (n: FakeNode): FakeNode | null => {
          for (let c = n.firstChild; c !== null; c = c.nextSibling) {
            if (c instanceof FakeElement && tags.includes(c.tagName)) return c;
            const x = find(c);
            if (x !== null) return x;
          }
          return null;
        };
        return find(this);
      },
    },
  });
  const rows = Array.from({ length: 100 }, (_, i) => "r" + i);
  const page = (keys: string[]) => h("div", null, h("p", null, "<"), items(keys), h("p", null, ">"));
  // Records whether the list was in the document at each insertion into it.
  const watch = (ul: FakeElement): boolean[] => {
    const seen: boolean[] = [];
    const insert = ul.insertBefore.bind(ul);
    ul.insertBefore = (n: FakeNode, ref: FakeNode | null) => (seen.push(ul.isConnected), insert(n, ref));
    return seen;
  };

  test("a big fill takes the host out of the document and puts it back where it was", () => {
    render(page([]));
    const ul = container.firstChild!.childNodes[1] as FakeElement;
    const seen = watch(ul);
    render(page(rows));
    expect(container.firstChild!.childNodes[1]).toBe(ul);
    expect(ul.childNodes.map((n) => n.textContent)).toEqual(rows);
    expect(seen.length).toBe(100);
    expect(seen.every((x) => !x)).toBe(true);
    expect(html()).toMatch(/^<div><p><<\/p><ul><li>r0<\/li>.*<li>r99<\/li><\/ul><p>><\/p><\/div>$/);
  });

  test("a host holding focus stays in the document", () => {
    render(page([]));
    const ul = container.firstChild!.childNodes[1] as FakeElement;
    ul.ownerDocument = { ...ul.ownerDocument, activeElement: ul };
    const seen = watch(ul);
    render(page(rows));
    expect(seen.every((x) => x)).toBe(true);
    expect(ul.childNodes.length).toBe(100);
  });

  test("a host holding an iframe or media stays in the document", () => {
    render(page([]));
    const ul = container.firstChild!.childNodes[1] as FakeElement;
    // A library's node: not React's, so the host still counts as empty.
    const frame = new FakeElement("IFRAME");
    ul.appendChild(frame);
    const seen = watch(ul);
    render(page(rows));
    expect(seen.every((x) => x)).toBe(true);
    expect(ul.firstChild).toBe(frame);
    expect(ul.childNodes.length).toBe(101);
  });

  test("the root's container is never taken out", () => {
    const body = new FakeElement("BODY");
    body.isDocument = true;
    body.appendChild(container);
    render(rows.map((k) => h("i", { key: k })));
    expect(container.parentNode).toBe(body);
    expect(container.childNodes.length).toBe(100);
  });
});

describe("compiled blocks", () => {
  const GREET = __template(["p", 0, "Hello, ", 0, "!"]);

  test("static text in a template is cloned with it, around the holes", () => {
    render(__block(GREET, null, ["Ann"]));
    expect(html()).toBe("<p>Hello, Ann!</p>");
    const p = container.firstChild;
    render(__block(GREET, null, ["Bob"]));
    expect(html()).toBe("<p>Hello, Bob!</p>");
    expect(container.firstChild).toBe(p);
  });

  test("a block element reads as the element its JSX would make", () => {
    const el = __block(GREET, 7, ["Ann"]);
    expect(el.type).toBe("p");
    expect(el.key).toBe("7");
    expect(el.ref).toBe(null);
    expect(el.props).toEqual({ children: ["Hello, ", "Ann", "!"] });
    expect(JSON.stringify(el)).toBe(JSON.stringify(h("p", { key: 7 }, "Hello, ", "Ann", "!")));
  });

  describe("style holes", () => {
    withStyle();
    test("each block mounts with its own style; a property one set does not reach the next", () => {
      const BOX = __template(["div", { style: { h: 0 } }, 1]);
      render(
        h(
          "section",
          null,
          __block(BOX, "a", [{ color: "red", width: 10 }, "a"]),
          __block(BOX, "b", [{ color: "blue" }, "b"]),
          __block(BOX, "c", [null, "c"]),
        ),
      );
      const [a, b, c] = kids() as FakeElement[];
      expect(a!.getAttribute("style")).toBe("color: red; width: 10px;");
      expect(b!.getAttribute("style")).toBe("color: blue;");
      expect(c!.getAttribute("style")).toBe(null);
    });
  });

  test("a hole that goes from elements to text drops them, and its anchor comes back", () => {
    const LIST = __template(["ul", 0, 0]);
    const lis = (keys: string[]) => keys.map((k) => h("li", { key: k }, k));
    render(__block(LIST, null, [lis(["a", "b"])]));
    expect(html()).toBe("<ul><li>a</li><li>b</li></ul>");
    render(__block(LIST, null, ["none"]));
    expect(html()).toBe("<ul>none</ul>");
    render(__block(LIST, null, [lis(["c"])]));
    expect(html()).toBe("<ul><li>c</li></ul>");
    render(__block(LIST, null, [null]));
    expect(html()).toBe("<ul></ul>");

    // A hole between static text keeps its anchor in place throughout.
    const WRAP = __template(["p", 0, "<", 0, ">"]);
    render(__block(WRAP, null, [h("b", null, "x")]));
    expect(html()).toBe("<p><<b>x</b>></p>");
    render(__block(WRAP, null, [false]));
    expect(html()).toBe("<p><></p>");
    render(__block(WRAP, null, [1]));
    expect(html()).toBe("<p><1></p>");
  });

  test("a component that throws in a hole is reported and the root unmounts", () => {
    const LIST = __template(["ul", 0, 0]);
    function Boom(): never {
      throw new Error("boom");
    }
    render(__block(LIST, null, [h("li", null, "ok")]));
    render(__block(LIST, null, [h(Boom)]));
    expect(uncaught.map((e) => (e as Error).message)).toEqual(["boom"]);
    expect(html()).toBe("");
  });
});

describe("hydration", () => {
  // What claiming reads and does: an element's localName (lower case in HTML, as written in
  // SVG) and a text's splitText.
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
  // Hydrates the container's server HTML with `el`: the first render runs before this returns.
  const hydrate = (el: unknown): Root =>
    hydrateRoot(container as unknown as Element, el, { onUncaughtError: (e) => void uncaught.push(e) });

  test("matching elements and texts are claimed; comments between texts stay", () => {
    container.innerHTML = '<p class="x">a<!-- -->b</p>';
    const p = container.firstChild as FakeElement;
    const nodes = p.childNodes;
    hydrate(h("p", { className: "x" }, "a", "b"));
    expect(container.firstChild).toBe(p);
    expect(p.childNodes).toEqual(nodes);
    expect(nodes.map((n) => n.nodeType)).toEqual([3, 8, 3]);
  });

  test("claimed nodes are the server's own, kept rather than recreated", () => {
    container.innerHTML = "<div><span>x</span><i>y</i></div>";
    const div = container.firstChild as FakeElement;
    const [span, i] = div.childNodes;
    hydrate(h("div", null, h("span", null, "x"), h("i", null, "y")));
    expect(container.firstChild).toBe(div);
    expect(div.childNodes).toEqual([span!, i!]);
  });

  test("texts the server merged into one node are split between them", () => {
    container.innerHTML = "<p>helloworld</p>";
    const text = container.firstChild!.firstChild as FakeText;
    hydrate(h("p", null, "hello", "world"));
    expect(container.firstChild!.firstChild).toBe(text);
    expect(container.firstChild!.childNodes.map((n) => (n as FakeText).data)).toEqual(["hello", "world"]);
  });

  test("a text that differs is patched; a node that does not match is replaced", () => {
    container.innerHTML = "<p>server<i>2</i></p><span>extra</span>";
    const p = container.firstChild as FakeElement;
    const [text, i] = p.childNodes;
    hydrate(h("p", null, "client", h("b", null, "1"), h("i", null, "2"), "tail"));
    expect(html()).toBe("<p>client<b>1</b><i>2</i>tail</p>");
    expect(container.firstChild).toBe(p);
    expect(p.firstChild).toBe(text!);
    // The <i> the <b> did not match is still claimed by the <i> after it.
    expect(p.childNodes[2]).toBe(i!);
  });

  test("a text where the server has an element is created, and the element still claimed", () => {
    container.innerHTML = "<p><b>x</b></p>";
    const b = container.firstChild!.firstChild;
    hydrate(h("p", null, "t", h("b", null, "x")));
    expect(html()).toBe("<p>t<b>x</b></p>");
    expect(container.firstChild!.childNodes[1]).toBe(b!);
  });

  test("SVG tags are matched with their case", () => {
    container.innerHTML = "<svg><linearGradient></linearGradient></svg>";
    const g = container.firstChild!.firstChild;
    hydrate(h("svg", null, h("linearGradient")));
    expect(container.firstChild!.firstChild).toBe(g!);
  });

  test("a whole document skips its doctype and keeps nodes nothing claimed", () => {
    const doc = new FakeElement("#document");
    Object.defineProperty(doc, "nodeType", { value: 9 });
    doc.isDocument = true;
    const doctype = new FakeNode(10);
    doc.appendChild(doctype);
    const htmlEl = new FakeElement("HTML");
    htmlEl.innerHTML = "<body><p>hi</p></body>";
    doc.appendChild(htmlEl);
    // Added by a browser extension: not the server's, not to be removed.
    const extra = new FakeElement("ASIDE");
    doc.appendChild(extra);
    hydrateRoot(doc as unknown as Document, h("html", null, h("body", null, h("p", null, "hi"))));
    expect(doc.childNodes).toEqual([doctype, htmlEl, extra]);
    expect(html(htmlEl)).toBe("<body><p>hi</p></body>");
  });

  test("a compiled block hydrates as the host element it describes, and updates it later", () => {
    const T = __template(["p", { className: { h: 0 } }, "Hi ", ["b", 0, 1]]);
    container.innerHTML = '<p class="a">Hi <b>Ann</b></p>';
    const r = hydrate(__block(T, null, ["a", "Ann"]));
    const p = container.firstChild as FakeElement;
    const [hi, b] = p.childNodes;
    expect(html()).toBe("<p>Hi <b>Ann</b></p>");
    flushSync(() => r.render(__block(T, null, ["z", "Bob"])));
    expect(html()).toBe("<p>Hi <b>Bob</b></p>");
    expect(container.firstChild).toBe(p);
    expect(p.childNodes).toEqual([hi!, b!]);
    expect(p.getAttribute("class")).toBe("z");
  });
});
