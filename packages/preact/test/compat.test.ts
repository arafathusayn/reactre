// compat (src/compat.ts) and the JSX runtime, each scenario run on preact/compat and on
// @reactre/preact/compat with compat's hooks on: the transcripts must be equal.

import { describe } from "bun:test";

import { FakeComment, FakeText } from "@reactre/testdom";

import { type Ctx, same } from "./same.ts";

const compatSame = (title: string, scenario: (t: Ctx) => unknown) => same(title, scenario, true);

/** A promise and its resolve and reject functions. */
function deferred<T = unknown>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

describe("props", () => {
  compatSame("React names and values become Preact's", (t) => {
    const { createElement: h, render } = t.X;
    render(
      h(
        "div",
        null,
        h("svg", { strokeWidth: 2, clipPath: "c", xHeight: 1, vectorEffect: "v", fillOpacity: 0.5 }),
        h("a", {
          download: true,
          translate: "no",
          title: null,
          className: "k",
          style: { width: 2, flex: 1, zIndex: 3 },
        }),
        h("p", { class: "c" }),
        h("p", { class: "c", className: "d" }),
        h("x-el", { strokeWidth: 1 }),
        h("noscript", null, "kept"),
        h("p", { style: { opacity: 1 } }),
        h("p", { style: "a: b" }),
      ),
      t.c,
    );
    t.snap("props");
    const p = h("p", { class: "x" });
    t.log("className", p.props.className, Object.keys(p.props));
  });

  compatSame("value, defaultValue and select options", (t) => {
    const { createElement: h, render } = t.X;
    const opts = ["a", "b", "c"].map((v) => h("option", { value: v, key: v }, v));
    const sel = (props: object) => {
      const v = h(
        "select",
        props,
        opts.map((o: any) => h("option", { ...o.props, key: o.key })),
      );
      return v.props.children.map((o: any) => o.props.selected);
    };
    t.log("multiple", sel({ multiple: true, value: ["a", "c"] }));
    t.log("default", sel({ defaultValue: "b" }));
    t.log("default multiple", sel({ multiple: true, defaultValue: ["b"] }));
    t.log("input default", h("input", { defaultValue: "d", value: null }).props);
    t.log("input both", h("input", { defaultValue: "d", value: "v" }).props);
    render(h("input", { defaultValue: "d" }), t.c);
    t.log("value", (t.c.firstChild as any).value);
  });

  compatSame("event names: onChange, onDoubleClick, onFocus, onBlur, onInput together", (t) => {
    const { createElement: h, render } = t.X;
    const handler = (name: string) => (e: any) =>
      t.log(name, e.type, e.persist(), e.isPropagationStopped(), e.isDefaultPrevented(), e.nativeEvent === e);
    render(
      h(
        "div",
        null,
        h("input", { onChange: handler("text change") }),
        h("input", { type: "checkbox", onChange: handler("checkbox change") }),
        h("textarea", { onChange: handler("ta change"), onInput: handler("ta input") }),
        h("b", { onDoubleClick: handler("dbl"), onFocus: handler("focus"), onBlur: handler("blur") }),
      ),
      t.c,
    );
    const [text, box, ta, b] = (t.c.firstChild as any).childNodes;
    t.fire(text, "input");
    t.fire(box, "change");
    t.fire(ta, "input");
    t.fire(b, "dblclick");
    t.fire(b, "focusin");
    t.fire(b, "focusout", { defaultPrevented: true });
  });

  compatSame("refs, defaultProps and $$typeof on component vnodes", (t) => {
    const { createElement: h, render, createRef, Component } = t.X;
    const ref = createRef();
    class K extends Component {
      static defaultProps = { a: 1, b: 2 };
      render() {
        t.log("props", this.props);
        return null;
      }
    }
    const v = h(K, { ref, b: undefined, c: 3 });
    t.log("typeof", typeof v.$$typeof, "ref in props", "ref" in v.props);
    render(v, t.c);
    t.log("instance", ref.current instanceof K);
    const F = (p: any) => (t.log("fn ref", typeof p.ref), null);
    render(h(F, { ref }), t.c);
    const host = h("i", { ref });
    t.log("host ref prop", host.props.ref === ref);
  });

  compatSame("UNSAFE_ lifecycles alias the old names; isReactComponent", async (t) => {
    const { createElement: h, render, Component } = t.X;
    class C extends Component {
      UNSAFE_componentWillMount() {
        t.log("willMount");
      }
      UNSAFE_componentWillReceiveProps() {
        t.log("willReceive");
      }
      UNSAFE_componentWillUpdate() {
        t.log("willUpdate");
      }
      render() {
        return null;
      }
    }
    render(h(C, null), t.c);
    render(h(C, { x: 1 }), t.c);
    const c = new (C as any)({});
    c.componentWillMount = () => t.log("own");
    c.componentWillMount();
    t.log("isReactComponent", C.prototype.isReactComponent);
  });
});

