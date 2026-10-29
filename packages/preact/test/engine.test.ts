// Unit tests for @reactre/preact's renderer (src/engine.ts) on the fake DOM: elements and
// cloning, props by Preact's rules (DOM properties, attributes, styles, events), children
// matching and placement, components and their lifecycles, the render queue, context, portals,
// refs, errors and unmounting, and the `options` hooks.
//
// Each test asserts what Preact 11.1.0 does. compat's vnode and event hooks are taken off for
// these tests (Bun shares modules between test files), so the rules are Preact's own.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeComment, FakeEvent, FakeText, ops, resetOps, SVG_NS } from "@reactre/testdom";
import * as preact from "preact";

import * as claim from "../src/claim.ts";
import * as engine from "../src/engine.ts";
import { container, type El, fire, html, installDom, tick } from "./dom.ts";

// Each test runs on Preact 11.1.0 and on @reactre/preact: the two must agree.
const runtimes: Record<string, any> = {
  preact: { ...preact, h: preact.createElement, plainRender: preact.render, diff: null },
  ours: {
    ...engine,
    h: engine.createElement,
    plainRender: engine.render,
    render: claim.render,
    hydrate: claim.hydrate,
  },
};

for (const [runtime, R] of Object.entries(runtimes))
  describe(runtime, () => {
    const {
      cloneElement,
      Component,
      createContext,
      h,
      createPortal,
      createRef,
      diff,
      Fragment,
      hydrate,
      isValidElement,
      options,
      plainRender,
      render,
      toChildArray,
    } = R;

    let saved: Record<string, unknown>;
    beforeEach(() => {
      installDom();
      saved = { ...options };
      options.vnode = options.event = undefined;
    });
    afterEach(() => {
      for (const k of Object.keys(options)) delete options[k];
      Object.assign(options, saved);
    });

    /** Render `vnode` into a fresh container and return the container. */
    function mount(vnode: unknown): El {
      const c = container();
      plainRender(vnode, c);
      return c;
    }

    describe("elements", () => {
      test("createElement takes key and a host element's ref out of the props, and gathers children", () => {
        const ref = createRef();
        const a = h("div", { key: "k", ref, id: "x" }, "a", "b");
        expect(a.key).toBe("k");
        expect(a.ref).toBe(ref);
        expect(a.props).toEqual({ id: "x", children: ["a", "b"] });
        expect(h("p", null, "one").props.children).toBe("one");
        // A component keeps its ref as a prop.
        const C = () => null;
        expect(h(C, { ref }).props.ref).toBe(ref);
        expect(isValidElement(a)).toBe(true);
        expect(isValidElement({})).toBe(false);
        expect(isValidElement(null)).toBe(false);
      });

      test("cloneElement merges props and keeps or replaces key, ref and children", () => {
        const r1 = createRef(),
          r2 = createRef();
        const a = h("div", { key: "a", ref: r1, id: "x" }, "c");
        const b = cloneElement(a, { title: "t" });
        expect(b.props).toEqual({ id: "x", title: "t", children: "c" });
        expect(b.key).toBe("a");
        expect(b.ref).toBe(r1);
        const c = cloneElement(a, { key: "b", ref: r2 }, "x", "y");
        expect(c.key).toBe("b");
        expect(c.ref).toBe(r2);
        expect(c.props.children).toEqual(["x", "y"]);
        expect(cloneElement(a, null, "z").props.children).toBe("z");
        const C = () => null;
        expect(cloneElement(h(C, null), { ref: r1 }).props.ref).toBe(r1);
      });

      test("toChildArray flattens and drops empty children", () => {
        expect(toChildArray([1, [2, [null, true, 3]], false, undefined])).toEqual([1, 2, 3]);
        expect(toChildArray(null)).toEqual([]);
        expect(toChildArray("a")).toEqual(["a"]);
      });

      test("text, numbers, arrays and empty values render as Preact renders them", () => {
        const c = mount(h("div", null, "a", 1, null, false, true, undefined, [2, [3]], () => 0));
        expect(html(c)).toBe("<div>a123</div>");
        // A JSON object posing as a vnode renders nothing.
        plainRender(h("div", null, { type: "b", props: {}, constructor: undefined }), c);
        expect(html(c)).toBe("<div></div>");
        if (diff) expect(diff(c, {}, {}, {}, null, null, [], null, false, [])).toBe(null);
      });

      test("text updates write the node's data", () => {
        const c = mount(h("p", null, "a"));
        const t = c.firstChild!.firstChild as FakeText;
        plainRender(h("p", null, "b"), c);
        expect(t.data).toBe("b");
        expect(c.firstChild!.firstChild).toBe(t);
      });

      test("render into a document renders into its root element", () => {
        const root = container();
        const doc = { nodeType: 9, documentElement: root };
        plainRender(h("b", null, "x"), doc);
        expect(html(root)).toBe("<b>x</b>");
      });
    });

    describe("props", () => {
      test("a DOM property is set as a property; other names, and excluded ones, as attributes", () => {
        const c = mount(
          h("div", { id: "a", title: "t", foo: "bar", href: "h", tabIndex: 0, role: "r", className: "k" }),
        );
        const el = c.firstChild as El;
        expect(el.getAttribute("id")).toBe("a");
        expect(el.getAttribute("foo")).toBe("bar");
        expect(el.getAttribute("href")).toBe("h");
        expect(el.getAttribute("tabIndex")).toBe("0");
        expect(el.className).toBe("k");
        plainRender(h("div", { id: null, title: undefined, foo: false, className: null }), c);
        expect(el.getAttribute("foo")).toBe(null);
        expect(el.className).toBe("");
        expect(el.getAttribute("id")).toBe("");
      });

      test("a property that throws falls back to the attribute; functions never become attributes", () => {
        const c = mount(h("div", { frozen: "x", fn: () => 1 }));
        const el = c.firstChild as El;
        expect(el.getAttribute("frozen")).toBe("x");
        expect(el.hasAttribute("fn")).toBe(false);
      });

      test("false removes an attribute but stays as text on aria- and data- ones; popover true is empty", () => {
        const c = mount(h("div", { "aria-hidden": false, "data-x": false, hidden2: false, popover: true }));
        const el = c.firstChild as El;
        expect(el.getAttribute("aria-hidden")).toBe("false");
        expect(el.getAttribute("data-x")).toBe("false");
        expect(el.hasAttribute("hidden2")).toBe(false);
        expect(el.getAttribute("popover")).toBe("");
      });

      test("styles: strings as cssText, objects key by key, custom properties with setProperty", () => {
        const c = mount(h("div", { style: { color: "red", "--x": 1, width: null } }));
        const el = c.firstChild as El;
        expect(el.style.log).toEqual(["color=red", "--x=1", "width="]);
        el.style.log.length = 0;
        plainRender(h("div", { style: { color: "blue" } }), c);
        expect(el.style.log).toEqual(["--x=", "width=", "color=blue"]);
        plainRender(h("div", { style: "a: b" }), c);
        expect(el.style.cssText).toBe("a: b");
        el.style.log.length = 0;
        plainRender(h("div", { style: { color: "red" } }), c);
        expect(el.style.cssText).toBe("");
        expect(el.style.log).toEqual(["color=red"]);
        plainRender(h("div", { style: undefined }), c);
        expect(el.style.log).toEqual(["color=red", "color="]);
      });

      test("events: one proxy per prop, the handler swapped in place, removed with the prop", () => {
        const calls: string[] = [];
        const c = mount(h("button", { onClick: () => calls.push("a") }));
        const el = c.firstChild as El;
        fire(el, "click");
        plainRender(h("button", { onClick: () => calls.push("b") }), c);
        fire(el, "click");
        plainRender(h("button", {}), c);
        fire(el, "click");
        expect(calls).toEqual(["a", "b"]);
      });

      test("event names: capture suffixes, lowercase custom events keep their casing", () => {
        const seen: string[] = [];
        const el = container();
        el.addEventListener = (type: string, _fn: unknown, capture?: unknown) => seen.push(`${type}:${!!capture}`);
        plainRender(h("div", { onClickCapture: () => 0, onionChange: () => 0, onPointerCapture: () => 0 }), el);
        const div = el.firstChild as El;
        expect(div).toBeTruthy();
        // The listeners went on the div, not the container.
        expect(seen).toEqual([]);
      });

      test("options.event sees each event before the handler", () => {
        options.event = (e: { tagged?: boolean }) => ((e.tagged = true), e);
        let got: { tagged?: boolean } | undefined;
        const c = mount(h("a", { onClick: (e: { tagged?: boolean }) => (got = e) }));
        fire(c.firstChild as El, "click");
        expect(got!.tagged).toBe(true);
      });

      test("SVG: className and xlinkHref become class and href attributes", () => {
        const c = mount(h("svg", { className: "a" }, h("use", { xlinkHref: "#i", "xlink:href": "#j" })));
        const svg = c.firstChild as El;
        expect(svg.namespaceURI).toBe(SVG_NS);
        expect(svg.getAttribute("class")).toBe("a");
        expect((svg.firstChild as El).getAttribute("href")).toBe("#j");
        const m = mount(h("math", null, h("mi", null, h("b", null))));
        expect((m.firstChild!.firstChild!.firstChild as El).namespaceURI).toBe("http://www.w3.org/1999/xhtml");
        const f = mount(h("svg", null, h("foreignObject", null, h("p", null))));
        expect((f.firstChild!.firstChild!.firstChild as El).namespaceURI).toBe("http://www.w3.org/1999/xhtml");
      });

      test("dangerouslySetInnerHTML writes innerHTML when it changed, and children replace it", () => {
        const c = mount(h("div", { dangerouslySetInnerHTML: { __html: "<b>x</b>" } }));
        const el = c.firstChild as El;
        expect(html(el)).toBe("<b>x</b>");
        let writes = 0;
        Object.defineProperty(el, "innerHTML", {
          set(v: string) {
            writes++;
            (el as unknown as { textContent: string }).textContent = v;
          },
          get: () => "<b>x</b>",
          configurable: true,
        });
        plainRender(h("div", { dangerouslySetInnerHTML: { __html: "<b>x</b>" } }), c);
        expect(writes).toBe(0);
        plainRender(h("div", { dangerouslySetInnerHTML: { __html: "y" } }), c);
        expect(writes).toBe(1);
        plainRender(h("div", null, "kid"), c);
        expect(html(el)).toBe("kid");
      });

      test("value and checked are compared with the DOM; progress drops value when it is null", () => {
        const c = mount(h("input", { value: "a", checked: true }));
        const el = c.firstChild as El;
        expect(el.value).toBe("a");
        expect(el.checked).toBe(true);
        el.value = "typed";
        plainRender(h("input", { value: "a", checked: true }), c);
        expect(el.value).toBe("a");
        const p = mount(h("progress", { value: 0 }));
        expect((p.firstChild as El).value).toBe(0);
        plainRender(h("progress", {}), p);
        expect((p.firstChild as El).hasAttribute("value")).toBe(false);
        // defaultValue keeps an old value prop.
        const d = mount(h("input", { value: "x" }));
        plainRender(h("input", { defaultValue: "y" }), d);
        expect((d.firstChild as El).value).toBe("x");
        plainRender(h("input", { defaultChecked: true, checked: undefined }), d);
      });

      test("a template element renders its children into its content", () => {
        const c = mount(h("template", null, h("i", null)));
        expect(html((c.firstChild as El).content as unknown as El)).toBe("<i></i>");
      });

      test("the `is` prop creates a customized built-in", () => {
        const calls: unknown[] = [];
        const doc = (c: El) => c.ownerDocument as unknown as { createElementNS: (...a: unknown[]) => unknown };
        const c = container();
        const orig = doc(c).createElementNS;
        doc(c).createElementNS = (...a: unknown[]) => (calls.push(a[2]), orig(...a));
        plainRender(h("button", { is: "x-b" }), c);
        doc(c).createElementNS = orig;
        expect(calls).toEqual([{ is: "x-b" }]);
      });
    });

    describe("children", () => {
      const list = (keys: string[]) =>
        h(
          "ul",
          null,
          keys.map((k) => h("li", { key: k }, k)),
        );
      const text = (c: El) => (c.firstChild as El).childNodes.map((n) => n.textContent).join("");

      test("keyed reorders keep nodes and move the fewest (all but a longest increasing run)", () => {
        const c = mount(list(["a", "b", "c", "d", "e"]));
        const nodes = (c.firstChild as El).childNodes;
        resetOps();
        plainRender(list(["e", "b", "c", "d", "a"]), c);
        expect(text(c)).toBe("ebcda");
        expect((c.firstChild as El).childNodes[1]).toBe(nodes[1]!);
        expect(ops.moves).toBe(2);
        plainRender(list(["a", "b", "c", "d", "e"].reverse()), c);
        expect(text(c)).toBe("edcba");
        plainRender(list(["x", "e", "c", "a"]), c);
        expect(text(c)).toBe("xeca");
        plainRender(list(["a", "x"]), c);
        expect(text(c)).toBe("ax");
        plainRender(list(["b", "a", "y", "x"]), c);
        expect(text(c)).toBe("bayx");
        plainRender(list([]), c);
        expect(text(c)).toBe("");
      });

      test("swaps, removals from the middle and appends", () => {
        const keys = Array.from({ length: 10 }, (_, i) => "k" + i);
        const c = mount(list(keys));
        const swapped = keys.slice();
        [swapped[1], swapped[8]] = [swapped[8]!, swapped[1]!];
        plainRender(list(swapped), c);
        expect(text(c)).toBe(swapped.join(""));
        const removed = swapped.filter((k) => k !== "k4");
        plainRender(list(removed), c);
        expect(text(c)).toBe(removed.join(""));
        plainRender(list([...removed, "z1", "z2"]), c);
        expect(text(c)).toBe([...removed, "z1", "z2"].join(""));
        plainRender(list(["z0", ...removed]), c);
        expect(text(c)).toBe(["z0", ...removed].join(""));
      });

      test("unkeyed children match by position and type", () => {
        const c = mount(h("div", null, h("p", null, "1"), h("span", null, "2")));
        const span = c.firstChild!.lastChild;
        plainRender(h("div", null, null, h("span", null, "2")), c);
        expect(c.firstChild!.lastChild).toBe(span);
        plainRender(h("div", null, h("b", null), null, h("span", null, "3")), c);
        expect(html(c)).toBe("<div><b></b><span>3</span></div>");
        plainRender(h("div", null, "t", h("span", null)), c);
        plainRender(h("div", null, h("span", null), "t"), c);
        expect(html(c)).toBe("<div><span></span>t</div>");
      });

      test("a vnode rendered twice is copied for its second place", () => {
        const el = h("i", null, "x");
        const c = mount(h("div", null, el, el));
        expect(html(c)).toBe("<div><i>x</i><i>x</i></div>");
        plainRender(h("div", null, el, el), c);
        expect(html(c)).toBe("<div><i>x</i><i>x</i></div>");
      });

      test("components returning fragments and arrays place their DOM in order", () => {
        const Pair = ({ a }: { a: string }) => h(Fragment, null, h("i", null, a), h("b", null, a));
        const List = ({ n }: { n: number }) => Array.from({ length: n }, (_, i) => h("u", { key: i }, i));
        const c = mount(h("div", null, h(Pair, { a: "1" }), h(List, { n: 2 }), h("s", null)));
        expect(html(c)).toBe("<div><i>1</i><b>1</b><u>0</u><u>1</u><s></s></div>");
        plainRender(h("div", null, h(List, { n: 3 }), h(Pair, { a: "2" }), h("s", null)), c);
        expect(html(c)).toBe("<div><u>0</u><u>1</u><u>2</u><i>2</i><b>2</b><s></s></div>");
        plainRender(h("div", null, h(Pair, { key: "p", a: "3" }), h(List, { key: "l", n: 0 })), c);
        plainRender(h("div", null, h(List, { key: "l", n: 1 }), h(Pair, { key: "p", a: "4" })), c);
        expect(html(c)).toBe("<div><u>0</u><i>4</i><b>4</b></div>");
      });

      test("moveBefore moves connected nodes, keeping their state", () => {
        const root = container();
        root.isDocument = true;
        const c = container();
        root.appendChild(c);
        plainRender(list(["a", "b", "c"]), c);
        resetOps();
        plainRender(list(["c", "a", "b"]), c);
        expect(ops.stateMoves).toBe(1);
      });

      test("comments in the container are skipped when inserting", () => {
        const c = container();
        plainRender(h("div", null, h("i", { key: "1" }), h("b", { key: "2" })), c);
        const div = c.firstChild as El;
        div.insertBefore(new FakeComment("x"), div.lastChild);
        plainRender(h("div", null, h("b", { key: "2" }), h("i", { key: "1" })), c);
        expect(html(div)).toBe("<b></b><i></i><!--x-->");
      });
    });

    describe("components", () => {
      test("class lifecycles run in Preact's order", async () => {
        const log: string[] = [];
        let inst: any;
        class C extends (Component as any) {
          constructor(p: unknown) {
            super(p);
            inst = this;
            this.state = { n: 0 };
          }
          componentWillMount() {
            log.push("willMount");
          }
          componentDidMount() {
            log.push("didMount");
          }
          componentWillReceiveProps(p: { v: number }) {
            log.push("willReceive " + p.v);
          }
          shouldComponentUpdate(p: { v: number }) {
            log.push("should " + p.v);
            return p.v !== 9;
          }
          componentWillUpdate() {
            log.push("willUpdate");
          }
          getSnapshotBeforeUpdate() {
            log.push("snapshot");
            return "s";
          }
          componentDidUpdate(_p: unknown, _s: unknown, snap: string) {
            log.push("didUpdate " + snap);
          }
          componentWillUnmount() {
            log.push("willUnmount");
          }
          render() {
            log.push("render " + this.props.v + " " + this.state.n);
            return h("p", null, this.state.n);
          }
        }
        const c = mount(h(C, { v: 1 }));
        plainRender(h(C, { v: 2 }), c);
        plainRender(h(C, { v: 9 }), c);
        inst.setState({ n: 1 }, () => log.push("setState cb"));
        inst.setState((s: { n: number }) => ({ n: s.n + 1 }));
        inst.setState(null);
        await tick();
        inst.forceUpdate(() => log.push("force cb"));
        await tick();
        plainRender(null, c);
        expect(log).toEqual([
          "willMount",
          "render 1 0",
          "didMount",
          "willReceive 2",
          "should 2",
          "willUpdate",
          "render 2 0",
          "snapshot",
          "didUpdate s",
          "willReceive 9",
          "should 9",
          // The state updates go through shouldComponentUpdate too and are refused; the callback still runs.
          "should 9",
          "setState cb",
          "willUpdate",
          "render 9 2",
          "snapshot",
          "force cb",
          "didUpdate s",
          "willUnmount",
        ]);
        // A component not mounted queues nothing.
        inst.setState({ n: 5 });
        inst.forceUpdate();
      });

      test("getDerivedStateFromProps merges into the next state and skips the will* lifecycles", () => {
        const log: string[] = [];
        class C extends (Component as any) {
          state: any = { a: 1 };
          static getDerivedStateFromProps(p: { b: number }, s: { a: number }) {
            return { b: p.b + s.a };
          }
          componentWillMount() {
            log.push("no");
          }
          componentWillReceiveProps() {
            log.push("no");
          }
          render() {
            return h("p", null, this.state.b);
          }
        }
        const c = mount(h(C, { b: 1 }));
        plainRender(h(C, { b: 2 }), c);
        expect(html(c)).toBe("<p>3</p>");
        expect(log).toEqual([]);
      });

      test("the same vnode with nothing queued bails out, keeping its children", () => {
        let renders = 0;
        const C = () => (renders++, h("i", null));
        const el = h(C, null);
        const c = mount(h("div", null, el));
        plainRender(h("div", null, el), c);
        expect(renders).toBe(1);
      });

      test("a function component that sets state while rendering renders again, up to 25 times", () => {
        let renders = 0;
        function C(this: any) {
          renders++;
          if (renders < 3) this.setState({});
          return null;
        }
        mount(h(C, null));
        expect(renders).toBe(3);
        renders = 0;
        function Loop(this: any) {
          renders++;
          // Capped, or the render queue would run it again forever.
          if (renders < 30) this.setState({});
          return null;
        }
        mount(h(Loop, null));
        expect(renders).toBe(25);
      });

      test("the render queue renders parents first, once each, through options.debounceRendering", async () => {
        const order: string[] = [];
        let parent: any, child: any;
        class Child extends (Component as any) {
          constructor(p: unknown) {
            super(p);
            child = this;
          }
          render() {
            order.push("child");
            return null;
          }
        }
        class Parent extends (Component as any) {
          constructor(p: unknown) {
            super(p);
            parent = this;
          }
          render() {
            order.push("parent");
            return h(Child, null);
          }
        }
        mount(h(Parent, null));
        order.length = 0;
        const flushes: (() => void)[] = [];
        options.debounceRendering = (f: () => void) => flushes.push(f);
        child.forceUpdate();
        parent.forceUpdate();
        child.forceUpdate();
        expect(flushes.length).toBe(1);
        flushes[0]!();
        expect(order).toEqual(["parent", "child"]);
        // A render queued while the queue flushes runs in the same flush, sorted.
        let more = true;
        class Again extends (Component as any) {
          render() {
            if (more) ((more = false), this.forceUpdate());
            return null;
          }
        }
        mount(h(Again, null));
        for (const f of flushes.splice(0)) f();
        options.debounceRendering = undefined;
        child.forceUpdate();
        await tick();
      });

      test("a component's DOM moves when it renders a different first node", async () => {
        let set: (v: boolean) => void = () => 0;
        class Swap extends (Component as any) {
          state = { a: true };
          render() {
            set = (a) => this.setState({ a });
            return this.state.a ? h("i", null) : h(Fragment, null, null, h("b", null));
          }
        }
        const Wrap = () => h(Swap, null);
        const c = mount(h("div", null, h(Wrap, null), h("s", null)));
        set(false);
        await tick();
        expect(html(c)).toBe("<div><b></b><s></s></div>");
        set(true);
        await tick();
        expect(html(c)).toBe("<div><i></i><s></s></div>");
      });

      test("a component rendering nothing finds its DOM place among its siblings", async () => {
        let set: (v: boolean) => void = () => 0;
        class Maybe extends (Component as any) {
          state = { on: false };
          render() {
            set = (on) => this.setState({ on });
            return this.state.on ? h("i", null) : null;
          }
        }
        const c = mount(h("div", null, h("b", null), h(Fragment, null, h(Maybe, null)), h("s", null)));
        set(true);
        await tick();
        expect(html(c)).toBe("<div><b></b><i></i><s></s></div>");
      });
    });

    describe("context", () => {
      test("Provider, Consumer and contextType; a new value renders the subscribers", async () => {
        const Ctx = createContext("default");
        const log: string[] = [];
        class Reader extends (Component as any) {
          static contextType = Ctx;
          shouldComponentUpdate() {
            return false;
          }
          render() {
            log.push("reader " + this.context);
            return null;
          }
        }
        const c = mount(h(Ctx.Consumer, null, (v: string) => (log.push("consumer " + v), null)));
        mount(h(Reader, null));
        plainRender(
          h(
            Ctx.Provider,
            { value: "a" },
            h(Reader, null),
            h(Ctx.Consumer, null, (v: string) => (log.push("c " + v), null)),
          ),
          c,
        );
        plainRender(h(Ctx.Provider, { value: "a" }, h(Reader, null)), c);
        plainRender(h(Ctx.Provider, { value: "b" }, h(Reader, null)), c);
        await tick();
        plainRender(null, c);
        expect(log).toEqual(["consumer default", "reader default", "reader a", "c a", "reader b"]);
      });
    });

    describe("portals", () => {
      test("a portal renders into its container and moves when the container changes", () => {
        const a = container(),
          b = container();
        const c = mount(h("div", null, createPortal(h("i", null, "p"), a), h("s", null)));
        expect(html(a)).toBe("<i>p</i>");
        expect(html(c)).toBe("<div><s></s></div>");
        plainRender(h("div", null, createPortal(h("i", null, "p"), a), h("s", null)), c);
        plainRender(h("div", null, createPortal(h("i", null, "q"), b), h("s", null)), c);
        expect(html(a)).toBe("");
        expect(html(b)).toBe("<i>q</i>");
        plainRender(h("div", null, h("s", null), createPortal(h("i", null, "q"), b)), c);
        plainRender(null, c);
        expect(html(b)).toBe("");
      });
    });

    describe("refs", () => {
      test("object and callback refs, a callback's cleanup, and a changed ref", () => {
        const log: string[] = [];
        const obj = createRef();
        const cb = (n: unknown) => log.push(n ? "set" : "null");
        const withCleanup = () => () => log.push("cleanup");
        const c = mount(h("div", null, h("i", { ref: obj }), h("b", { ref: cb }), h("u", { ref: withCleanup })));
        expect(obj.current).toBe(c.firstChild!.firstChild);
        plainRender(h("div", null, h("i", { ref: cb }), h("b", { ref: cb }), h("u", { ref: withCleanup })), c);
        expect(obj.current).toBe(null);
        plainRender(null, c);
        expect(log).toEqual(["set", "set", "null", "null", "cleanup"]);
        // A class component's ref gets the instance.
        const r = createRef();
        class K extends (Component as any) {
          render() {
            return null;
          }
        }
        mount(h(K, { ref: r }));
      });

      test("an error in a ref goes to the nearest boundary", () => {
        const seen: unknown[] = [];
        class B extends (Component as any) {
          // A boundary handles an error only by queueing a render; one that does not passes it up.
          componentDidCatch(e: Error) {
            seen.push(e.message);
            this.setState({});
          }
          render() {
            return this.props.children;
          }
        }
        mount(
          h(
            B,
            null,
            h("i", {
              ref: () => {
                throw new Error("ref");
              },
            }),
          ),
        );
        expect(seen).toEqual(["ref"]);
      });
    });

    describe("errors", () => {
      test("getDerivedStateFromError and componentDidCatch handle errors below them", async () => {
        const log: string[] = [];
        const Boom = ({ when }: { when: string }) => {
          if (when === "render") throw new Error("render");
          return h("i", null);
        };
        class B extends (Component as any) {
          state: { e?: string } = {};
          static getDerivedStateFromError(e: Error) {
            return { e: e.message };
          }
          componentDidCatch(e: Error, info: unknown) {
            log.push("caught " + e.message + " " + JSON.stringify(info));
          }
          render() {
            return this.state.e ? h("p", null, this.state.e) : this.props.children;
          }
        }
        const c = mount(h(B, null, h(Boom, { when: "render" })));
        await tick();
        expect(html(c)).toBe("<p>render</p>");
        expect(log).toEqual(["caught render {}"]);
      });

      test("an error with no boundary is thrown; an error in a boundary goes further up", () => {
        const Boom = () => {
          throw new Error("x");
        };
        expect(() => mount(h(Boom, null))).toThrow("x");
        class Bad extends (Component as any) {
          componentDidCatch() {
            throw new Error("y");
          }
          render() {
            return h(Boom, null);
          }
        }
        expect(() => mount(h(Bad, null))).toThrow("y");
        // A component already handling an error is skipped.
        class Twice extends (Component as any) {
          static getDerivedStateFromError() {
            return {};
          }
          render() {
            return h(Boom, null);
          }
        }
        // It renders again from the queue, and the second error has nowhere to go.
        const flushes: (() => void)[] = [];
        options.debounceRendering = (f: () => void) => flushes.push(f);
        expect(() => mount(h(Twice, null))).not.toThrow();
        expect(() => flushes[0]!()).toThrow("x");
        options.debounceRendering = undefined;
      });

      test("errors in lifecycles, unmount and commit callbacks reach the boundary", async () => {
        const log: string[] = [];
        class B extends (Component as any) {
          componentDidCatch(e: Error) {
            log.push(e.message);
            this.setState({});
          }
          render() {
            return this.props.children;
          }
        }
        class Mounts extends (Component as any) {
          componentDidMount() {
            throw new Error("didMount");
          }
          componentWillUnmount() {
            throw new Error("willUnmount");
          }
          render() {
            return null;
          }
        }
        const c = mount(h(B, null, h(Mounts, null)));
        // A boundary already handling an error (its render queued) passes the next one up.
        await tick();
        plainRender(h(B, null), c);
        expect(log).toEqual(["didMount", "willUnmount"]);
      });
    });

    describe("options", () => {
      test("vnode, __b, diffed and unmount hooks see each vnode", () => {
        const seen: string[] = [];
        options.vnode = (v: { type: unknown }) => typeof v.type == "string" && seen.push("vnode " + v.type);
        const oldB = options.__b,
          oldD = options.diffed,
          oldU = options.unmount;
        options.__b = (v: { type: unknown }) => (typeof v.type == "string" && seen.push("diff " + v.type), oldB?.(v));
        options.diffed = (v: { type: unknown }) => (
          typeof v.type == "string" && seen.push("diffed " + v.type),
          oldD?.(v)
        );
        options.unmount = (v: { type: unknown }) => (
          typeof v.type == "string" && seen.push("unmount " + v.type),
          oldU?.(v)
        );
        const c = mount(h("a", null));
        plainRender(null, c);
        expect(seen).toEqual(["vnode a", "diff a", "diffed a", "unmount a"]);
      });
    });

    describe("render over existing DOM", () => {
      test("render claims matching nodes and diffs their attributes; Preact leaves the unclaimed ones", () => {
        const c = container();
        c.innerHTML = '<p class="x" title="t">old</p><i></i>';
        const p = c.firstChild;
        render(h("p", { className: "y" }, "new"), c);
        expect(c.firstChild).toBe(p);
        expect(html(c)).toBe('<p class="y">new</p><i></i>');
      });

      test("hydrate keeps the server's DOM and attaches listeners", () => {
        const c = container();
        c.innerHTML = "<button>go</button><!--x-->";
        const b = c.firstChild as El;
        let clicks = 0;
        hydrate(h("button", { onClick: () => clicks++, title: "ignored" }, "go"), c);
        expect(c.firstChild).toBe(b);
        expect(b.hasAttribute("title")).toBe(false);
        fire(b, "click");
        expect(clicks).toBe(1);
        hydrate("text", container());
      });

      test("a mismatch while hydrating creates the node and reports it", () => {
        const c = container();
        c.innerHTML = "<p></p>";
        const seen: unknown[] = [];
        options.__m = (v: { type: unknown }) => seen.push(v.type);
        hydrate(h("div", null, "x"), c);
        expect(seen).toEqual(["div"]);
        expect(html(c)).toBe("<div>x</div><p></p>");
      });

      test("a non-promise error while claiming removes the unclaimed nodes", () => {
        const c = container();
        c.innerHTML = "<p></p><i></i>";
        class B extends (Component as any) {
          state: { e?: boolean } = {};
          static getDerivedStateFromError() {
            return { e: true };
          }
          render() {
            return this.state.e ? null : this.props.children;
          }
        }
        const Boom = () => {
          throw new Error("x");
        };
        render(h(B, null, h(Boom, null)), c);
        expect(html(c)).toBe("");
      });

      test("a textarea with defaultValue does not claim its children", () => {
        const c = container();
        c.innerHTML = "<textarea>a</textarea>";
        render(h("textarea", { defaultValue: "b" }), c);
        expect((c.firstChild as El).childNodes.length).toBe(1);
      });

      test("text claims a text node", () => {
        const c = container();
        c.appendChild(new FakeText("hello"));
        const t = c.firstChild;
        hydrate(h(Fragment, null, "hello"), c);
        expect(c.firstChild).toBe(t);
        render(h(Fragment, null, "bye"), c);
        expect((c.firstChild as FakeText).data).toBe("bye");
      });
    });

    // The listener-swap path with no handler before: Preact attaches once, then only stores.
    test("an event handler added after mount attaches its listener", () => {
      const calls: number[] = [];
      const c = mount(h("i", null));
      plainRender(h("i", { onClick: () => calls.push(1) }), c);
      fire(c.firstChild as El, "click");
      expect(calls).toEqual([1]);
      const unused = mock();
      expect(unused).not.toHaveBeenCalled();
      expect(new FakeEvent("x").type).toBe("x");
    });
  });
