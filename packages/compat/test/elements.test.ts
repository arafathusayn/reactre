// Unit tests for @reactre/compat's element API: jsx and createElement, cloneElement, defaultProps,
// the type wrappers (memo, forwardRef, lazy), contexts and portals as objects, and React's
// Children utilities with the keys React gives mapped children.

import { describe, expect, test } from "bun:test";

import {
  __defaults,
  __key,
  addTransitionType,
  Children,
  cloneElement,
  createContext,
  createElement as h,
  createPortal,
  createRef,
  forwardRef,
  Fragment,
  isValidElement,
  jsx,
  lazy,
  memo,
} from "../src/core.ts";

describe("creating elements", () => {
  test("jsx takes a spread key out of the props and uses the config as the props otherwise", () => {
    const config = { a: 1 };
    const el = jsx("div", config, 7);
    expect(el.key).toBe("7");
    expect(el.props).toBe(config);
    const spread = jsx("div", { key: "k", a: 1 });
    expect(spread.key).toBe("k");
    expect(spread.props).toEqual({ a: 1 });
    expect(jsx("div", { key: undefined, a: 1 }, "m").key).toBe("m");
    expect(jsx("div", {}).key).toBeNull();
  });

  test("ref is a prop, mirrored on the element", () => {
    const ref = createRef();
    expect(createRef()).toEqual({ current: null });
    expect(h("div", { ref }).ref).toBe(ref);
    expect(h("div").ref).toBeNull();
  });

  test("createElement keeps one child as itself and several as an array, and drops debug props", () => {
    expect(h("p", null, "a").props.children).toBe("a");
    expect(h("p", null, "a", "b").props.children).toEqual(["a", "b"]);
    expect(h("p", null).props).toEqual({});
    const el = h("p", { key: 3, __self: {}, __source: {}, id: "x" });
    expect(el.key).toBe("3");
    expect(el.props).toEqual({ id: "x" });
    expect(h("p", { key: undefined }).key).toBeNull();
  });

  test("defaultProps fill props that are undefined, without writing the caller's object", () => {
    const C = Object.assign(() => null, { defaultProps: { a: 1, b: 2 } });
    const config = { b: 3, c: undefined };
    const el = jsx(C, config);
    expect(el.props).toEqual({ a: 1, b: 3, c: undefined });
    expect(config).toEqual({ b: 3, c: undefined });
    expect(h(C, { a: undefined }).props).toEqual({ a: 1, b: 2 });
    expect(h(null as unknown as string).props).toEqual({});
    const fresh = { b: 9 };
    expect(__defaults(C, fresh)).toBe(fresh);
    expect(fresh as object).toEqual({ a: 1, b: 9 });
    expect(__defaults("div", fresh)).toBe(fresh);
    expect(__defaults(null, fresh)).toBe(fresh);
  });

  test("the compiler's key helper turns a key into a string, or null when there is none", () => {
    expect(__key(undefined)).toBeNull();
    expect(__key(0)).toBe("0");
  });

  test("cloneElement merges props, keeps the old ref for ref: undefined, and refills defaults", () => {
    const C = Object.assign(() => null, { defaultProps: { a: 1 } });
    const ref = createRef();
    const el = h(C, { ref, a: 2, b: 2 }, "kid");
    const copy = cloneElement(el, { a: undefined, ref: undefined, key: "k", __self: 1, __source: 2 });
    expect(copy.key).toBe("k");
    expect(copy.ref).toBe(ref);
    expect(copy.props).toEqual({ ref, a: 1, b: 2, children: "kid" });
    expect(cloneElement(el, { key: undefined }).key).toBeNull();
    expect(cloneElement(el, null, "x", "y").props.children).toEqual(["x", "y"]);
    expect(cloneElement(el, undefined, "z").props.children).toBe("z");
    const plain = h("b", { x: 1 });
    expect(cloneElement(plain, { x: undefined }).props).toEqual({ x: undefined });
    const nullType = { ...plain, type: null };
    expect(cloneElement(nullType, { x: undefined }).props).toEqual({ x: undefined });
  });

  test("isValidElement accepts React 19's element tag only, as React 19's does", () => {
    expect(isValidElement(h("a"))).toBe(true);
    expect(isValidElement({ $$typeof: Symbol.for("react.element") })).toBe(false);
    expect(isValidElement({ $$typeof: Symbol.for("other") })).toBe(false);
    expect(isValidElement(null)).toBe(false);
    expect(isValidElement("a")).toBe(false);
  });

  test("addTransitionType has nothing to do without view transitions", () => {
    expect(addTransitionType("x")).toBeUndefined();
  });
});