describe("roots", () => {
  compatSame("render clears the container once, calls back, returns the component", (t) => {
    const { createElement: h, render, Component, unmountComponentAtNode, findDOMNode } = t.X;
    t.c.appendChild(new FakeText("old"));
    class C extends Component {
      render() {
        return h("p", null, "c");
      }
    }
    const inst = render(h(C, null), t.c, () => t.log("callback"));
    t.snap("first");
    t.log("instance", inst instanceof C, render(null, t.c) === null);
    t.log("findDOMNode", findDOMNode(null), findDOMNode(t.c) === t.c, findDOMNode({}) === null);
    const again = render(h(C, null), t.c);
    t.log("dom", findDOMNode(again) === t.c.firstChild);
    t.log("unmount", unmountComponentAtNode(t.c), unmountComponentAtNode(t.container()));
    t.snap("after");
  });

  compatSame("createRoot and hydrateRoot", (t) => {
    const { createElement: h, createRoot, hydrateRoot, hydrate } = t.X;
    const root = createRoot(t.c);
    root.render(h("b", null, "1"));
    root.render(h("b", null, "2"));
    t.snap("root");
    root.unmount();
    t.snap("unmounted");
    const s = t.container();
    s.innerHTML = "<i>x</i>";
    const i = s.firstChild;
    const hr = hydrateRoot(s, h("i", { onClick: () => t.log("clicked") }, "x"));
    t.log("kept", s.firstChild === i);
    t.fire(i, "click");
    hr.render(h("i", null, "y"));
    t.snap("hydrated", s);
    t.log(
      "hydrate returns",
      hydrate(null, t.container(), () => t.log("cb")),
    );
  });

  compatSame("flushSync renders queued updates now; batchedUpdates calls through", async (t) => {
    const { createElement: h, render, useState, flushSync, unstable_batchedUpdates } = t.X;
    let set: any;
    function App() {
      const [n, s] = useState(0);
      set = s;
      return h("p", null, n);
    }
    render(h(App, null), t.c);
    t.log(
      "returns",
      flushSync((a: number) => (set(a), a), 5),
    );
    t.snap("flushed");
    t.log(
      "nothing queued",
      flushSync(() => 1),
    );
    try {
      flushSync(() => {
        throw new Error("inner");
      });
    } catch (e) {
      t.log("rethrown", (e as Error).message);
    }
    t.log(
      "batched",
      unstable_batchedUpdates((a: number) => (set(a), a + 1), 7),
    );
    await t.tick();
    t.snap("batched");
  });

  compatSame("createPortal sets containerInfo", (t) => {
    const { createElement: h, render, createPortal } = t.X;
    const other = t.container();
    const p = createPortal(h("i", null, "p"), other);
    t.log("containerInfo", p.containerInfo === other);
    render(h("div", null, p), t.c);
    t.snap("other", other);
  });
});

