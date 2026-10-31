// Fast Refresh on @reactre/compat's sources, which keep it (the production builds strip it): the
// renderer registers with react-refresh, here @vitejs/plugin-react's copy of its runtime, and an
// edit, made as a module that runs again makes it (each new version registered under its id, then
// the refresh the plugin's module footer asks for), renders again in place. What React does is
// the reference: state is kept, a component whose hooks changed and a class mount anew, and a root
// that failed renders again once the edit fixes it. packages/plugin/test/refresh.test.ts checks
// the same through Vite's dev server, in Chrome.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import {
  __block,
  __template,
  Component,
  createElement as h,
  createRoot,
  flushSync,
  forwardRef,
  memo,
  type Root,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "../src/index.ts";

// biome-ignore lint: react-refresh's runtime and the renderer it gets are untyped.
type Any = any;

// The DevTools hook react-refresh patches, with the renderer injected into it kept.
let renderer: Any = null;
const g = globalThis as Any;
g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  renderers: new Map(),
  supportsFiber: true,
  inject(injected: Any) {
    renderer = injected;
    return 1;
  },
  onCommitFiberRoot() {},
  onCommitFiberUnmount() {},
};
// The runtime registers a callback on `window` when it loads.
g.window ??= globalThis;
const Refresh: Any = await import(
  join(dirname(Bun.resolveSync("@vitejs/plugin-react", import.meta.dir)), "refresh-runtime.js")
);
Refresh.injectIntoGlobalHook(globalThis);

// The other test files run on without the hook, or a refresh handler.
afterAll(() => {
  renderer?.setRefreshHandler(null);
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
});

let container: FakeElement;
let root: Root;
const roots: Root[] = [];

beforeEach(() => {
  installFakeDocument();
  container = new FakeElement("div");
  for (const r of roots.splice(0)) r.unmount();
});

function mount(el: Any, options?: Any): Root {
  root = createRoot(container as Any, options);
  roots.push(root);
  flushSync(() => root.render(el));
  return root;
}

const text = (): string => container.textContent;
/** The first element under `n` with tag `tag`. */
function find(tag: string, n: Any = container): FakeElement | null {
  for (const c of n.childNodes) {
    if (c instanceof FakeElement && c.tagName.toLowerCase() === tag) return c;
    const r = find(tag, c);
    if (r !== null) return r;
  }
  return null;
}
/** The tags and texts under the container, in order. */
const shape = (n: Any = container): string =>
  [...n.childNodes]
    .map((c: Any) => (c instanceof FakeElement ? `<${c.tagName.toLowerCase()}>${shape(c)}` : c.textContent))
    .join("");

/** Each component's way to add to its count, by name, as its last render left it. */
const add: Record<string, (by: number) => void> = {};
/** Add `by` to the count of `name`, as an event would. */
const bump = (name: string, by = 1): void => flushSync(() => add[name]!(by));
/** A count kept in state, which `bump(name)` adds to. */
function useCount(name: string, initial = 0): number {
  const [n, set] = useState(initial);
  add[name] = (by) => set((x) => x + by);
  return n;
}

/** A hooks signature, as the transform gives each component that calls hooks. */
function sign<T>(type: T, key: string): T {
  Refresh.createSignatureFunctionForTransform()(type, key);
  return type;
}

/**
 * An edit: the module runs again and registers each new version under its id, then the refresh
 * the plugin's module footer enqueues runs (after its 16 ms debounce).
 */
async function edit(...versions: [Any, string][]): Promise<void> {
  for (const [type, id] of versions) Refresh.register(type, id);
  const exports = { Component: () => null };
  expect(Refresh.validateRefreshBoundaryAndEnqueueUpdate("module", exports, exports)).toBeUndefined();
  await Bun.sleep(40);
}

let ids = 0;
/** A fresh id, so each test's components are families of their own. */
const id = (name: string): string => `test${++ids} ${name}`;

test("the renderer registers with react-refresh at its first root", () => {
  mount(h("p", null, "x"));
  expect(renderer.rendererPackageName).toBe("react-dom");
  expect(typeof renderer.scheduleRefresh).toBe("function");
  expect(typeof renderer.setRefreshHandler).toBe("function");
  expect(typeof renderer.scheduleRoot).toBe("function");
});

test("an edit renders the component again with its new code, keeping its state", async () => {
  const name = id("Counter");
  const v1 = sign(function Counter() {
    return h("button", null, "before ", useCount("counter"));
  }, "useCount{}");
  Refresh.register(v1, name);
  mount(h(v1));
  bump("counter");
  bump("counter");
  expect(text()).toBe("before 2");
  const button = find("button");
  const v2 = sign(function Counter() {
    return h("button", null, "after ", useCount("counter"));
  }, "useCount{}");
  await edit([v2, name]);
  expect(text()).toBe("after 2");
  // The same element: the component rendered again in place.
  expect(find("button")).toBe(button);
  bump("counter", 10);
  expect(text()).toBe("after 12");
});

