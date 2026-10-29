// Unit tests for @reactre/compat's hooks on the fake DOM: effects (insertion, layout and passive,
// deps, cleanups), the core hooks (state, reducer, ref, memo, callback, context, imperative
// handle, id, external stores, effect events, the compiler's memo cache), use() with contexts and
// thenables, transitions and actions (startTransition, useTransition, useDeferredValue,
// useOptimistic, useActionState), form actions with useFormStatus and requestFormReset, and the
// server-only stubs.
//
// Each test asserts what React 19 does. Updates made outside an event render in a task of their
// own, so tests that make them wait for `nextTask`; updates in a discrete event's listener (a
// form's submit) render in a microtask.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, FakeEvent, installFakeDocument } from "@reactre/testdom";

import {
  __COMPILER_RUNTIME,
  c,
  cache,
  cacheSignal,
  captureOwnerStack,
  createContext,
  createElement as h,
  createRoot,
  flushSync,
  type FormStatus,
  requestFormReset,
  type Root,
  startTransition,
  unstable_useCacheRefresh,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useFormState,
  useFormStatus,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useMemoCache,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useSyncExternalStoreWithSelector,
  useTransition,
} from "../src/index.ts";

// #region Fixtures

let container: FakeElement;
let root: Root;
// What reached the root's onUncaughtError: errors no boundary caught.
let uncaught: unknown[];
// What reached the global reportError (stubbed, so a test sees it instead of the runner).
let reported: unknown[];
const realReportError = globalThis.reportError;