describe("elements", () => {
  compatSame("isValidElement, isElement, isFragment, isMemo, cloneElement, createFactory, version", (t) => {
    const X = t.X;
    const h = X.createElement;
    const el = h("p", { a: 1 }, "x");
    t.log("valid", X.isValidElement(el), X.isValidElement({}), X.isValidElement(null), X.isElement(el));
    t.log("fragment", X.isFragment(h(X.Fragment, null)), X.isFragment(el));
    const M = X.memo(() => null);
    t.log(
      "memo",
      X.isMemo(M),
      X.isMemo(() => 0),
      X.isMemo(null),
    );
    t.log("clone", X.cloneElement(el, { b: 2 }).props, X.cloneElement("text"));
    t.log("factory", X.createFactory("i")({ c: 3 }).type, X.version, X.StrictMode === X.Fragment);
    t.log("default", Object.keys(X.default).sort().join(","));
  });

  compatSame("Children helpers", (t) => {
    const { Children, createElement: h } = t.X;
    const kids = [h("a", { key: 1 }), [h("b", null), null], "t"];
    t.log(
      "map",
      Children.map(kids, (c: any, i: number) => (typeof c == "string" ? c : c.type + i)),
    );
    t.log(
      "map null",
      Children.map(null, () => 1),
    );
    const seen: unknown[] = [];
    Children.forEach(
      kids,
      function (this: unknown, c: unknown) {
        seen.push([this, typeof c]);
      },
      "ctx",
    );
    t.log("forEach", seen);
    t.log("count", Children.count(kids), Children.count(null));
    t.log("only", Children.only(h("i", null)).type);
    try {
      Children.only(kids);
    } catch (e) {
      t.log("only throws", e);
    }
    t.log("toArray", Children.toArray(kids).length);
  });

  compatSame("JSX runtimes make the same vnodes", (t) => {
    for (const J of [t.J, t.XJ]) {
      const a = J.jsx("p", { id: "a", children: "x" }, "k");
      const b = J.jsxs("ul", { children: [J.jsx("li", {}), J.jsx("li", {})] });
      const d = J.jsxDEV("i", { ref: "r", children: undefined }, undefined);
      const C = () => null;
      (C as any).defaultProps = { z: 1 };
      const c = J.jsx(C, { ref: "r", y: 2 });
      t.log(a.type, a.key, a.props, b.props.children.length, d.ref, d.props, c.props, c.ref ?? null);
      t.log("fragment", J.Fragment === t.R.Fragment);
    }
    t.log("dom", t.J.jsx("b", { children: "j" }).type);
    const dev = t.J.jsxDEV("b", {}, undefined, false, { fileName: "f.tsx", lineNumber: 1 }, null);
    t.log("source", dev.__source, dev.__self);
  });
});

describe("components", () => {
  compatSame("PureComponent and memo skip renders with equal props", async (t) => {
    const { createElement: h, render, PureComponent, memo, createRef } = t.X;
    class P extends PureComponent {
      render() {
        t.log("pure", this.props.a);
        return null;
      }
    }
    const M = memo((p: { a: number }) => (t.log("memo", p.a), null));
    const N = memo(
      (p: { a: number; b: number }) => (t.log("custom", p.a), null),
      (a: { a: number }, b: { a: number }) => a.a == b.a,
    );
    const named = memo(Object.assign(() => null, { displayName: "Named" }));
    t.log(M.displayName, named.displayName, M.prototype.isReactComponent, typeof M.type);
    const r1 = createRef(),
      r2 = (v: unknown) => t.log("fn ref", v === null ? null : "set");
    const R = memo(
      t.X.forwardRef((_p: unknown, ref: any) => h("i", { ref })),
      () => true,
    );
    for (const props of [
      { a: 1, b: 1 },
      { a: 1, b: 1 },
      { a: 2, b: 1 },
    ]) {
      render(h("div", null, h(P, props), h(M, props), h(N, props)), t.c);
    }
    render(h(R, { ref: r1 }), t.c);
    render(h(R, { ref: r2 }), t.c);
    render(h(R, { ref: r2 }), t.c);
    t.log("object ref cleared", r1.current);
    render(h(R, { ref: r1 }), t.c);
    t.log("object ref", r1.current === t.c.firstChild);
    const p = new (P as any)({ a: 1 });
    p.state = { s: 1 };
    t.log(
      "pure state",
      p.shouldComponentUpdate({ a: 1 }, { s: 2 }),
      p.shouldComponentUpdate({ a: 1, __source: 1 }, { s: 1 }),
    );
  });

  compatSame("forwardRef passes the ref as the second argument", (t) => {
    const { createElement: h, render, forwardRef, createRef } = t.X;
    const ref = createRef();
    function Inner(props: any, r: unknown) {
      t.log("props", Object.keys(props), r === ref, r === null);
      return h("i", { ref: r });
    }
    const F = forwardRef(Inner);
    t.log(F.displayName, F.render === Inner, typeof F.$$typeof);
    render(h(F, { ref, a: 1 }), t.c);
    t.log("set", ref.current === t.c.firstChild);
    render(h(F, { a: 2 }), t.c);
    const G = forwardRef(Object.assign(() => null, { displayName: "G" }));
    t.log(G.displayName);
  });

  compatSame("transitions, deferred values, insertion effects and effect events", async (t) => {
    const X = t.X;
    const h = X.createElement;
    let ev: any;
    function App(p: { n: number }) {
      const [pending, start] = X.useTransition();
      X.useInsertionEffect(() => t.log("insertion", p.n));
      ev = X.useEffectEvent((a: number) => p.n + a);
      t.log("deferred", X.useDeferredValue(p.n), pending);
      start(() => t.log("transition"));
      return null;
    }
    X.startTransition(() => t.log("start"));
    X.render(h(App, { n: 1 }), t.c);
    X.render(h(App, { n: 2 }), t.c);
    t.log("event", ev(10));
    t.log(
      "dispatcher",
      Object.keys(X.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current).length,
    );
  });

  compatSame("useSyncExternalStore subscribes and rerenders on change", async (t) => {
    const X = t.X;
    const h = X.createElement;
    let value = 1;
    const listeners = new Set<() => void>();
    const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
    let throwing = false;
    const get = () => {
      if (throwing) throw new Error("snapshot");
      return value;
    };
    function App() {
      const v = X.useSyncExternalStore(subscribe, get);
      t.log("render", v);
      return h("p", null, v);
    }
    X.render(h(App, null), t.c);
    // A change between render and the subscription is caught.
    value = 2;
    await t.paint();
    value = 3;
    listeners.forEach((l) => l());
    await t.tick();
    listeners.forEach((l) => l());
    throwing = true;
    listeners.forEach((l) => l());
    throwing = false;
    await t.tick();
    t.snap("store");
    X.render(null, t.c);
    t.log("unsubscribed", listeners.size);
  });

  compatSame("use reads promises and context", async (t) => {
    const X = t.X;
    const h = X.createElement;
    const Ctx = X.createContext("default");
    const ok = deferred<string>(),
      bad = deferred<string>();
    function Read(p: { p: any }) {
      return h("i", null, X.use(p.p));
    }
    function Ctxs() {
      return h("b", null, X.use(Ctx));
    }
    let set: any;
    function App() {
      const [v, s] = X.useState("a");
      set = s;
      return h(Ctx.Provider, { value: v }, h(Ctxs, null));
    }
    X.render(
      h(
        "div",
        null,
        h(X.Suspense, { fallback: "wait" }, h(Read, { p: ok.promise })),
        h(Ctxs, null),
        h(App, null),
        h(
          class extends X.Component {
            state: { e?: string } = {};
            static getDerivedStateFromError(e: Error) {
              return { e: e.message };
            }
            render() {
              return this.state.e
                ? "error " + this.state.e
                : h(X.Suspense, { fallback: "wait2" }, h(Read, { p: bad.promise }));
            }
          },
          null,
        ),
      ),
      t.c,
    );
    await t.tick();
    t.snap("pending");
    ok.resolve("done");
    bad.reject(new Error("nope"));
    await t.tick();
    await t.tick();
    set("b");
    await t.tick();
    t.snap("settled");
  });
});