test("a component whose hooks changed mounts anew, its effects cleaned up", async () => {
  const name = id("Timer");
  const log: string[] = [];
  const v1 = sign(function Timer() {
    const n = useCount("timer", 5);
    useLayoutEffect(() => () => void log.push("layout cleanup"), []);
    useEffect(() => () => void log.push("passive cleanup"), []);
    return h("button", null, "v1 ", n);
  }, "useCount{}\nuseLayoutEffect{}\nuseEffect{}");
  Refresh.register(v1, name);
  mount(h("div", null, h(v1)));
  bump("timer");
  expect(text()).toBe("v1 6");
  const v2 = sign(function Timer() {
    return h("button", null, "v2 ", useCount("timer", 100));
  }, "useCount{}");
  await edit([v2, name]);
  expect(text()).toBe("v2 100");
  expect(log.sort()).toEqual(["layout cleanup", "passive cleanup"]);
});

test("a component that renders several children mounts anew in their place", async () => {
  const name = id("List");
  const v1 = sign(function List() {
    const [n] = useState(1);
    return [h("i", { key: "a" }, "a", n), h("b", { key: "b" }, "b")];
  }, "useState{a}");
  Refresh.register(v1, name);
  mount(h("div", null, h("span", null, "<"), h(v1), h("span", null, ">")));
  const v2 = sign(function List() {
    const [n] = useState(2);
    return [h("i", { key: "a" }, "A", n), "text", h("b", { key: "b" }, "B")];
  }, "useState{b}");
  await edit([v2, name]);
  expect(shape()).toBe("<div><span><<i>A2text<b>B<span>>");
});

test("effects and memos of an edited component run again, their deps ignored once", async () => {
  const name = id("Effects");
  const log: string[] = [];
  const version = (v: string) =>
    sign(function Effects() {
      const n = useCount("effects");
      const memoized = useMemo(() => v + " memo", []);
      useEffect(() => {
        log.push(v + " effect");
        return () => void log.push(v + " cleanup");
      }, []);
      return h("p", null, memoized, " ", n);
    }, "useCount{}\nuseMemo{memoized}\nuseEffect{}");
  const v1 = version("v1");
  Refresh.register(v1, name);
  mount(h(v1));
  bump("effects");
  expect(text()).toBe("v1 memo 1");
  await edit([version("v2"), name]);
  expect(text()).toBe("v2 memo 1");
  expect(log).toEqual(["v1 effect", "v1 cleanup", "v2 effect"]);
  // A render of its own after that keeps them, as their deps say.
  bump("effects");
  expect(text()).toBe("v2 memo 2");
  expect(log).toEqual(["v1 effect", "v1 cleanup", "v2 effect"]);
});

test("a parent edited with its children, in one module, keeps their state", async () => {
  const parent = id("Parent"),
    child = id("Child"),
    memoChild = id("MemoChild"),
    refChild = id("RefChild");
  const version = (v: string) => {
    const Child = sign(function Child() {
      return h("i", null, v, " plain ", useCount("plain"));
    }, "useCount{}");
    const inner = sign(function MemoChild() {
      return h("b", null, v, " memo ", useCount("memo"));
    }, "useCount{}");
    const MemoChild = memo(inner);
    const RefChild = forwardRef(function RefChild(_props: Any, ref: Any) {
      return h("em", { ref }, v);
    });
    function Parent() {
      return h("div", null, h(Child), h(MemoChild), h(RefChild));
    }
    return [
      [Parent, parent],
      [Child, child],
      [inner, memoChild + "$inner"],
      [MemoChild, memoChild],
      [RefChild, refChild],
    ] as [Any, string][];
  };
  const v1 = version("v1");
  for (const [type, name] of v1) Refresh.register(type, name);
  mount(h(v1[0]![0]));
  bump("plain");
  bump("memo", 2);
  expect(text()).toBe("v1 plain 1v1 memo 2v1");
  await edit(...version("v2"));
  expect(text()).toBe("v2 plain 1v2 memo 2v2");
});

test("a family whose new version wraps the function renders the function inside", async () => {
  const name = id("Wrapped");
  function Wrapped() {
    return h("p", null, "plain");
  }
  Refresh.register(Wrapped, name);
  mount(h(Wrapped));
  await edit([memo(() => h("p", null, "memo")), name]);
  expect(text()).toBe("memo");
  await edit([forwardRef(() => h("p", null, "forwardRef")), name]);
  expect(text()).toBe("forwardRef");
  // A version that is no function to render keeps the last one.
  await edit([{}, name]);
  expect(text()).toBe("forwardRef");
});