describe("type wrappers", () => {
  test("memo, forwardRef, contexts and portals have React's shapes", () => {
    const C = () => null;
    expect(memo(C)).toEqual({ $$typeof: Symbol.for("react.memo"), type: C, compare: null } as never);
    const eq = () => true;
    expect((memo(C, eq) as unknown as { compare: unknown }).compare).toBe(eq);
    const render = () => null;
    expect(forwardRef(render)).toEqual({ $$typeof: Symbol.for("react.forward_ref"), render } as never);
    const ctx = createContext(5);
    expect(ctx._currentValue).toBe(5);
    expect(ctx.Provider).toBe(ctx);
    expect(ctx.Consumer._context).toBe(ctx);
    const box = { nodeType: 1 } as Element;
    expect(createPortal("x", box)).toEqual({
      $$typeof: Symbol.for("react.portal"),
      key: null,
      children: "x",
      containerInfo: box,
    });
    expect(createPortal("x", box, 4 as unknown as string).key).toBe("4");
  });

  test("a lazy type loads once, throws its promise while loading, then gives the component", async () => {
    const C = () => null;
    let loads = 0;
    const L = lazy(() => (loads++, Promise.resolve({ default: C }))) as unknown as {
      _payload: unknown;
      _init: (p: unknown) => unknown;
    };
    let thrown: unknown;
    try {
      L._init(L._payload);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Promise);
    expect(() => L._init(L._payload)).toThrow();
    await thrown;
    expect(L._init(L._payload)).toBe(C);
    expect(loads).toBe(1);
  });

  test("a lazy type whose load fails throws the error from then on", async () => {
    const err = new Error("no");
    const L = lazy(() => Promise.reject(err)) as unknown as { _payload: unknown; _init: (p: unknown) => unknown };
    let thrown: unknown;
    try {
      L._init(L._payload);
    } catch (e) {
      thrown = e;
    }
    await (thrown as Promise<unknown>).catch(() => {});
    expect(() => L._init(L._payload)).toThrow(err);
  });
});

describe("Children", () => {
  const keys = (out: unknown[]) => out.map((c) => (c as { key: string }).key);

  test("map keys children by position and by escaped key, as React builds them", () => {
    const out = Children.map([h("a", { key: "x=y:z" }), h("b"), [h("c"), h("d", { key: "k" })]], (c) => c);
    expect(keys(out)).toEqual([".$x=0y=2z", ".1", ".2:0", ".2:$k"]);
  });

  test("map flattens an array a callback returns under the child's key path", () => {
    const out = Children.map([h("a", { key: "a/b" })], (c) => [c, h("i")]);
    expect(keys(out)).toEqual([".$a//b/.$a/b", ".$a//b/.1"]);
  });

  test("an element the callback keys itself leads the child's key path", () => {
    const out = Children.map([h("a", { key: "a" }), "text"], (c, i) => h("i", { key: "m" + i, c }));
    expect(keys(out)).toEqual(["m0/.$a", "m1/.1"]);
    const same = Children.map([h("a", { key: "a" })], (c) => c);
    expect(keys(same)).toEqual([".$a"]);
  });

  test("null, undefined and booleans are empty children; results that are null are dropped", () => {
    const seen: unknown[] = [];
    const out = Children.map([null, undefined, true, "s", 1, 2n], (c, i) => (seen.push([c, i]), c));
    expect(seen).toEqual([
      [null, 0],
      [null, 1],
      [null, 2],
      ["s", 3],
      [1, 4],
      [2n, 5],
    ]);
    expect(out).toEqual(["s", 1, 2n]);
  });

  test("map returns null and undefined children as they are, and calls with the context", () => {
    expect(Children.map(null, (c) => c)).toBeNull();
    expect(Children.map(undefined, (c) => c)).toBeUndefined();
    const ctx = { n: 0 };
    Children.map(
      ["a", "b"],
      function (this: typeof ctx) {
        this.n++;
      },
      ctx,
    );
    expect(ctx.n).toBe(2);
  });

  test("iterables that are not arrays are children too, and portals are leaves", () => {
    const portal = createPortal("p", { nodeType: 1 } as Element, "pk");
    expect(Children.toArray(new Set(["a", portal]))).toEqual(["a", portal]);
    expect(Children.count(new Set([1, 2, 3]))).toBe(3);
  });

  test("forEach, count and toArray walk nested children", () => {
    const seen: unknown[] = [];
    Children.forEach(["a", ["b", "c"]], (c) => void seen.push(c));
    Children.forEach(null, () => seen.push("never"));
    expect(seen).toEqual(["a", "b", "c"]);
    expect(Children.count(["a", ["b", null]])).toBe(3);
    expect(Children.count(null)).toBe(0);
    expect(Children.toArray(null)).toEqual([]);
    expect(keys(Children.toArray([h(Fragment, { key: "f" })]))).toEqual([".$f"]);
  });

  test("objects that are not children throw, as in React", () => {
    expect(() => Children.toArray({ a: 1 })).toThrow("Objects are not valid as a React child");
  });

  test("only returns its one element child and throws for anything else", () => {
    const el = h("a");
    expect(Children.only(el)).toBe(el);
    expect(() => Children.only([el])).toThrow("React.Children.only expected to receive a single React element child.");
  });
});