describe("suspense", () => {
  compatSame("a component inside a parked subtree renders while suspended", async (t) => {
    const X = t.X;
    const h = X.createElement;
    const d = deferred<any>();
    const A = X.lazy(() => d.promise);
    let set: any, show: any;
    function Grow() {
      const [n, s] = X.useState(1);
      set = s;
      return h(
        X.Fragment,
        null,
        Array.from({ length: n }, (_, i) => h("u", { key: n - i }, n - i)),
      );
    }
    function App() {
      const [on, s] = X.useState(false);
      show = s;
      return h(X.Suspense, { fallback: "f" }, h("div", null, h(Grow, null), h("s", null)), on && h(A, null));
    }
    X.render(h(App, null), t.c);
    show(true);
    await t.tick();
    set(3);
    await t.tick();
    t.snap("parked");
    d.resolve({ default: () => h("a", null, "A") });
    await t.tick();
    await t.tick();
    set(2);
    await t.tick();
    t.snap("resolved");
  });

  compatSame("lazy components suspend to the fallback and resolve", async (t) => {
    const X = t.X;
    const h = X.createElement;
    const d1 = deferred<any>(),
      d2 = deferred<any>(),
      d3 = deferred<any>();
    const A = X.lazy(() => d1.promise);
    const B = X.lazy(() => d2.promise);
    const E = X.lazy(() => d3.promise);
    function Effects() {
      X.useEffect(() => {
        t.log("effect");
        return () => t.log("effect cleanup");
      }, []);
      X.useLayoutEffect(() => () => t.log("layout cleanup"), []);
      return h("u", { ref: (n: unknown) => t.log("ref", !!n) }, "fx");
    }
    class Catch extends X.Component {
      state: { e?: string } = {};
      componentDidCatch(e: Error) {
        this.setState({ e: e.message });
      }
      render() {
        return this.state.e ? "caught " + this.state.e : this.props.children;
      }
    }
    let show: any;
    function App() {
      const [s, set] = X.useState(false);
      show = set;
      return h(
        X.Suspense,
        { fallback: h("p", null, "loading") },
        h(Effects, null),
        h("span", null, "static"),
        s && h(A, { x: 1 }),
        s && h(B, null),
      );
    }
    X.render(h("div", null, h(App, null), h(Catch, null, h(X.Suspense, { fallback: "e" }, h(E, null)))), t.c);
    await t.paint();
    t.snap("ready");
    show(true);
    await t.tick();
    t.snap("suspended");
    d1.resolve({ default: (p: any) => h("a", null, "A" + p.x) });
    await t.tick();
    t.snap("one resolved");
    d2.resolve(null);
    d3.reject(new Error("load"));
    await t.tick();
    await t.tick();
    await t.paint();
    t.snap("resolved");
    X.render(null, t.c);
    t.log("unmounted");
    await t.paint();
  });

  compatSame("a suspended boundary unmounted before it resolves", async (t) => {
    const X = t.X;
    const h = X.createElement;
    const d = deferred<any>();
    const A = X.lazy(() => d.promise);
    X.render(h(X.Suspense, { fallback: "f" }, h("i", null), h(A, null)), t.c);
    await t.tick();
    t.snap("fallback");
    X.render(h("p", null), t.c);
    d.resolve(() => "late");
    await t.tick();
    t.snap("after");
    // A suspension with no Suspense above goes to the error handlers.
    const N = X.lazy(() => new Promise(() => {}));
    try {
      X.render(h(N, null), t.container());
    } catch (e) {
      t.log("no boundary", typeof (e as any).then);
    }
  });

  compatSame("hydration keeps the server's DOM for a suspended subtree, then resumes on it", async (t) => {
    const X = t.X;
    const h = X.createElement;
    const d = deferred<any>(),
      d2 = deferred<any>();
    const A = X.lazy(() => d.promise);
    const B = X.lazy(() => d2.promise);
    const s = t.c;
    s.innerHTML =
      "<div><!--$s--><p>server</p><!--$s--><i>in</i><!--/$s--><!--/$s--><b>after</b><em>b</em><s>x</s></div>";
    X.hydrate(
      h(
        "div",
        null,
        h(X.Suspense, { fallback: "f" }, h(A, null)),
        h("b", { onClick: () => t.log("click") }, "after"),
        h(X.Suspense, { fallback: "g" }, h(B, null)),
        h("s", null, "x"),
      ),
      s,
    );
    t.snap("hydrating");
    t.fire(
      s.firstChild!.childNodes.find((n: any) => n.localName == "b"),
      "click",
    );
    d.resolve({ default: () => h("p", null, "server") });
    d2.resolve({ default: () => h("em", null, "b") });
    await t.tick();
    await t.tick();
    t.snap("hydrated");
    X.render(null, s);
    t.snap("unmounted");
  });

  compatSame("a hydrating boundary unmounted while suspended removes its server range", async (t) => {
    const X = t.X;
    const h = X.createElement;
    const A = X.lazy(() => new Promise(() => {}));
    const s = t.c;
    s.innerHTML = "<!--$s--><p>server</p><!--/$s--><b>x</b>";
    X.hydrate(h(X.Fragment, null, h(X.Suspense, { fallback: "f" }, h(A, null)), h("b", null, "x")), s);
    t.snap("kept");
    X.render(h("b", null, "x"), s);
    t.snap("removed");
    const plain = t.container();
    plain.innerHTML = "<p>server</p><b>x</b>";
    X.hydrate(h(X.Fragment, null, h(X.Suspense, { fallback: "f" }, h(A, null)), h("b", null, "x")), plain);
    X.render(h("b", null, "x"), plain);
    t.snap("plain", plain);
  });

  compatSame("rendering over a container that holds comments and unclaimed nodes", async (t) => {
    const R = t.R;
    const h = R.createElement;
    const s = t.c;
    s.appendChild(new FakeComment("c"));
    s.appendChild(new FakeText("t"));
    s.innerHTML = '<p data-a="1" title="t">x</p><!--$s--><i>y</i><!--/$s-->';
    const A = t.X.lazy(() => new Promise(() => {}));
    R.render(h(R.Fragment, null, h("p", { title: "u" }, "x"), h(t.X.Suspense, { fallback: "f" }, h(A, null))), s);
    t.snap("rendered");
  });
});