test("a class component mounts anew with its new class, its ref moved over", async () => {
  const name = id("Clock");
  const log: string[] = [];
  let instance: Any = null;
  const version = (v: string) =>
    class Clock extends Component<Any, { n: number }> {
      override state = { n: 0 };
      override componentWillUnmount() {
        log.push(v + " unmount");
      }
      override render() {
        return h("p", null, v, " ", this.state.n);
      }
    };
  const C1 = version("v1");
  Refresh.register(C1, name);
  mount(h("div", null, h(C1, { ref: (x: Any) => void (instance = x) })));
  flushSync(() => instance.setState({ n: 1 }));
  expect(text()).toBe("v1 1");
  expect(instance).toBeInstanceOf(C1);
  const C2 = version("v2");
  await edit([C2, name]);
  expect(text()).toBe("v2 0");
  expect(log).toEqual(["v1 unmount"]);
  expect(instance).toBeInstanceOf(C2);
});

test("a class whose componentWillUnmount throws as it mounts anew reports the error", async () => {
  const name = id("Thrower");
  const errors: unknown[] = [];
  const boom = new Error("unmount");
  class V1 extends Component {
    override componentWillUnmount() {
      throw boom;
    }
    override render() {
      return h("p", null, "v1");
    }
  }
  Refresh.register(V1, name);
  mount(h(V1), { onUncaughtError: (e: unknown) => void errors.push(e) });
  await edit([
    class V2 extends Component {
      override render() {
        return h("p", null, "v2");
      }
    },
    name,
  ]);
  expect(errors).toEqual([boom]);
});

test("a root that failed renders again once an edit fixes it", async () => {
  const name = id("Broken");
  const errors: unknown[] = [];
  function Fine() {
    return h("p", null, "fine");
  }
  Refresh.register(Fine, name);
  mount(h(Fine), { onUncaughtError: (e: unknown) => void errors.push(e) });
  await edit([
    function Broken(): Any {
      throw new Error("broken");
    },
    name,
  ]);
  expect(text()).toBe("");
  expect(errors.length).toBeGreaterThan(0);
  await edit([() => h("p", null, "fixed"), name]);
  expect(text()).toBe("fixed");
});

test("a root that unmounted is left alone", async () => {
  const name = id("Gone");
  let renders = 0;
  function Gone() {
    renders++;
    return h("p", null, "gone");
  }
  Refresh.register(Gone, name);
  mount(h(Gone)).unmount();
  await edit([
    function Gone() {
      renders++;
      return h("p", null, "again");
    },
    name,
  ]);
  expect(renders).toBe(1);
  // Its renderer does nothing for a dead root, whatever it is told.
  renderer.scheduleRoot({ r: root }, h("p", null, "x"));
  renderer.scheduleRefresh({ r: root }, { updatedFamilies: new Set(), staleFamilies: new Set() });
  expect(text()).toBe("");
});

test("while a refresh hook is present, a template description gives the same template", async () => {
  const desc = (): Any => ["p", { class: "row" }, "count: ", 0];
  const t1 = __template(desc());
  expect(__template(desc())).toBe(t1);
  expect(__template(["p", 0, "other: ", 0])).not.toBe(t1);

  // A component hosting its block keeps its DOM over an edit that leaves the markup as it was,
  // and gets a new one, keeping its state, when the edit changes it.
  const name = id("Row");
  const v1 = sign(function Row() {
    return __block(__template(desc()), null, [useCount("row")]);
  }, "useCount{}");
  Refresh.register(v1, name);
  mount(h("div", null, h(v1)));
  bump("row");
  const p = find("p");
  expect(text()).toBe("count: 1");
  await edit([
    sign(function Row() {
      return __block(__template(desc()), null, [useCount("row") + 10]);
    }, "useCount{}"),
    name,
  ]);
  expect(text()).toBe("count: 11");
  expect(find("p")).toBe(p);
  await edit([
    sign(function Row() {
      return __block(__template(["p", 0, "other: ", 0]), null, [useCount("row")]);
    }, "useCount{}"),
    name,
  ]);
  expect(text()).toBe("other: 1");
  expect(find("p")).not.toBe(p);
  // Hooks changed: it mounts anew, its block with it.
  await edit([
    sign(function Row() {
      return __block(__template(["p", 0, "other: ", 0]), null, [useCount("row", 7)]);
    }, "useCount{7}"),
    name,
  ]);
  expect(text()).toBe("other: 7");
  bump("row");
  expect(text()).toBe("other: 8");
});