beforeEach(() => {
  installFakeDocument();
  // A container "in the document", so moves can keep state (moveBefore).
  container = new FakeElement("DIV");
  container.isDocument = true;
  uncaught = [];
  root = createRoot(container as unknown as Element, { onUncaughtError: (e) => void uncaught.push(e) });
  reported = [];
  globalThis.reportError = (e: unknown) => void reported.push(e);
});
afterEach(() => {
  globalThis.reportError = realReportError;
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
/** A promise with its resolve and reject, to settle from the test. */
function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

// #endregion

describe("effects", () => {
  test("insertion effects run as each component commits, children first, before any layout effect", () => {
    const log: string[] = [];
    function Child({ n }: { n: number }) {
      useInsertionEffect(() => {
        log.push("child insertion " + n);
        return () => log.push("child insertion cleanup " + n);
      });
      useLayoutEffect(() => void log.push("child layout " + n));
      return null;
    }
    function Parent({ n }: { n: number }) {
      useInsertionEffect(() => void log.push("parent insertion " + n));
      useLayoutEffect(() => void log.push("parent layout " + n));
      return h(Child, { n });
    }
    render(h(Parent, { n: 1 }));
    expect(log.splice(0)).toEqual(["child insertion 1", "parent insertion 1", "child layout 1", "parent layout 1"]);
    render(h(Parent, { n: 2 }));
    expect(log.splice(0)).toEqual([
      "child insertion cleanup 1",
      "child insertion 2",
      "parent insertion 2",
      "child layout 2",
      "parent layout 2",
    ]);
    render(null);
    expect(log).toEqual(["child insertion cleanup 2"]);
  });

  test("an effect without deps runs after every render, [] once, and deps when one changes by Object.is", () => {
    const log: string[] = [];
    function App({ a }: { a: number }) {
      useEffect(() => void log.push("every"));
      useEffect(() => void log.push("once"), []);
      useEffect(() => void log.push("a " + Object.is(a, -0) + " " + a), [a]);
      return null;
    }
    render(h(App, { a: NaN }));
    expect(log.splice(0)).toEqual(["every", "once", "a false NaN"]);
    // NaN equals NaN by Object.is.
    render(h(App, { a: NaN }));
    expect(log.splice(0)).toEqual(["every"]);
    render(h(App, { a: 0 }));
    expect(log.splice(0)).toEqual(["every", "a false 0"]);
    // 0 and -0 differ by Object.is.
    render(h(App, { a: -0 }));
    expect(log.splice(0)).toEqual(["every", "a true 0"]);
  });

  test("a passive cleanup that throws after its component is removed is reported as uncaught", () => {
    const boom = new Error("cleanup");
    function Leaf() {
      useEffect(
        () => () => {
          throw boom;
        },
        [],
      );
      return null;
    }
    // A root without onUncaughtError: React's default for it is reportError.
    const plain = createRoot(new FakeElement("DIV") as unknown as Element);
    flushSync(() => plain.render(h("div", null, h(Leaf))));
    flushSync(() => plain.render(h("div", null)));
    expect(reported).toEqual([boom]);
  });
});

describe("hooks outside a component", () => {
  test("throw an invalid hook call error", () => {
    expect(() => useState(0)).toThrow("Invalid hook call");
    expect(() => useContext(createContext(0))).toThrow("Invalid hook call");
    expect(() => use(createContext(0))).toThrow("Invalid hook call");
  });
});

describe("useState and useReducer", () => {
  test("useReducer passes initArg through init once, and dispatch runs the reducer", () => {
    let inits = 0;
    let dispatch!: (a: number) => void;
    function App() {
      const [n, d] = useReducer(
        (s: number, a: number) => s + a,
        5,
        (x: number) => (inits++, x * 10),
      );
      dispatch = d;
      return h("p", null, n);
    }
    render(h(App));
    expect(html()).toBe("<p>50</p>");
    flushSync(() => dispatch(2));
    expect(html()).toBe("<p>52</p>");
    expect(inits).toBe(1);
  });

  test("dispatch is stable and uses the reducer of the latest render", () => {
    const seen: unknown[] = [];
    function App({ step }: { step: number }) {
      const [n, d] = useReducer((s: number, a: number) => s + a * step, 0);
      seen.push(d);
      return h("p", null, h("b", { onClick: () => d(1) }), n);
    }
    render(h(App, { step: 1 }));
    render(h(App, { step: 10 }));
    flushSync(() => (seen[1] as (a: number) => void)(1));
    expect(html()).toBe("<p><b></b>10</p>");
    expect(seen[0]).toBe(seen[1]);
  });

  test("a setter that leaves the state the same by Object.is renders nothing", () => {
    let renders = 0;
    let set!: (v: number) => void;
    function App() {
      const [n, s] = useState(NaN);
      set = s;
      renders++;
      return h("p", null, n);
    }
    render(h(App));
    flushSync(() => set(NaN));
    expect(renders).toBe(1);
    flushSync(() => set(1));
    expect(renders).toBe(2);
  });

  test("a setter called after its component unmounted does nothing", () => {
    let set!: (v: number) => void;
    let renders = 0;
    function App() {
      const [n, s] = useState(0);
      set = s;
      renders++;
      return h("p", null, n);
    }
    render(h(App));
    render(null);
    flushSync(() => set(1));
    expect(renders).toBe(1);
    expect(html()).toBe("");
  });

  test("state set during a component's own render re-runs it before its children render", () => {
    const childSaw: number[] = [];
    function Child({ changes }: { changes: number }) {
      childSaw.push(changes);
      return h("i", null, changes);
    }
    // The "previous props in state" pattern React documents.
    function App({ n }: { n: number }) {
      const [prev, setPrev] = useState(n);
      const [changes, setChanges] = useState(0);
      if (prev !== n) {
        setPrev(n);
        setChanges((c) => c + 1);
      }
      return h(Child, { changes });
    }
    render(h(App, { n: 1 }));
    render(h(App, { n: 2 }));
    expect(html()).toBe("<i>1</i>");
    expect(childSaw).toEqual([0, 1]);
  });
});

describe("useRef, useMemo and useCallback", () => {
  test("useRef returns the same object on every render, starting at its initial value", () => {
    const refs: { current: unknown }[] = [];
    function App({ n }: { n: number }) {
      refs.push(useRef<number>(n));
      refs.push(useRef());
      return null;
    }
    render(h(App, { n: 1 }));
    render(h(App, { n: 2 }));
    expect(refs[0]).toBe(refs[2]!);
    expect(refs[0]!.current).toBe(1);
    expect(refs[1]).toBe(refs[3]!);
    expect(refs[1]!.current).toBe(undefined);
  });

  test("useMemo recomputes when a dep changes, and on every render without deps", () => {
    const log: string[] = [];
    function App({ a, b }: { a: number; b: number }) {
      const x = useMemo(() => (log.push("deps " + a), { a }), [a]);
      useMemo(() => void log.push("no deps"), undefined);
      return h("p", null, x.a + b);
    }
    render(h(App, { a: 1, b: 0 }));
    render(h(App, { a: 1, b: 1 }));
    render(h(App, { a: 2, b: 1 }));
    expect(log).toEqual(["deps 1", "no deps", "no deps", "deps 2", "no deps"]);
    expect(html()).toBe("<p>3</p>");
  });

  test("useCallback keeps its function until a dep changes, and replaces it every render without deps", () => {
    const kept: unknown[] = [];
    const fresh: unknown[] = [];
    function App({ a }: { a: number }) {
      kept.push(useCallback(() => a, [a]));
      fresh.push(useCallback(() => a));
      return null;
    }
    render(h(App, { a: 1 }));
    render(h(App, { a: 1 }));
    render(h(App, { a: 2 }));
    expect(kept[0]).toBe(kept[1]);
    expect(kept[2]).not.toBe(kept[1]);
    expect((kept[2] as () => number)()).toBe(2);
    expect(new Set(fresh).size).toBe(3);
  });
});

describe("useDebugValue", () => {
  test("does nothing and takes no hook slot, so calling it conditionally keeps state in place", () => {
    let format = 0;
    function App({ debug }: { debug: boolean }) {
      if (debug) useDebugValue("label", () => format++);
      const [n] = useState(7);
      return h("p", null, n);
    }
    render(h(App, { debug: false }));
    render(h(App, { debug: true }));
    expect(html()).toBe("<p>7</p>");
    expect(format).toBe(0);
  });
});

describe("useImperativeHandle", () => {
  type Handle = { n: number };

  test("an object ref gets the handle, a new one when a dep changes, and null on unmount", () => {
    const ref: { current: Handle | null } = { current: null };
    let creates = 0;
    function Input({ handleRef, n }: { handleRef: typeof ref; n: number }) {
      useImperativeHandle(handleRef, () => (creates++, { n }), [n]);
      return null;
    }
    render(h(Input, { handleRef: ref, n: 1 }));
    const first = ref.current;
    expect(first).toEqual({ n: 1 });
    render(h(Input, { handleRef: ref, n: 1 }));
    expect(ref.current).toBe(first);
    render(h(Input, { handleRef: ref, n: 2 }));
    expect(ref.current).toEqual({ n: 2 });
    expect(creates).toBe(2);
    render(null);
    expect(ref.current).toBe(null);
  });

  test("a callback ref gets the handle and then null, or runs the cleanup it returned", () => {
    const log: string[] = [];
    function Input({ handleRef }: { handleRef: (h: Handle | null) => unknown }) {
      useImperativeHandle(handleRef, () => ({ n: 1 }), []);
      return null;
    }
    const plain = (x: Handle | null) => void log.push("plain " + JSON.stringify(x));
    render(h(Input, { handleRef: plain }));
    render(null);
    expect(log.splice(0)).toEqual(['plain {"n":1}', "plain null"]);
    // React 19: a ref callback that returns a function is cleaned up by it, not called with null.
    const withCleanup = (x: Handle | null) => {
      log.push("set " + JSON.stringify(x));
      return () => log.push("cleanup");
    };
    render(h(Input, { handleRef: withCleanup }));
    render(null);
    expect(log).toEqual(['set {"n":1}', "cleanup"]);
  });

  test("a new ref with the same deps moves the handle, and a null ref gets nothing", () => {
    const a: { current: Handle | null } = { current: null };
    const b: { current: Handle | null } = { current: null };
    function Input({ handleRef }: { handleRef: typeof a | null }) {
      useImperativeHandle(handleRef, () => ({ n: 1 }), []);
      return null;
    }
    render(h(Input, { handleRef: a }));
    render(h(Input, { handleRef: b }));
    expect(a.current).toBe(null);
    expect(b.current).toEqual({ n: 1 });
    render(h(Input, { handleRef: null }));
    expect(b.current).toBe(null);
  });
});

describe("useId", () => {
  test("ids are stable for a component's life, unique, and in React 19's format", () => {
    const ids: string[] = [];
    function Field() {
      ids.push(useId());
      return null;
    }
    render(h("div", null, h(Field), h(Field)));
    render(h("div", null, h(Field), h(Field)));
    expect(ids[0]).toMatch(/^_r_[0-9a-v]+_$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.slice(2)).toEqual(ids.slice(0, 2));
  });

  test("the root's identifierPrefix goes after the first underscore", () => {
    let id = "";
    function Field() {
      id = useId();
      return null;
    }
    const other = createRoot(new FakeElement("DIV") as unknown as Element, { identifierPrefix: "app-" });
    flushSync(() => other.render(h(Field)));
    expect(id).toMatch(/^_app-r_[0-9a-v]+_$/);
  });
});

describe("useSyncExternalStore", () => {
  /** A minimal store: a value, its listeners, and a setter that notifies them. */
  function store<T>(v: T) {
    const subs = new Set<() => void>();
    return {
      subs,
      get: () => v,
      set(n: T) {
        v = n;
        for (const s of subs) s();
      },
      subscribe(cb: () => void) {
        subs.add(cb);
        return () => void subs.delete(cb);
      },
    };
  }

  test("renders the snapshot, again when it changes, not on a notification without a change", async () => {
    const s = store(1);
    let renders = 0;
    function App() {
      renders++;
      return h("p", null, useSyncExternalStore(s.subscribe, s.get));
    }
    render(h(App));
    expect(html()).toBe("<p>1</p>");
    s.set(2);
    await nextTask();
    expect(html()).toBe("<p>2</p>");
    s.set(2);
    await nextTask();
    expect(renders).toBe(2);
    render(null);
    expect(s.subs.size).toBe(0);
  });

  test("a change between the render and the subscription is not missed", async () => {
    const s = store("render");
    function App() {
      const v = useSyncExternalStore(s.subscribe, s.get);
      // Layout effects run before the passive effect that subscribes.
      useLayoutEffect(() => {
        if (v === "render") s.set("layout");
      }, [v]);
      return h("p", null, v);
    }
    render(h(App));
    await nextTask();
    expect(html()).toBe("<p>layout</p>");
  });

  test("a getSnapshot that throws after a change re-renders, and the error reaches the root", async () => {
    const s = store(1);
    const boom = new Error("snapshot");
    let broken = false;
    const get = () => {
      if (broken) throw boom;
      return s.get();
    };
    function App() {
      return h("p", null, useSyncExternalStore(s.subscribe, get));
    }
    render(h(App));
    broken = true;
    s.set(2);
    await nextTask();
    expect(uncaught).toEqual([boom]);
  });

  test("a new subscribe resubscribes; a new getSnapshot alone does not", () => {
    const s = store(1);
    let subscribes = 0;
    const sub1 = (cb: () => void) => (subscribes++, s.subscribe(cb));
    const sub2 = (cb: () => void) => (subscribes++, s.subscribe(cb));
    function App({ sub, k }: { sub: typeof sub1; k: number }) {
      return h(
        "p",
        null,
        useSyncExternalStore(sub, () => s.get() + k),
      );
    }
    render(h(App, { sub: sub1, k: 0 }));
    render(h(App, { sub: sub1, k: 10 }));
    expect(html()).toBe("<p>11</p>");
    expect(subscribes).toBe(1);
    render(h(App, { sub: sub2, k: 10 }));
    expect(subscribes).toBe(2);
    expect(s.subs.size).toBe(1);
  });

  test("with a selector, the selection is kept for the same snapshot, and while isEqual holds", async () => {
    const s = store({ a: 1, b: 1 });
    const selections: unknown[] = [];
    let selects = 0;
    const selector = (x: { a: number; b: number }) => (selects++, { a: x.a });
    const isEqual = (p: { a: number }, q: { a: number }) => p.a === q.a;
    function App() {
      const sel = useSyncExternalStoreWithSelector(s.subscribe, s.get, null, selector, isEqual);
      selections.push(sel);
      return h("p", null, sel.a);
    }
    render(h(App));
    const runs = selects;
    render(h(App));
    // The same snapshot: the selector does not run again.
    expect(selects).toBe(runs);
    // A new snapshot with an equal selection: the old selection is kept, and nothing renders.
    s.set({ a: 1, b: 2 });
    await nextTask();
    expect(selections.length).toBe(2);
    expect(selections[1]).toBe(selections[0]);
    s.set({ a: 2, b: 2 });
    await nextTask();
    expect(html()).toBe("<p>2</p>");
    expect(selections.at(-1)).toEqual({ a: 2 });
  });
});

describe("useEffectEvent", () => {
  test("the function from any render calls the latest render's callback", () => {
    const fns: unknown[] = [];
    const log: string[] = [];
    function App({ label }: { label: string }) {
      const onTick = useEffectEvent((n: number) => log.push(label + " " + n));
      fns.push(onTick);
      useEffect(() => void onTick(1), [label.length]);
      return null;
    }
    render(h(App, { label: "a" }));
    render(h(App, { label: "b" }));
    (fns[0] as (n: number) => void)(2);
    expect(log).toEqual(["a 1", "b 2"]);
  });
});

describe("the compiler's memo cache", () => {
  test("c(size) is one array per component, filled with React's sentinel until compiled code fills it", () => {
    const caches: unknown[][] = [];
    const sentinel = Symbol.for("react.memo_cache_sentinel");
    function App({ n }: { n: number }) {
      const $ = c(2);
      caches.push($);
      if ($[0] !== n) {
        $[0] = n;
        $[1] = h("p", null, n);
      }
      return $[1];
    }
    render(h(App, { n: 1 }));
    expect(caches[0]).toEqual([1, expect.anything()]);
    render(h(App, { n: 1 }));
    expect(caches[1]).toBe(caches[0]!);
    expect(html()).toBe("<p>1</p>");

    let fresh: unknown[] = [];
    function Peek() {
      fresh = useMemoCache(3);
      return null;
    }
    render(h(Peek));
    expect(fresh).toEqual([sentinel, sentinel, sentinel]);
    expect(__COMPILER_RUNTIME.c).toBe(c);
  });
});

describe("use", () => {
  test("reads a context, and may be called conditionally", () => {
    const Ctx = createContext("default");
    function App({ read }: { read: boolean }) {
      if (!read) return h("p", null, "skipped");
      return h("p", null, use(Ctx));
    }
    render(h(Ctx, { value: "provided" }, h(App, { read: false })));
    render(h(Ctx, { value: "provided" }, h(App, { read: true })));
    expect(html()).toBe("<p>provided</p>");
  });

  test("a settled promise React tracked reads synchronously: its value, or its reason thrown", () => {
    const ok = Object.assign(Promise.resolve("x"), { status: "fulfilled", value: "done" });
    function App({ p }: { p: PromiseLike<string> }) {
      return h("p", null, use(p));
    }
    render(h(App, { p: ok }));
    expect(html()).toBe("<p>done</p>");
    const boom = new Error("rejected");
    const bad = Object.assign(new Promise<string>(() => {}), { status: "rejected", reason: boom });
    render(h(App, { p: bad }));
    expect(uncaught).toEqual([boom]);
  });

  test("a pending promise suspends until it settles, and its result is recorded on it", async () => {
    const d = deferred<string>();
    function App() {
      return h("p", null, use(d.promise));
    }
    render(h(App));
    expect(html()).toBe("");
    expect((d.promise as unknown as { status: string }).status).toBe("pending");
    d.resolve("late");
    await d.promise;
    // A retry can wait out Suspense's reveal throttle (300 ms) when a fallback showed recently.
    for (let i = 0; i < 40 && html() === ""; i++) await nextTask();
    expect(html()).toBe("<p>late</p>");
    expect(d.promise).toMatchObject({ status: "fulfilled", value: "late" });
  });

  test("a thenable that settles synchronously in then() is read at once", () => {
    const boom = new Error("sync reject");
    const yes = { then: (res: (v: string) => void) => res("now") };
    const no = { then: (_: unknown, rej: (e: unknown) => void) => rej(boom) };
    function App({ t }: { t: PromiseLike<string> }) {
      return h("p", null, use(t));
    }
    render(h(App, { t: yes }));
    expect(html()).toBe("<p>now</p>");
    render(h(App, { t: no }));
    expect(uncaught).toEqual([boom]);
  });
});

describe("startTransition and useTransition", () => {
  test("startTransition renders the updates it makes", async () => {
    let set!: (v: number) => void;
    function App() {
      const [n, s] = useState(0);
      set = s;
      return h("p", null, n);
    }
    render(h(App));
    startTransition(() => set(1));
    await nextTask();
    expect(html()).toBe("<p>1</p>");
  });

  test("an async transition that rejects is reported", async () => {
    const boom = new Error("transition");
    startTransition(() => Promise.reject(boom));
    await nextTask();
    expect(reported).toEqual([boom]);
  });

  test("isPending is true while an async transition runs, and false once it settles", async () => {
    let start!: (fn: () => unknown) => void;
    const seen: boolean[] = [];
    function App() {
      const [pending, s] = useTransition();
      start = s;
      seen.push(pending);
      return h("p", null, pending ? "pending" : "idle");
    }
    render(h(App));
    const d = deferred();
    flushSync(() => start(() => d.promise));
    expect(html()).toBe("<p>pending</p>");
    d.resolve();
    await nextTask();
    expect(html()).toBe("<p>idle</p>");
    // A synchronous transition is over when it returns.
    flushSync(() => start(() => {}));
    expect(html()).toBe("<p>idle</p>");
    expect(seen.at(-1)).toBe(false);
  });

  test("an async transition that rejects throws to the component's boundary", async () => {
    let start!: (fn: () => unknown) => void;
    function App() {
      start = useTransition()[1];
      return h("p", null, "app");
    }
    render(h(App));
    const boom = new Error("async");
    flushSync(() => start(() => Promise.reject(boom)));
    await nextTask();
    expect(uncaught).toEqual([boom]);
    expect(html()).toBe("");
  });

  // React 19 sends an error thrown synchronously by the callback to the error boundary
  // (startTransition's catch dispatches a rejected thenable), not to the caller.
  test("a transition callback that throws synchronously sends the error to the boundary", () => {
    let start!: (fn: () => unknown) => void;
    function App() {
      start = useTransition()[1];
      return h("p", null, "app");
    }
    render(h(App));
    const boom = new Error("sync");
    expect(() =>
      flushSync(() =>
        start(() => {
          throw boom;
        }),
      ),
    ).not.toThrow();
    expect(uncaught).toEqual([boom]);
    expect(html()).toBe("");
  });

  // React's startTransition reports a callback's synchronous throw (reportGlobalError).
  test("startTransition reports a callback that throws, instead of throwing to its caller", () => {
    const boom = new Error("sync");
    expect(() =>
      startTransition(() => {
        throw boom;
      }),
    ).not.toThrow();
    expect(reported).toEqual([boom]);
  });
});

describe("useDeferredValue", () => {
  test("shows the initial value first, then the value; later renders show the value", async () => {
    const seen: string[] = [];
    function App({ v }: { v: string }) {
      const d = useDeferredValue(v, "initial");
      seen.push(d);
      return h("p", null, d);
    }
    render(h(App, { v: "real" }));
    await nextTask();
    expect(seen).toEqual(["initial", "real"]);
    expect(html()).toBe("<p>real</p>");
    render(h(App, { v: "next" }));
    await nextTask();
    expect(html()).toBe("<p>next</p>");
  });

  test("without an initial value, the first render shows the value", () => {
    const seen: string[] = [];
    function App({ v }: { v: string }) {
      seen.push(useDeferredValue(v));
      return null;
    }
    render(h(App, { v: "a" }));
    expect(seen).toEqual(["a"]);
  });
});

describe("useOptimistic", () => {
  // A list whose optimistic additions end in "?".
  let add!: (item: string) => void;
  let setReal!: (items: string[]) => void;
  function List() {
    const [real, s] = useState(["a"]);
    setReal = s;
    const [items, a] = useOptimistic(real, (cur: string[], item: string) => [...cur, item + "?"]);
    add = a;
    return h("p", null, items.join(","));
  }

  test("an update in a transition shows until it ends, replayed over the real state meanwhile", async () => {
    render(h(List));
    const d = deferred();
    flushSync(() =>
      startTransition(() => {
        add("b");
        return d.promise;
      }),
    );
    expect(html()).toBe("<p>a,b?</p>");
    flushSync(() => setReal(["a", "c"]));
    expect(html()).toBe("<p>a,c,b?</p>");
    d.resolve();
    await nextTask();
    expect(html()).toBe("<p>a,c</p>");
  });

  test("an update outside a transition shows, then is dropped", async () => {
    render(h(List));
    flushSync(() => add("z"));
    expect(html()).toBe("<p>a,z?</p>");
    await nextTask();
    expect(html()).toBe("<p>a</p>");
  });

  test("without a reducer, the update is the optimistic state", () => {
    let set!: (v: string) => void;
    function App() {
      const [v, s] = useOptimistic("real");
      set = s;
      return h("p", null, v);
    }
    render(h(App));
    flushSync(() => startTransition(() => (set("guess"), new Promise(() => {}))));
    expect(html()).toBe("<p>guess</p>");
  });
});

// Dispatches are made in transitions, as React expects: outside one, React's isPending stays false.
describe("useActionState", () => {
  test("dispatches run one at a time, each from the last one's state, pending until all finish", async () => {
    const calls: [number, number][] = [];
    let dispatch!: (p: number) => void;
    function App() {
      const [state, d, pending] = useActionState(async (s: number, p: number) => {
        calls.push([s, p]);
        await Promise.resolve();
        return s + p;
      }, 0);
      dispatch = d;
      return h("p", null, state + (pending ? " pending" : ""));
    }
    render(h(App));
    flushSync(() =>
      startTransition(() => {
        dispatch(1);
        dispatch(2);
      }),
    );
    expect(html()).toBe("<p>0 pending</p>");
    await nextTask();
    expect(calls).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(html()).toBe("<p>3</p>");
  });

  test("dispatch runs the action of the latest render", async () => {
    let dispatch!: (p: string) => void;
    function App({ tag }: { tag: string }) {
      const [state, d] = useActionState((_: string, p: string) => tag + p, "");
      dispatch = d;
      return h("p", null, state);
    }
    render(h(App, { tag: "old " }));
    render(h(App, { tag: "new " }));
    startTransition(() => dispatch("x"));
    await nextTask();
    expect(html()).toBe("<p>new x</p>");
  });

  test("an optimistic update made in an action shows until the action finishes", async () => {
    const gate = deferred();
    let dispatch!: (p: string) => void;
    function App() {
      const [items, d] = useActionState(async (s: string[], item: string) => {
        addOptimistic(item);
        await gate.promise;
        return [...s, item];
      }, []);
      const [shown, addOptimistic] = useOptimistic(items, (cur: string[], item: string) => [...cur, item + "?"]);
      dispatch = d;
      return h("p", null, shown.join(","));
    }
    render(h(App));
    startTransition(() => dispatch("a"));
    await nextTask();
    expect(html()).toBe("<p>a?</p>");
    gate.resolve();
    await nextTask();
    expect(html()).toBe("<p>a</p>");
  });

  test("an action that throws sends the error to the component's boundary", async () => {
    const boom = new Error("action");
    let dispatch!: (p: number) => void;
    function App() {
      const [state, d] = useActionState((_: number, __: number): number => {
        throw boom;
      }, 0);
      dispatch = d;
      return h("p", null, state);
    }
    render(h(App));
    startTransition(() => dispatch(1));
    await nextTask();
    expect(uncaught).toEqual([boom]);
  });

  test("useFormState is useActionState", () => {
    expect(useFormState).toBe(useActionState);
  });
});

describe("forms", () => {
  // The fake DOM's elements have no reset(): installed on its prototype for these tests, it
  // counts the resets of each element.
  const proto = FakeElement.prototype as unknown as { reset?: () => void };
  beforeEach(() => {
    proto.reset = function (this: { resets?: number }) {
      this.resets = (this.resets ?? 0) + 1;
    };
  });
  afterEach(() => {
    delete proto.reset;
  });
  /** A submit event: the fake DOM's events have no preventDefault or submitter. */
  class SubmitEvent extends FakeEvent {
    defaultPrevented = false;
    submitter: FakeElement | null = null;
    constructor() {
      super("submit");
    }
    preventDefault(): void {
      this.defaultPrevented = true;
    }
  }
  const submit = (form: FakeElement): SubmitEvent => {
    const e = new SubmitEvent();
    form.dispatchEvent(e);
    return e;
  };

  // Every status the reader rendered with.
  let statuses: FormStatus[];
  beforeEach(() => {
    statuses = [];
  });
  function Status() {
    const s = useFormStatus();
    statuses.push(s);
    return h("i", null, s.pending ? "pending" : "idle");
  }

  test("useFormStatus outside a form is idle", () => {
    render(h("div", null, h(Status)));
    expect(statuses).toEqual([{ pending: false, data: null, method: null, action: null }]);
  });

  test("a form's action runs on submit: its readers show pending, then the form resets", async () => {
    const d = deferred();
    const got: unknown[] = [];
    const action = (data: FormData) => (got.push(data), d.promise);
    render(h("form", { action }, h("div", null, h(Status))));
    const form = container.firstChild as FakeElement;
    form["method"] = "post";
    const e = submit(form);
    expect(e.defaultPrevented).toBe(true);
    expect(got[0]).toBeInstanceOf(FormData);
    await Promise.resolve();
    expect(html()).toBe("<form><div><i>pending</i></div></form>");
    expect(statuses.at(-1)).toEqual({ pending: true, data: got[0] as FormData, method: "post", action });
    expect(form["resets"]).toBe(undefined);
    d.resolve();
    await nextTask();
    expect(html()).toBe("<form><div><i>idle</i></div></form>");
    expect(form["resets"]).toBe(1);
  });

  test("a form removed while its action runs is not reset", async () => {
    const d = deferred();
    render(h("form", { action: () => d.promise }));
    const form = container.firstChild as FakeElement;
    submit(form);
    render(null);
    d.resolve();
    await nextTask();
    expect(form["resets"]).toBe(undefined);
  });

  test("a form action that rejects sends the error to the form's boundary", async () => {
    const boom = new Error("form action");
    render(h("form", { action: () => Promise.reject(boom) }));
    submit(container.firstChild as FakeElement);
    await nextTask();
    expect(uncaught).toEqual([boom]);
  });

  test("a form whose action is useActionState's dispatch stays pending until the action finishes", async () => {
    const gate = deferred();
    const payloads: unknown[] = [];
    function App() {
      const [n, dispatch] = useActionState(async (s: number, data: FormData) => {
        payloads.push(data);
        await gate.promise;
        return s + 1;
      }, 0);
      return h("form", { action: dispatch }, h(Status), n);
    }
    render(h(App));
    const form = container.firstChild as FakeElement;
    submit(form);
    await nextTask();
    expect(html()).toBe("<form><i>pending</i>0</form>");
    expect(payloads[0]).toBeInstanceOf(FormData);
    gate.resolve();
    await nextTask();
    expect(html()).toBe("<form><i>idle</i>1</form>");
    expect(form["resets"]).toBe(1);
  });

  test("requestFormReset resets a form with no action running", async () => {
    render(h("form", null));
    const form = container.firstChild as FakeElement;
    startTransition(() => requestFormReset(form as unknown as HTMLFormElement));
    await nextTask();
    expect(form["resets"]).toBe(1);
  });

  test("requestFormReset while the form's action runs leaves the reset to the action's end", async () => {
    const d = deferred();
    render(h("form", { action: () => d.promise }));
    const form = container.firstChild as FakeElement;
    submit(form);
    startTransition(() => requestFormReset(form as unknown as HTMLFormElement));
    expect(form["resets"]).toBe(undefined);
    d.resolve();
    await nextTask();
    expect(form["resets"]).toBe(1);
  });
});

describe("server-only APIs and stubs", () => {
  test("cache does not memoize on the client: every call runs the function", () => {
    let calls = 0;
    const f = cache((n: number) => (calls++, n * 2));
    expect(f(2)).toBe(4);
    expect(f(2)).toBe(4);
    expect(calls).toBe(2);
  });

  test("cacheSignal and captureOwnerStack return null", () => {
    expect(cacheSignal()).toBe(null);
    expect(captureOwnerStack()).toBe(null);
  });

  test("unstable_useCacheRefresh returns a function that renders nothing", () => {
    let refresh!: () => void;
    let renders = 0;
    function App() {
      refresh = unstable_useCacheRefresh();
      renders++;
      return null;
    }
    render(h(App));
    flushSync(() => refresh());
    expect(renders).toBe(1);
  });
});
