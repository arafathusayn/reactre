// Unit tests for @reactre/compat's roots, components and scheduler on the fake DOM.
//
// Covered here: createRoot and root.unmount, hydrateRoot, errors no boundary catches, portals,
// function components (forwardRef, render loops, a block they stop hosting), the core that
// class support plugs into, refs, context defaults, Suspense and Activity hiding content,
// unmounting each kind of fiber, the update queue's task and after-paint flushes, an error
// escaping a flush, and flushSync's siblings unstable_batchedUpdates and act.
//
// Class support is loaded, as classes.test.ts loads it, so classes mount here. A test that
// needs the module without it, or that leaves the module's scheduler unusable, runs on a
// separate instance of the module (see `isolated`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { FakeComment, FakeElement, FakeEvent, FakeNode, FakeText, installFakeDocument } from "@reactre/testdom";

import "../src/index.ts";
import {
  __block,
  __installClasses,
  __template,
  act,
  Activity,
  Component,
  createContext,
  createElement as h,
  createPortal,
  createRoot,
  flushSync,
  forwardRef,
  hydrateRoot,
  PureComponent,
  type Root,
  Suspense,
  unstable_batchedUpdates,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "../src/core.ts";

// #region Fixtures

let container: FakeElement;
let root: Root;

beforeEach(() => {
  installFakeDocument();
  // A container "in the document", so moves can keep state (moveBefore).
  container = new FakeElement("DIV");
  container.isDocument = true;
  root = createRoot(container as unknown as Element);
});

// The rendered markup, tags lowercased, without attributes.
const html = (n: FakeElement | null = container): string => {
  if (n === null) return "";
  let out = "";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof FakeElement) out += `<${c.tagName.toLowerCase()}>${html(c)}</${c.tagName.toLowerCase()}>`;
    else out += c.textContent;
  }
  return out;
};
const render = (el: unknown): void => flushSync(() => root.render(el));
// A task after the current one, past the one the update scheduler posts.
const nextTask = () => new Promise((r) => setTimeout(r, 10));
// Waits until `ok()` holds (a Suspense retry may wait out the 300 ms reveal throttle).
async function until(ok: () => boolean, ms = 1000): Promise<void> {
  for (const end = performance.now() + ms; !ok();) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Errors compat reports as uncaught go to reportError: recorded here, so a test can check them.
const g = globalThis as unknown as { reportError: unknown };
let reports: unknown[] = [];
let realReportError: unknown;
beforeEach(() => {
  reports = [];
  realReportError = g.reportError;
  g.reportError = (e: unknown) => void reports.push(e);
});
afterEach(() => {
  g.reportError = realReportError;
});

/**
 * A separate instance of the module (the query string makes one), for a test that needs module
 * state the shared instance cannot have (no class support), or that leaves it unusable.
 */
const isolated = (tag: string): Promise<typeof import("../src/core.ts")> => import(`../src/core.ts?${tag}`);

// What the fake DOM lacks and these tests need, added to FakeElement while this file runs:
// a style declaration (Suspense and Activity hide nodes with it), removeEventListener (an
// unmounted root stops listening) and localName (hydration compares it to the tag).
type FakeStyle = Record<string, string> & { priorities: Record<string, string> };
function fakeStyle(): FakeStyle {
  const s = { priorities: {} } as FakeStyle;
  Object.defineProperties(s, {
    setProperty: {
      value: (k: string, v: string, priority = "") => {
        s[k] = v;
        s.priorities[k] = priority;
      },
    },
    removeProperty: {
      value: (k: string) => {
        delete s[k];
        delete s.priorities[k];
      },
    },
  });
  return s;
}
const styles = new WeakMap<FakeElement, FakeStyle>();
const style = (el: unknown): FakeStyle => (el as { style: FakeStyle }).style;
// FakeElement keeps its listeners in a private map of type -> functions.
type Listening = { listeners: Map<string, unknown[]> | null };
const listenerCount = (el: FakeElement): number =>
  [...((el as unknown as Listening).listeners?.values() ?? [])].reduce((n, fns) => n + fns.length, 0);
const added = ["style", "removeEventListener", "localName"];
beforeAll(() => {
  Object.defineProperties(FakeElement.prototype, {
    style: {
      configurable: true,
      get(this: FakeElement) {
        let s = styles.get(this);
        if (s === undefined) styles.set(this, (s = fakeStyle()));
        return s;
      },
    },
    removeEventListener: {
      configurable: true,
      value(this: FakeElement, type: string, fn: unknown) {
        const map = (this as unknown as Listening).listeners;
        const fns = map?.get(type);
        if (fns !== undefined)
          map!.set(
            type,
            fns.filter((x) => x !== fn),
          );
      },
    },
    localName: {
      configurable: true,
      get(this: FakeElement) {
        return this.tagName.toLowerCase();
      },
    },
  });
});
afterAll(() => {
  for (const k of added) delete (FakeElement.prototype as unknown as Record<string, unknown>)[k];
});

// #endregion

describe("roots", () => {
  test("root.unmount removes what the root rendered and runs every cleanup before it returns", () => {
    const log: string[] = [];
    function App() {
      useLayoutEffect(() => () => void log.push("layout cleanup"), []);
      useEffect(() => () => void log.push("passive cleanup"), []);
      return h("p", null, "a");
    }
    render(h(App));
    root.unmount();
    expect(html()).toBe("");
    expect(log).toEqual(["layout cleanup", "passive cleanup"]);
  });

  test("an unmounted root stops listening, ignores a second unmount and refuses to render", () => {
    render(h("button", { onClick: () => {} }));
    expect(listenerCount(container)).toBeGreaterThan(0);
    root.unmount();
    expect(listenerCount(container)).toBe(0);
    root.unmount();
    expect(() => root.render(h("p"))).toThrow("Cannot update an unmounted root.");
  });
});

describe("hydrateRoot", () => {
  // Server HTML that matches the render: React would patch or replace mismatches (compat
  // patches them, see RootOptions), so these stay to what both do.
  test("adopts the server's nodes, and leaves comments it does not claim", () => {
    const p = new FakeElement("P");
    const text = new FakeText("same");
    p.appendChild(text);
    container.appendChild(p);
    container.appendChild(new FakeComment("a third party's"));
    hydrateRoot(container as unknown as Element, h("p", null, "same"));
    expect(container.childNodes.map((n) => n.nodeName)).toEqual(["P", "#comment"]);
    expect(container.firstChild).toBe(p);
    expect(p.firstChild).toBe(text);
  });

  test("hydrating a whole document claims its <html> and leaves its doctype", () => {
    const doc = new FakeElement("#document");
    Object.defineProperty(doc, "nodeType", { value: 9 });
    const doctype = new FakeNode(10);
    const htmlEl = new FakeElement("HTML");
    doc.appendChild(doctype);
    doc.appendChild(htmlEl);
    hydrateRoot(doc as unknown as Document, h("html", null));
    expect(doc.childNodes).toEqual([doctype, htmlEl]);
  });
});

describe("errors no boundary catches", () => {
  const boom = new Error("boom");
  function Bomb(): never {
    throw boom;
  }

  test("an error in render unmounts the whole tree and goes to onUncaughtError", () => {
    const seen: unknown[] = [];
    const r = createRoot(container as unknown as Element, {
      onUncaughtError: (e, info) => void seen.push(e, typeof info.componentStack),
    });
    flushSync(() => r.render(h("div", null, h("b", null, "ok"))));
    flushSync(() => r.render(h("div", null, h("b", null, "ok"), h(Bomb))));
    expect(html()).toBe("");
    expect(seen).toEqual([boom, "string"]);
    expect(reports).toEqual([]);
  });

  test("without onUncaughtError the error goes to reportError", () => {
    render(h("div", null, h(Bomb)));
    expect(html()).toBe("");
    expect(reports).toEqual([boom]);
  });

  test("an error thrown when a component renders again reaches the root", () => {
    let set!: (n: number) => void;
    function Flaky() {
      const [n, setN] = useState(0);
      set = setN;
      if (n > 0) throw boom;
      return h("i", null, n);
    }
    render(h("div", null, h("b", null, "sibling"), h(Flaky)));
    flushSync(() => set(1));
    expect(html()).toBe("");
    expect(reports).toEqual([boom]);
  });

  test("an error thrown by an effect unmounts the tree and is reported", () => {
    function Bad() {
      useLayoutEffect(() => {
        throw boom;
      }, []);
      return h("i", null, "x");
    }
    render(h("div", null, h(Bad)));
    expect(html()).toBe("");
    expect(reports).toEqual([boom]);
  });

  test("a DOM error while the root places its children unmounts the root and is reported", () => {
    const { el, r } = brittleRoot({ createRoot, createElement: h, flushSync, useState });
    el.broken = true;
    flushSync(() => r.render(h("p", null, "new")));
    expect(html(el)).toBe("");
    expect(reports).toEqual([new Error("DOM refused")]);
  });

  test("a promise thrown with no Suspense boundary above renders the root once it settles", async () => {
    let ready = false;
    let resolve!: () => void;
    const settled = new Promise<void>((r) => (resolve = r)).then(() => void (ready = true));
    function Data() {
      if (!ready) throw settled;
      return h("b", null, "ready");
    }
    render(h(Data));
    expect(html()).toBe("");
    resolve();
    await settled;
    await until(() => html() === "<b>ready</b>");
    expect(reports).toEqual([]);
  });
});

describe("portals", () => {
  let target: FakeElement;
  beforeEach(() => {
    target = new FakeElement("SECTION");
  });

  test("a portal renders its children into its own container and updates them there", () => {
    render(h("div", null, "a", createPortal(h("b", null, "in"), target as unknown as Element)));
    expect(html()).toBe("<div>a</div>");
    expect(html(target)).toBe("<b>in</b>");
    const b = target.firstChild;
    render(h("div", null, "a", createPortal(h("b", null, "in!"), target as unknown as Element)));
    expect(html(target)).toBe("<b>in!</b>");
    expect(target.firstChild).toBe(b);
  });

  test("an event inside a portal bubbles to handlers above it in the React tree", () => {
    const log: string[] = [];
    render(
      h(
        "div",
        { onClick: () => log.push("div") },
        createPortal(h("button", { onClick: () => log.push("button") }), target as unknown as Element),
      ),
    );
    (target.firstChild as FakeElement).dispatchEvent(new FakeEvent("click"));
    expect(log).toEqual(["button", "div"]);
  });

  test("a removed portal takes its nodes out of its container and leaves the container's own", () => {
    const own = new FakeElement("U");
    target.appendChild(own);
    render(h("div", null, createPortal(h("b", null, "in"), target as unknown as Element)));
    expect(html(target)).toBe("<u></u><b>in</b>");
    render(h("div", null));
    expect(target.childNodes).toEqual([own]);
  });

  test("root.unmount stops listening on its portals' containers too", () => {
    render(createPortal(h("button", { onClick: () => {} }), target as unknown as Element));
    expect(listenerCount(target)).toBeGreaterThan(0);
    root.unmount();
    expect(listenerCount(target)).toBe(0);
    expect(html(target)).toBe("");
  });
});

describe("function components", () => {
  test("forwardRef's render gets the ref as its second argument and props without it", () => {
    const seen: unknown[] = [];
    const Fancy = forwardRef((props: object, ref: unknown) => {
      seen.push({ ...props }, ref);
      return h("i");
    });
    const ref = { current: null };
    render(h(Fancy, { a: 1, ref }));
    render(h(Fancy, { a: 2 }));
    expect(seen).toEqual([{ a: 1 }, ref, { a: 2 }, null]);
  });

  test("a component that sets state on every render stops with React's error", () => {
    function Loop() {
      const [n, setN] = useState(0);
      setN(n + 1);
      return n;
    }
    render(h(Loop));
    expect((reports[0] as Error).message).toBe(
      "Too many re-renders. React limits the number of renders to prevent an infinite loop.",
    );
  });

  test("a component that hosted a block with rows renders text instead: the block and its rows go", () => {
    const UL = __template(["ul", 0, 0]);
    const log: string[] = [];
    function Item({ id }: { id: string }) {
      useEffect(() => () => void log.push("cleanup " + id), []);
      return h("li", null, id);
    }
    let set!: (v: boolean) => void;
    function List() {
      const [list, setList] = useState(true);
      set = setList;
      return list ? __block(UL, null, [[h(Item, { key: "a", id: "a" }), h(Item, { key: "b", id: "b" })]]) : "text";
    }
    render(h("div", null, h(List)));
    expect(html()).toBe("<div><ul><li>a</li><li>b</li></ul></div>");
    flushSync(() => set(false));
    expect(html()).toBe("<div>text</div>");
    expect(log).toEqual(["cleanup a", "cleanup b"]);
  });
});

describe("class components", () => {
  test("forceUpdate renders a class again even when shouldComponentUpdate says no", () => {
    let renders = 0;
    let inst!: Frozen;
    class Frozen extends Component {
      override shouldComponentUpdate() {
        return false;
      }
      override render() {
        inst = this;
        renders++;
        return h("i", null, renders);
      }
    }
    render(h(Frozen));
    render(h(Frozen));
    expect(renders).toBe(1);
    flushSync(() => inst.forceUpdate());
    expect(renders).toBe(2);
    expect(html()).toBe("<i>2</i>");
  });

  test("a PureComponent renders again only when its props change shallowly", () => {
    let renders = 0;
    class Pure extends PureComponent<{ v: number }> {
      override render() {
        renders++;
        return h("i", null, this.props.v);
      }
    }
    render(h(Pure, { v: 1 }));
    render(h(Pure, { v: 1 }));
    expect(renders).toBe(1);
    render(h(Pure, { v: 2 }));
    expect(renders).toBe(2);
    expect(html()).toBe("<i>2</i>");
  });

  test("a ref to a class instance is set on mount, and cleared or called with null on unmount", () => {
    class Widget extends Component {
      override render() {
        return h("i");
      }
    }
    const obj: { current: unknown } = { current: null };
    const calls: unknown[] = [];
    const cb = (v: unknown) => void calls.push(v instanceof Widget ? "instance" : v);
    render(h("div", null, h(Widget, { ref: obj }), h(Widget, { ref: cb })));
    expect(obj.current).toBeInstanceOf(Widget);
    render(h("div", null));
    expect(obj.current).toBe(null);
    expect(calls).toEqual(["instance", null]);
  });

  // React detaches a class's ref, then calls componentWillUnmount, each on its own
  // (commitDeletionEffectsOnFiber, case 1): one that throws leaves the other to run.
  test("a class's ref is detached before its componentWillUnmount runs, which may throw", () => {
    const log: string[] = [];
    class Widget extends Component {
      override componentWillUnmount() {
        log.push("will unmount");
        throw new Error("unmount");
      }
      override render() {
        return h("i");
      }
    }
    render(h(Widget, { ref: (v: unknown) => void log.push(v === null ? "ref null" : "ref") }));
    render(null);
    expect(log).toEqual(["ref", "ref null", "will unmount"]);
  });

  // React 19 keeps what a callback ref returns for any fiber (commitAttachRef stores refCleanup)
  // and calls it instead of ref(null).
  test("a callback ref's cleanup to a class instance runs instead of a call with null", () => {
    const log: string[] = [];
    class Widget extends Component {
      override render() {
        return h("i");
      }
    }
    const ref = (v: unknown) => {
      log.push(v === null ? "null" : "inst");
      return () => void log.push("cleanup");
    };
    render(h(Widget, { ref }));
    render(h(Widget, { ref: (v: unknown) => void log.push(v === null ? "null 2" : "inst 2") }));
    render(null);
    expect(log).toEqual(["inst", "cleanup", "inst 2", "null 2"]);
  });

  test("a second install of class support keeps the one already in use", () => {
    __installClasses(() => {
      throw new Error("not called");
    });
    class Still extends Component {
      override render() {
        return h("i", null, "class");
      }
    }
    render(h(Still));
    expect(html()).toBe("<i>class</i>");
  });

  test("in a build without class support, a class component fails with an error that names it", async () => {
    const bare = await isolated("without-classes");
    const seen: string[] = [];
    const r = bare.createRoot(container as unknown as Element, {
      onUncaughtError: (e) => void seen.push((e as Error).message),
    });
    class Named extends bare.Component {}
    class Shown extends bare.Component {
      static displayName = "Shown as";
    }
    bare.flushSync(() => r.render(bare.createElement(Named)));
    bare.flushSync(() => r.render(bare.createElement(Shown)));
    const why = " is a class component, and this build leaves class support out.";
    expect(seen).toEqual([
      "Named" + why + " Alias react to @reactre/compat, not @reactre/compat/core, to include it.",
      "Shown as" + why + " Alias react to @reactre/compat, not @reactre/compat/core, to include it.",
    ]);
  });
});

describe("refs", () => {
  test("a callback ref's returned cleanup runs on detach instead of a call with null", () => {
    const log: string[] = [];
    const ref = (el: unknown) => {
      log.push(el === null ? "null" : "attach");
      return () => void log.push("cleanup");
    };
    render(h("div", { ref }));
    render(null);
    expect(log).toEqual(["attach", "cleanup"]);
  });

  test("on detach a callback ref without a cleanup gets null, and an object ref is cleared", () => {
    const log: unknown[] = [];
    const cb = (el: unknown) => void log.push(el === null ? null : "el");
    const obj: { current: unknown } = { current: null };
    render(h("div", { ref: cb }, h("span", { ref: obj })));
    expect(obj.current).toBe((container.firstChild as FakeElement).firstChild);
    render(null);
    expect(log).toEqual(["el", null]);
    expect(obj.current).toBe(null);
  });
});

describe("context", () => {
  test("a reader with no provider above gets the context's default", () => {
    const Theme = createContext("light");
    const Reader = () => h("i", null, useContext(Theme));
    render(
      h(
        "div",
        null,
        h(Reader),
        h(Theme.Consumer, null, (v: string) => h("b", null, v)),
      ),
    );
    expect(html()).toBe("<div><i>light</i><b>light</b></div>");
  });
});

describe("suspense", () => {
  test("content that suspends on an update is hidden with its state while the fallback shows", async () => {
    let ready = false;
    let resolve!: () => void;
    const settled = new Promise<void>((r) => (resolve = r)).then(() => void (ready = true));
    let set!: (v: string) => void;
    function Data() {
      const [v, setV] = useState("a");
      set = setV;
      if (v === "b" && !ready) throw settled;
      return h("b", { style: { display: "inline" } }, v);
    }
    render(h(Suspense, { fallback: h("i", null, "wait") }, h(Data), "tail"));
    const b = container.firstChild as FakeElement;
    const tail = container.childNodes[1] as FakeText;
    flushSync(() => set("b"));
    // Elements get display: none !important; text is emptied; the fallback comes after them.
    expect(html()).toBe("<b>a</b><i>wait</i>");
    expect(style(b).display).toBe("none");
    expect(style(b).priorities["display"]).toBe("important");
    expect(tail.data).toBe("");
    resolve();
    await settled;
    await until(() => html() === "<b>b</b>tail");
    // The same nodes, shown again: the element's own display comes back from its style prop.
    expect(container.firstChild).toBe(b);
    expect(style(b).display).toBe("inline");
    expect(container.childNodes[1]).toBe(tail);
  });

  test("a fallback that suspends hands the suspension to the boundary above", () => {
    const never = new Promise<never>(() => {});
    function Wait(): never {
      throw never;
    }
    render(h(Suspense, { fallback: h("u", null, "outer") }, h(Suspense, { fallback: h(Wait) }, h(Wait))));
    expect(html()).toBe("<u>outer</u>");
  });

  test("a fallback takes new props while its boundary stays suspended", () => {
    const never = new Promise<never>(() => {});
    function Wait(): never {
      throw never;
    }
    render(h(Suspense, { fallback: h("i", null, "1") }, h(Wait)));
    const i = container.firstChild;
    render(h(Suspense, { fallback: h("i", null, "2") }, h(Wait)));
    expect(html()).toBe("<i>2</i>");
    expect(container.firstChild).toBe(i);
  });

  // React cleans up the layout effects and refs of shown content that suspends again, and runs
  // them again on reveal; its passive effects stay connected.
  test("shown content that suspends again has its layout effects cleaned up until it shows", async () => {
    const log: string[] = [];
    let ready = false;
    let resolve!: () => void;
    const settled = new Promise<void>((r) => (resolve = r)).then(() => void (ready = true));
    let set!: (v: string) => void;
    function Effects() {
      useLayoutEffect(() => {
        log.push("layout");
        return () => void log.push("layout cleanup");
      }, []);
      useEffect(() => {
        log.push("passive");
        return () => void log.push("passive cleanup");
      }, []);
      return h("i", { ref: (v: unknown) => void log.push(v === null ? "ref null" : "ref") });
    }
    function Data() {
      const [v, setV] = useState("a");
      set = setV;
      if (v === "b" && !ready) throw settled;
      return h("b", null, v);
    }
    render(h(Suspense, { fallback: "wait" }, h(Effects), h(Data)));
    expect(log.splice(0)).toEqual(["ref", "layout", "passive"]);
    flushSync(() => set("b"));
    expect(log.splice(0)).toEqual(["layout cleanup", "ref null"]);
    resolve();
    await settled;
    await until(() => html() === "<i></i><b>b</b>");
    expect(log.splice(0)).toEqual(["ref", "layout"]);
  });

  // While a boundary hides its content, a render of that content commits nothing: React runs
  // its layout effects when the content shows.
  test("content that renders while its boundary hides it runs its layout effects only when shown", async () => {
    const log: string[] = [];
    let resolve!: () => void;
    let ready = false;
    const settled = new Promise<void>((r) => (resolve = r)).then(() => void (ready = true));
    let set!: (v: number) => void;
    function Shown({ n }: { n: number }) {
      useLayoutEffect(() => {
        log.push("layout " + n);
        return () => void log.push("cleanup " + n);
      });
      return h("i", null, n);
    }
    function Data({ n }: { n: number }) {
      if (n > 0 && !ready) throw settled;
      return h("b", null, n);
    }
    function Parent() {
      const [n, setN] = useState(0);
      set = setN;
      return [h(Shown, { key: "s", n }), h(Data, { key: "d", n })];
    }
    render(h(Suspense, { fallback: "wait" }, h(Parent)));
    expect(log.splice(0)).toEqual(["layout 0"]);
    flushSync(() => set(1));
    expect(log.splice(0)).toEqual(["cleanup 0"]);
    flushSync(() => set(2));
    expect(log.splice(0)).toEqual([]);
    resolve();
    await settled;
    await until(() => html() === "<i>2</i><b>2</b>");
    expect(log.splice(0)).toEqual(["layout 2"]);
  });
});

describe("activity", () => {
  // Effects with [] deps: compat also runs an effect whose deps changed while hidden (see the
  // todos below), which React defers until the content shows.
  function Panel({ log }: { log: string[] }) {
    const [n, setN] = useState(0);
    useLayoutEffect(() => {
      log.push("layout");
      return () => void log.push("layout cleanup");
    }, []);
    useEffect(() => {
      log.push("passive");
      return () => void log.push("passive cleanup");
    }, []);
    return [h("b", { key: "b", style: { display: "block" }, onClick: () => setN(n + 1) }, n), "text"];
  }

  test("hidden content stays mounted with its state, its nodes hidden and its effects cleaned up", () => {
    const log: string[] = [];
    const view = (mode: string) => h(Activity, { mode }, h(Panel, { log }));
    render(view("visible"));
    const b = container.firstChild as FakeElement;
    const text = container.childNodes[1] as FakeText;
    b.dispatchEvent(new FakeEvent("click"));
    expect(log.splice(0)).toEqual(["layout", "passive"]);
    render(view("hidden"));
    expect(log.splice(0)).toEqual(["layout cleanup", "passive cleanup"]);
    expect(style(b).display).toBe("none");
    expect(text.data).toBe("");
    render(view("visible"));
    expect(log.splice(0)).toEqual(["layout", "passive"]);
    expect(style(b).display).toBe("block");
    expect(html()).toBe("<b>1</b>text");
    expect(container.firstChild).toBe(b);
  });

  test("shown again, its effects run children first, every layout effect before any passive one", () => {
    const log: string[] = [];
    function Outer({ children }: { children?: unknown }) {
      useLayoutEffect(() => void log.push("outer layout"), []);
      useEffect(() => void log.push("outer passive"), []);
      return children;
    }
    function Inner() {
      useLayoutEffect(() => void log.push("inner layout"), []);
      useEffect(() => void log.push("inner passive"), []);
      return h("i");
    }
    const view = (mode: string) => h(Activity, { mode }, h(Outer, null, h(Inner)));
    render(view("visible"));
    render(view("hidden"));
    log.length = 0;
    render(view("visible"));
    expect(log).toEqual(["inner layout", "outer layout", "inner passive", "outer passive"]);
  });

  // React does not mount the effects of content that starts hidden.
  test("an Activity that mounts hidden runs no effects until it is shown", () => {
    const log: string[] = [];
    const view = (mode: string) => h(Activity, { mode }, h(Panel, { log }));
    render(view("hidden"));
    expect(log.splice(0)).toEqual([]);
    render(view("visible"));
    expect(log.splice(0)).toEqual(["layout", "passive"]);
  });

  // React runs no effects in a hidden subtree; showing it runs each effect once, and its
  // cleanups follow.
  test("a hidden Activity's re-render runs no effects, and showing it runs each effect once", () => {
    const log: string[] = [];
    function Every({ n }: { n: number }) {
      useLayoutEffect(() => {
        log.push("layout " + n);
        return () => void log.push("layout cleanup " + n);
      });
      useEffect(() => {
        log.push("passive " + n);
        return () => void log.push("passive cleanup " + n);
      });
      return h("i", null, n);
    }
    const view = (mode: string, n: number) => h(Activity, { mode }, h(Every, { n }));
    render(view("visible", 1));
    render(view("hidden", 1));
    expect(log.splice(0)).toEqual(["layout 1", "passive 1", "layout cleanup 1", "passive cleanup 1"]);
    render(view("hidden", 2));
    expect(log.splice(0)).toEqual([]);
    render(view("visible", 3));
    expect(log.splice(0)).toEqual(["layout 3", "passive 3"]);
    render(view("visible", 4));
    expect(log.splice(0)).toEqual(["layout cleanup 3", "layout 4", "passive cleanup 3", "passive 4"]);
  });

  // React cleans up every layout effect of the hidden tree, then every passive one, both parent
  // first (disappearLayoutEffects, then disconnectPassiveEffect).
  test("hiding cleans up all layout effects before any passive effect", () => {
    const log: string[] = [];
    function Effects({ name, children }: { name: string; children?: unknown }) {
      useLayoutEffect(() => () => void log.push(name + " layout cleanup"), []);
      useEffect(() => () => void log.push(name + " passive cleanup"), []);
      return children ?? null;
    }
    const view = (mode: string) => h(Activity, { mode }, h(Effects, { name: "outer" }, h(Effects, { name: "inner" })));
    render(view("visible"));
    render(view("hidden"));
    expect(log).toEqual([
      "outer layout cleanup",
      "inner layout cleanup",
      "outer passive cleanup",
      "inner passive cleanup",
    ]);
  });

  // React detaches the refs and unmounts the classes of a hidden tree (componentWillUnmount),
  // and attaches and mounts them again when it shows; a hidden mount attaches nothing.
  test("hiding detaches refs and unmounts classes; showing attaches and mounts them again", () => {
    const log: string[] = [];
    class Cls extends Component {
      override componentDidMount() {
        log.push("did mount");
      }
      override componentWillUnmount() {
        log.push("will unmount");
      }
      override render() {
        return h("u", { ref: (v: unknown) => void log.push(v === null ? "u null" : "u ref") });
      }
    }
    const view = (mode: string) =>
      h(Activity, { mode }, h(Cls, { ref: (v: unknown) => void log.push(v === null ? "cls null" : "cls ref") }));
    render(view("hidden"));
    expect(log.splice(0)).toEqual([]);
    render(view("visible"));
    expect(log.splice(0)).toEqual(["u ref", "did mount", "cls ref"]);
    render(view("hidden"));
    expect(log.splice(0)).toEqual(["cls null", "will unmount", "u null"]);
  });

  // Removing a shown Activity runs its content's cleanups; removing a hidden one runs none again.
  test("a removed Activity takes its content, cleaned up once", () => {
    const log: string[] = [];
    render(h(Activity, { mode: "visible" }, h(Panel, { log })));
    render(null);
    expect(log.splice(0)).toEqual(["layout", "passive", "layout cleanup", "passive cleanup"]);
    render(h(Activity, { mode: "visible" }, h(Panel, { log })));
    render(h(Activity, { mode: "hidden" }, h(Panel, { log })));
    expect(log.splice(0)).toEqual(["layout", "passive", "layout cleanup", "passive cleanup"]);
    render(null);
    expect(log).toEqual([]);
    expect(html()).toBe("");
  });

  // A shown Activity inside a hidden one runs nothing until the outer one shows.
  test("an Activity shown inside a hidden one waits for the outer one", () => {
    const log: string[] = [];
    const view = (outer: string, inner: string) =>
      h(Activity, { mode: outer }, h(Activity, { mode: inner }, h(Panel, { log })));
    render(view("hidden", "hidden"));
    render(view("hidden", "visible"));
    expect(log.splice(0)).toEqual([]);
    render(view("visible", "visible"));
    expect(log.splice(0)).toEqual(["layout", "passive"]);
  });
});

describe("unmounting", () => {
  test("removing a subtree cleans up every kind of fiber below it and removes only its top node", () => {
    const log: string[] = [];
    const target = new FakeElement("SECTION");
    function Effects({ name }: { name: string }) {
      useLayoutEffect(() => () => void log.push(name + " layout"), []);
      useEffect(() => () => void log.push(name + " passive"), []);
      return h("i", null, name);
    }
    class Legacy extends Component {
      override componentWillUnmount() {
        log.push("class");
      }
      override render() {
        return h("u");
      }
    }
    const ref = { current: null as unknown };
    render(
      h(
        "div",
        null,
        h(
          "section",
          null,
          h("p", { ref }, h(Effects, { name: "inner" })),
          h(Legacy),
          createPortal(h(Effects, { name: "portal" }), target as unknown as Element),
        ),
        "kept",
      ),
    );
    expect(html(target)).toBe("<i>portal</i>");
    render(h("div", null, "kept"));
    expect(html()).toBe("<div>kept</div>");
    expect(html(target)).toBe("");
    expect(ref.current).toBe(null);
    expect(log).toEqual(["inner layout", "class", "portal layout", "inner passive", "portal passive"]);
  });

  test("a block and a component hosting one take their rows' cleanups with them", () => {
    const UL = __template(["ul", 0, 0]);
    const log: string[] = [];
    function Item({ id }: { id: string }) {
      useEffect(() => () => void log.push(id), []);
      return h("li", null, id);
    }
    const rows = (ids: string[]) => ids.map((id) => h(Item, { key: id, id }));
    function Hosting() {
      return __block(UL, null, [rows(["hosted"])]);
    }
    render([__block(UL, "plain", [rows(["plain"])]), h(Hosting, { key: "hosting" })]);
    expect(html()).toBe("<ul><li>plain</li></ul><ul><li>hosted</li></ul>");
    render(null);
    expect(html()).toBe("");
    expect(log).toEqual(["plain", "hosted"]);
  });
});

describe("scheduling", () => {
  test("an update's passive effects run after paint, and an update they make renders too", async () => {
    const log: string[] = [];
    let set!: (n: number) => void;
    function App() {
      const [n, setN] = useState(0);
      const [m, setM] = useState(0);
      set = setN;
      useEffect(() => {
        log.push("effect " + n);
        if (n === 1) setM(1);
      }, [n]);
      return h("b", null, n + ":" + m);
    }
    render(h(App));
    log.length = 0;
    set(1);
    await until(() => html() === "<b>1:1</b>");
    expect(log).toEqual(["effect 1"]);
  });

  test("an error placing nodes in a scheduled flush is reported as an uncaught error is", async () => {
    const { el, flip } = brittleRoot({ createRoot, createElement: h, flushSync, useState });
    el.broken = true;
    flip();
    await nextTask();
    expect(reports).toEqual([new Error("DOM refused")]);
  });

  // React's logUncaughtError: an error onUncaughtError throws is thrown again from a task.
  test("an error onUncaughtError throws is thrown from a task, and the root still unmounts", () => {
    const realSetTimeout = globalThis.setTimeout;
    const later: (() => void)[] = [];
    globalThis.setTimeout = ((fn: () => void) => (later.push(fn), 0)) as unknown as typeof setTimeout;
    try {
      const r = createRoot(container as unknown as Element, {
        onUncaughtError: () => {
          throw new Error("report failed");
        },
      });
      function Bomb(): never {
        throw new Error("boom");
      }
      flushSync(() => r.render(h("div", null, h(Bomb))));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(html()).toBe("");
    expect(later).toHaveLength(1);
    expect(later[0]!).toThrow("report failed");
  });

  test("without reportError, an uncaught error is thrown from a task of its own", async () => {
    const { el, flip } = brittleRoot({ createRoot, createElement: h, flushSync, useState });
    const realSetTimeout = globalThis.setTimeout;
    const later: (() => void)[] = [];
    g.reportError = undefined;
    globalThis.setTimeout = ((fn: () => void) => (later.push(fn), 0)) as unknown as typeof setTimeout;
    try {
      el.broken = true;
      flip();
      await Bun.sleep(10);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(later).toHaveLength(1);
    expect(later[0]!).toThrow("DOM refused");
  });

  // React captures a commit-phase error (captureCommitPhaseError): it goes to the boundary above,
  // or to the root, which unmounts and reports it; the other updates of that flush still render.
  test("an error placing nodes goes to the root, and the flush renders the other updates", () => {
    const { el, flip } = brittleRoot({ createRoot, createElement: h, flushSync, useState });
    let setB!: (n: number) => void;
    function B() {
      const [n, set] = useState(0);
      setB = set;
      return h("p", null, n);
    }
    render(h(B));
    el.broken = true;
    flushSync(() => {
      flip();
      setB(1);
    });
    expect(html()).toBe("<p>1</p>");
    expect(reports).toEqual([new Error("DOM refused")]);
    expect(el.firstChild).toBeNull();
    flushSync(() => setB(2));
    expect(html()).toBe("<p>2</p>");
  });
});

/**
 * A root (made with module instance `m`) whose container throws from insertBefore once `broken`
 * is set, showing a component that `flip` makes swap its element, so the root places the new one.
 */
function brittleRoot(
  m: Pick<typeof import("../src/core.ts"), "createRoot" | "createElement" | "flushSync" | "useState">,
) {
  class Brittle extends FakeElement {
    broken = false;
    override insertBefore(n: never, ref: never) {
      if (this.broken) throw new Error("DOM refused");
      return super.insertBefore(n, ref);
    }
  }
  const el = new Brittle("DIV");
  el.isDocument = true;
  const r = m.createRoot(el as unknown as Element);
  let set!: (v: boolean) => void;
  function Swap() {
    const [on, setOn] = m.useState(false);
    set = setOn;
    return m.createElement(on ? "i" : "b");
  }
  m.flushSync(() => r.render(m.createElement(Swap)));
  return { el, r, flip: () => set(true) };
}

describe("batching APIs", () => {
  test("unstable_batchedUpdates returns what its callback does and renders its updates together", async () => {
    let renders = 0;
    let set!: (f: (n: number) => number) => void;
    function App() {
      const [n, setN] = useState(0);
      set = setN;
      renders++;
      return h("b", null, n);
    }
    render(h(App));
    const out = unstable_batchedUpdates((a: number) => {
      set((n) => n + a);
      unstable_batchedUpdates(() => set((n) => n + a), 0);
      return "done";
    }, 2);
    expect(out).toBe("done");
    await nextTask();
    expect(html()).toBe("<b>4</b>");
    expect(renders).toBe(2);
  });

  // React 19's unstable_batchedUpdates is `fn(a)`: updates outside an event render in a later
  // task.
  test("unstable_batchedUpdates leaves its updates to the scheduler, as React's does", async () => {
    let set!: (n: number) => void;
    function App() {
      const [n, setN] = useState(0);
      set = setN;
      return h("b", null, n);
    }
    render(h(App));
    unstable_batchedUpdates(() => set(1), 0);
    expect(html()).toBe("<b>0</b>");
    await nextTask();
    expect(html()).toBe("<b>1</b>");
  });

  // React's flushSync flushes sync-lane work only (flushSyncWork): an update from a timer waits
  // for its own task, unless a sync update reaches the same component.
  test("flushSync leaves pending updates of other lanes to the scheduler", async () => {
    const sets: ((n: number) => void)[] = [];
    function Count({ tag }: { tag: string }) {
      const [n, set] = useState(0);
      sets.push(set);
      return h(tag, null, n);
    }
    render([h(Count, { key: "a", tag: "i" }), h(Count, { key: "b", tag: "b" })]);
    const [setA, setB] = sets;
    setA!(1);
    flushSync(() => setB!(1));
    expect(html()).toBe("<i>0</i><b>1</b>");
    await nextTask();
    expect(html()).toBe("<i>1</i><b>1</b>");
    setA!(2);
    flushSync(() => setA!(3));
    expect(html()).toBe("<i>3</i><b>1</b>");
  });

  test("act renders a callback's updates and runs their effects before it returns", () => {
    const log: string[] = [];
    function App() {
      useEffect(() => void log.push("effect"), []);
      return h("b", null, "acted");
    }
    const done = act(() => root.render(h(App)));
    expect(done).toBeInstanceOf(Promise);
    expect(html()).toBe("<b>acted</b>");
    expect(log).toEqual(["effect"]);
  });

  test("act awaits an async callback, then renders its updates and runs their effects", async () => {
    const log: string[] = [];
    let set!: (n: number) => void;
    function App() {
      const [n, setN] = useState(0);
      set = setN;
      useEffect(() => void log.push("effect " + n), [n]);
      return h("b", null, n);
    }
    render(h(App));
    await act(async () => {
      await Promise.resolve();
      set(1);
    });
    expect(html()).toBe("<b>1</b>");
    expect(log).toEqual(["effect 0", "effect 1"]);
  });
});
