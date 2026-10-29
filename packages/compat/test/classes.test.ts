// Class components, which the class build (@reactre/compat/classes)
// adds to @reactre/compat. Importing it installs class support for
// every test in the process, so class tests live here.
//
// Covered: setState merging and callbacks with componentDidUpdate, the lifecycles in React's
// order (legacy will-methods, getDerivedStateFromProps, shouldComponentUpdate and
// PureComponent, snapshots, refs and unmounting), and error boundaries with
// getDerivedStateFromError, componentDidCatch or both.

import { beforeEach, describe, expect, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import {
  Component,
  createContext,
  createElement as h,
  createRef,
  createRoot,
  flushSync,
  PureComponent,
  type Root,
} from "../src/classes.ts";

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

describe("class components", () => {
  test("setState merges state and runs its callback after the render", () => {
    const log: string[] = [];
    let inst!: Counter;
    class Counter extends Component<object, { n: number; label: string }> {
      override state = { n: 0, label: "n" };
      override componentDidUpdate() {
        log.push("did update " + this.state.n);
      }
      override render() {
        inst = this;
        return h("b", null, this.state.label, this.state.n);
      }
    }
    render(h(Counter));
    // The updater returns only `n`: `label` must survive the merge.
    flushSync(() =>
      inst.setState(
        (s: { n: number }) => ({ n: s.n + 1 }),
        () => log.push("callback"),
      ),
    );
    expect(html()).toBe("<b>n1</b>");
    expect(log).toEqual(["did update 1", "callback"]);
  });
});

describe("lifecycles", () => {
  test("legacy will-methods run in React's order, and setState in componentWillMount renders first", () => {
    const log: string[] = [];
    let inst!: Legacy;
    class Legacy extends Component<{ n: number }, { m: number }> {
      override state = { m: 0 };
      UNSAFE_componentWillMount() {
        log.push("will mount");
        this.setState({ m: 1 });
      }
      UNSAFE_componentWillReceiveProps(next: { n: number }) {
        log.push("will receive " + next.n);
      }
      UNSAFE_componentWillUpdate(next: { n: number }, state: { m: number }) {
        log.push(`will update ${next.n} ${state.m}`);
      }
      override render() {
        inst = this;
        log.push("render");
        return h("b", null, this.props.n, ":", this.state.m);
      }
    }
    render(h(Legacy, { n: 1 }));
    expect(html()).toBe("<b>1:1</b>");
    render(h(Legacy, { n: 2 }));
    // The component's own setState brings no new props: no componentWillReceiveProps.
    flushSync(() => inst.setState({ m: 5 }));
    expect(log).toEqual([
      "will mount",
      "render",
      "will receive 2",
      "will update 2 1",
      "render",
      "will update 2 5",
      "render",
    ]);
  });

  test("getDerivedStateFromProps runs on mount and on every update, and replaces the will-methods", () => {
    const log: string[] = [];
    class Derived extends Component<{ n: number }, { twice: number; own: number }> {
      override state = { twice: 0, own: 1 };
      static getDerivedStateFromProps(p: { n: number }, s: { own: number }) {
        return p.n < 0 ? null : { twice: p.n * 2 + s.own - 1 };
      }
      UNSAFE_componentWillMount() {
        log.push("never");
      }
      override render() {
        return h("b", null, this.state.twice);
      }
    }
    render(h(Derived, { n: 2 }));
    expect(html()).toBe("<b>4</b>");
    render(h(Derived, { n: 3 }));
    expect(html()).toBe("<b>6</b>");
    render(h(Derived, { n: -1 }));
    expect(html()).toBe("<b>6</b>");
    expect(log).toEqual([]);
  });

  test("a component with getSnapshotBeforeUpdate gets its snapshot in componentDidUpdate", () => {
    const log: unknown[] = [];
    class Snap extends Component<{ n: number }> {
      UNSAFE_componentWillMount() {
        log.push("never");
      }
      override getSnapshotBeforeUpdate(prev: { n: number }) {
        return "was " + prev.n;
      }
      override componentDidUpdate(_p: unknown, _s: unknown, snapshot: unknown) {
        log.push(snapshot);
      }
      override render() {
        return h("b", null, this.props.n);
      }
    }
    render(h(Snap, { n: 1 }));
    render(h(Snap, { n: 2 }));
    expect(log).toEqual(["was 1"]);
  });

  test("shouldComponentUpdate false skips the render but still takes the new props and state", () => {
    let inst!: Gate;
    const done: string[] = [];
    class Gate extends Component<{ n: number }, { m: number }> {
      override state = { m: 0 };
      override shouldComponentUpdate(next: { n: number }) {
        return next.n % 2 === 0;
      }
      override render() {
        inst = this;
        return h("b", null, this.props.n, ":", this.state.m);
      }
    }
    render(h(Gate, { n: 0 }));
    render(h(Gate, { n: 1 }));
    expect(html()).toBe("<b>0:0</b>");
    expect(inst.props.n).toBe(1);
    flushSync(() => inst.setState({ m: 3 }, () => done.push("callback")));
    expect(html()).toBe("<b>0:0</b>");
    expect(inst.state.m).toBe(3);
    expect(done).toEqual(["callback"]);
    // forceUpdate skips shouldComponentUpdate.
    flushSync(() => inst.forceUpdate());
    expect(html()).toBe("<b>1:3</b>");
  });

  test("a PureComponent renders again only when its props or state change shallowly", () => {
    let renders = 0;
    let inst!: Pure;
    class Pure extends PureComponent<{ a: number }, { b: number }> {
      override state = { b: 0 };
      override render() {
        inst = this;
        renders++;
        return h("b", null, this.props.a + this.state.b);
      }
    }
    render(h(Pure, { a: 1 }));
    render(h(Pure, { a: 1 }));
    flushSync(() => inst.setState({ b: 0 }));
    expect(renders).toBe(1);
    render(h(Pure, { a: 2 }));
    flushSync(() => inst.setState({ b: 1 }));
    expect(renders).toBe(3);
    expect(html()).toBe("<b>3</b>");
  });

  test("a context change renders a class through a false shouldComponentUpdate", () => {
    const Ctx = createContext("a");
    class Reader extends Component {
      static contextType = Ctx;
      override shouldComponentUpdate() {
        return false;
      }
      override render() {
        return h("b", null, this.context as string);
      }
    }
    render(h(Ctx, { value: "a" }, h(Reader)));
    render(h(Ctx, { value: "b" }, h(Reader)));
    expect(html()).toBe("<b>b</b>");
  });

  test("the ref gets the instance, not a prop, and moves when it changes; unmounting detaches it", () => {
    const log: string[] = [];
    let seen: unknown;
    class Box extends Component<{ id: string }> {
      override componentDidMount() {
        log.push("did mount " + this.props.id);
      }
      override componentWillUnmount() {
        log.push("will unmount " + this.props.id);
      }
      override render() {
        seen = (this.props as Record<string, unknown>)["ref"];
        return h("b", null, this.props.id);
      }
    }
    const a = createRef<Box>(),
      b = createRef<Box>();
    render(h(Box, { id: "x", ref: a }));
    expect(seen).toBeUndefined();
    expect(a.current).toBeInstanceOf(Box);
    const inst = a.current;
    render(h(Box, { id: "x", ref: b }));
    expect(a.current).toBeNull();
    expect(b.current).toBe(inst);
    render(h(Box, { id: "x" }));
    expect(b.current).toBeNull();
    render(h(Box, { id: "y", ref: a }));
    render(null);
    expect(a.current).toBeNull();
    expect(log).toEqual(["did mount x", "will unmount y"]);
  });

  test("a component without lifecycles mounts, updates and unmounts", () => {
    class Plain extends Component<{ n: number }> {
      override render() {
        return h("b", null, this.props.n);
      }
    }
    render(h(Plain, { n: 1 }));
    render(h(Plain, { n: 2 }));
    expect(html()).toBe("<b>2</b>");
    render(null);
    expect(html()).toBe("");
  });
});

describe("error boundaries", () => {
  test("a boundary replaces a throwing subtree with its fallback", () => {
    const caught: string[] = [];
    class Boundary extends Component<{ children?: unknown }, { error: string | null }> {
      override state = { error: null as string | null };
      static getDerivedStateFromError(e: Error) {
        return { error: e.message };
      }
      override componentDidCatch(e: Error) {
        caught.push(e.message);
      }
      override render() {
        return this.state.error !== null ? h("p", null, "error: " + this.state.error) : (this.props.children as never);
      }
    }
    function Bomb(): never {
      throw new Error("boom");
    }
    // With no onCaughtError option, the root logs the caught error; keep the test output clean.
    const quiet = console.error;
    console.error = () => {};
    try {
      render(h("div", null, h(Boundary, null, h("span", null, "ok"), h(Bomb))));
    } finally {
      console.error = quiet;
    }
    expect(html()).toBe("<div><p>error: boom</p></div>");
    expect(caught).toEqual(["boom"]);
  });
});

describe("error boundaries with componentDidCatch only", () => {
  test("renders nothing for the error until componentDidCatch sets state, and reports to onCaughtError", () => {
    const reported: string[] = [];
    root = createRoot(container as unknown as Element, {
      onCaughtError: (e) => reported.push((e as Error).message),
    });
    class Catcher extends Component<{ children?: unknown }, { error: string | null }> {
      override state = { error: null as string | null };
      override componentDidCatch(e: Error) {
        this.setState({ error: e.message });
      }
      override render() {
        return this.state.error !== null ? h("p", null, "caught " + this.state.error) : (this.props.children as never);
      }
    }
    let bad = true;
    function Bomb() {
      if (bad) throw new Error("bang");
      return h("i", null, "fine");
    }
    render(h(Catcher, null, h(Bomb)));
    expect(html()).toBe("<p>caught bang</p>");
    expect(reported).toEqual(["bang"]);
    bad = false;
  });

  // React's logCaughtError: onCaughtError gets the boundary instance and runs before
  // componentDidCatch; an error it throws is thrown again from a task of its own.
  test("onCaughtError gets the boundary before componentDidCatch runs, and its own error goes to a task", () => {
    const log: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const later: (() => void)[] = [];
    globalThis.setTimeout = ((fn: () => void) => (later.push(fn), 0)) as unknown as typeof setTimeout;
    try {
      root = createRoot(container as unknown as Element, {
        onCaughtError: (e, info) => {
          log.push("report " + (e as Error).message, info);
          throw new Error("report failed");
        },
      });
      let inst: unknown = null;
      class Catcher extends Component<{ children?: unknown }, { error: string | null }> {
        override state = { error: null as string | null };
        override componentDidCatch(e: Error) {
          inst = this;
          log.push("did catch " + e.message);
          this.setState({ error: e.message });
        }
        override render() {
          return this.state.error !== null ? h("p", null, "caught") : (this.props.children as never);
        }
      }
      function Bomb(): never {
        throw new Error("bang");
      }
      render(h(Catcher, null, h(Bomb)));
      expect(html()).toBe("<p>caught</p>");
      expect(log).toEqual(["report bang", { componentStack: "", errorBoundary: inst }, "did catch bang"]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(later).toHaveLength(1);
    expect(later[0]!).toThrow("report failed");
  });

  test("an error in a class's own render goes to the boundary above, and the class renders again later", () => {
    let fail = true;
    class Fragile extends Component<{ n: number }> {
      override render() {
        if (fail) throw new Error("own");
        return h("b", null, this.props.n);
      }
    }
    class Outer extends Component<{ children?: unknown }, { error: boolean }> {
      override state = { error: false };
      static getDerivedStateFromError() {
        return { error: true };
      }
      override render() {
        return this.state.error ? h("p", null, "outer") : (this.props.children as never);
      }
    }
    const quiet = console.error;
    console.error = () => {};
    try {
      render(h(Outer, null, h(Fragile, { n: 1 })));
    } finally {
      console.error = quiet;
    }
    expect(html()).toBe("<p>outer</p>");
    fail = false;
    render(h(Fragile, { n: 2 }));
    expect(html()).toBe("<b>2</b>");
  });
});

describe("packaging", () => {
  // The class build works by side effect: importing it installs class support. A bundler that
  // trusts a blanket "sideEffects": false follows its re-exports to the main module and drops
  // the install (Vite's Rolldown does), so the manifest must name it.
  test("the class build is declared as having side effects", async () => {
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { sideEffects: unknown };
    expect(manifest.sideEffects).toEqual(["./src/classes.ts", "./dist/classes.js"]);
  });
});
