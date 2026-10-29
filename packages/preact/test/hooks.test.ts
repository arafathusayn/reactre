// Hooks (src/hooks.ts, effects.ts, layout.ts, lifecycle.ts), each scenario run on preact/hooks
// and on @reactre/preact/core: the transcripts must be equal.

import { describe } from "bun:test";

import { same } from "./same.ts";

describe("state", () => {
  same("useState and useReducer: updates, functional updates, bail-outs on equal values", async (t) => {
    const { createElement: h, render, useState, useReducer } = t.R;
    let set: any, dispatch: any;
    function App() {
      const [n, setN] = useState(() => 1);
      const [s, d] = useReducer((s: number, a: number) => s + a, 10);
      const [i] = useReducer(
        (x: string) => x,
        "a",
        (x: string) => x + "!",
      );
      set = setN;
      dispatch = d;
      t.log("render", n, s, i);
      return h("p", null, n + s);
    }
    render(h(App, null), t.c);
    set(2);
    set((x: number) => x + 1);
    await t.tick();
    t.snap("a");
    set(3);
    dispatch(0);
    await t.tick();
    dispatch(5);
    set(3);
    await t.tick();
    t.snap("b");
  });

  same("a hook update with an older shouldComponentUpdate", async (t) => {
    const { createElement: h, render, useState, Component } = t.R;
    let set: any;
    class Wrap extends Component {
      render() {
        return h(Inner, { v: this.props.v });
      }
    }
    // Hooks in a class component that has its own shouldComponentUpdate.
    class Inner extends Component {
      shouldComponentUpdate(p: { v: number }) {
        t.log("scu", p.v);
        return p.v !== 2;
      }
      render(p: { v: number }) {
        const [n, s] = useState(0);
        set = s;
        t.log("inner", p.v, n);
        return null;
      }
    }
    render(h(Wrap, { v: 1 }), t.c);
    render(h(Wrap, { v: 2 }), t.c);
    set(1);
    await t.tick();
    set(1);
    set(2);
    set(1);
    await t.tick();
  });

  same("useRef, useMemo and useCallback keep their values until the arguments change", (t) => {
    const { createElement: h, render, useRef, useMemo, useCallback } = t.R;
    const seen: unknown[] = [];
    function App(p: { a: number }) {
      const r = useRef(p.a);
      const m = useMemo(() => (t.log("memo", p.a), p.a * 2), [p.a]);
      const cb = useCallback(() => p.a, [p.a]);
      const each = useMemo(() => ({}));
      seen.push(cb);
      t.log(r.current, m, seen.length > 1 && seen[seen.length - 1] === seen[seen.length - 2], typeof each);
      return null;
    }
    render(h(App, { a: 1 }), t.c);
    render(h(App, { a: 1 }), t.c);
    render(h(App, { a: 2 }), t.c);
  });

  same("useId is stable, unique per root, and shared by nested roots", async (t) => {
    const { createElement: h, render, useId, useState } = t.R;
    let set: any;
    function Id() {
      const id = useId();
      t.log("id", id);
      return h("i", { id });
    }
    function App() {
      const [n, s] = useState(1);
      set = s;
      return h(
        "div",
        null,
        Array.from({ length: n }, (_, i) => h(Id, { key: i })),
      );
    }
    render(h(App, null), t.c);
    set(2);
    await t.tick();
    const other = t.container();
    render(h(Id, null), other);
    // A root rendered inside a component's DOM continues its parent's ids.
    render(h(Id, null), t.c.firstChild);
    t.snap("ids");
  });
});

describe("context and debugging", () => {
  same("useContext reads the nearest provider, its default without one, and rerenders on change", async (t) => {
    const { createElement: h, render, useContext, createContext, Component } = t.R;
    const Ctx = createContext("none");
    function Read() {
      t.log("read", useContext(Ctx));
      return null;
    }
    class Block extends Component {
      shouldComponentUpdate() {
        return false;
      }
      render() {
        return h(Read, null);
      }
    }
    render(h(Read, null), t.container());
    render(h(Ctx.Provider, { value: "a" }, h(Block, null)), t.c);
    render(h(Ctx.Provider, { value: "b" }, h(Block, null)), t.c);
    await t.tick();
  });

  same("useDebugValue reports through options.useDebugValue, formatted", (t) => {
    const { createElement: h, render, useDebugValue, options } = t.R;
    function App() {
      useDebugValue(1);
      options.useDebugValue = (v: unknown) => t.log("debug", v);
      useDebugValue(2);
      useDebugValue(3, (v: number) => v * 10);
      options.useDebugValue = undefined;
      return null;
    }
    render(h(App, null), t.c);
  });

  same("options.__h sees each hook's index and type", (t) => {
    const { createElement: h, render, options, ...hooks } = t.R;
    options.__h = (_c: unknown, i: number, type: number) => t.log("hook", i, type);
    function App() {
      hooks.useState(0);
      hooks.useReducer((s: number) => s, 0);
      hooks.useEffect(() => {});
      hooks.useLayoutEffect(() => {});
      hooks.useRef();
      hooks.useImperativeHandle(null, () => 0);
      hooks.useMemo(() => 0, []);
      hooks.useCallback(() => 0, []);
      hooks.useContext(t.R.createContext(0));
      hooks.useErrorBoundary();
      hooks.useId();
      return null;
    }
    render(h(App, null), t.c);
    options.__h = undefined;
  });
});

describe("effects", () => {
  same("layout effects run at commit, passive effects after paint, cleanups before the next run", async (t) => {
    const { createElement: h, render, useEffect, useLayoutEffect, useState } = t.R;
    let set: any;
    function App(p: { a: number }) {
      const [n, s] = useState(0);
      set = s;
      useLayoutEffect(() => {
        t.log("layout", p.a, n);
        return () => t.log("layout cleanup", p.a, n);
      }, [p.a, n]);
      useEffect(() => {
        t.log("effect", p.a, n);
        return () => t.log("effect cleanup", p.a, n);
      }, [p.a]);
      useEffect(() => t.log("every render"));
      useEffect(() => t.log("once"), []);
      return h("p", null, n);
    }
    render(h(App, { a: 1 }), t.c);
    t.log("rendered");
    await t.paint();
    render(h(App, { a: 2 }), t.c);
    set(1);
    await t.tick();
    await t.paint();
    render(null, t.c);
    t.log("unmounted");
    await t.paint();
  });

  same("a component rendering again before its effects ran gets them flushed first", async (t) => {
    const { createElement: h, render, useEffect, useState } = t.R;
    let set: any;
    function App() {
      const [n, s] = useState(0);
      set = s;
      useEffect(() => {
        t.log("effect", n);
        return () => t.log("cleanup", n);
      });
      return null;
    }
    render(h(App, null), t.c);
    set(1);
    await t.tick();
    set(2);
    await t.tick();
    await t.paint();
  });

  same("a component that sets state while rendering keeps its hooks", (t) => {
    const { createElement: h, render, useState, useLayoutEffect } = t.R;
    function App() {
      const [n, s] = useState(0);
      if (n < 2) s(n + 1);
      useLayoutEffect(() => t.log("layout", n));
      t.log("render", n);
      return null;
    }
    render(h(App, null), t.c);
  });

  same("errors in effects, layout effects and cleanups reach useErrorBoundary", async (t) => {
    const { createElement: h, render, useEffect, useLayoutEffect, useErrorBoundary, useState } = t.R;
    let reset: any, setMode: any;
    function Boom(p: { mode: string }) {
      useLayoutEffect(() => {
        if (p.mode === "layout") throw new Error("layout");
        return () => {
          if (p.mode === "layout-cleanup") throw new Error("layout-cleanup");
        };
      });
      useEffect(() => {
        if (p.mode === "effect") throw new Error("effect");
        return () => {
          if (p.mode === "effect-cleanup" || p.mode === "unmount") throw new Error("cleanup " + p.mode);
        };
      });
      return h("i", null, p.mode);
    }
    function App() {
      const [mode, s] = useState("none");
      setMode = s;
      const [err, r] = useErrorBoundary((e: Error) => t.log("cb", e.message));
      reset = r;
      return err ? h("p", null, "caught " + err.message) : h(Boom, { mode });
    }
    render(h(App, null), t.c);
    await t.paint();
    for (const mode of ["layout", "effect", "layout-cleanup", "effect-cleanup"]) {
      setMode(mode);
      await t.tick();
      await t.paint();
      t.snap(mode);
      reset();
      setMode("none");
      await t.tick();
      await t.paint();
    }
    function Plain() {
      const [err] = useErrorBoundary();
      return err ? h("p", null, "plain " + err.message) : h(Boom, { mode: "layout" });
    }
    render(h(Plain, null), t.c);
    await t.tick();
    t.snap("plain");
  });

  same("a passive cleanup that throws on unmount goes to the nearest mounted boundary", async (t) => {
    const { createElement: h, render, useEffect, Component } = t.R;
    function Child() {
      useEffect(
        () => () => {
          throw new Error("unmount");
        },
        [],
      );
      return null;
    }
    class B extends Component {
      componentDidCatch(e: Error) {
        t.log("caught", e.message);
        this.setState({});
      }
      render() {
        return this.props.on ? h("div", null, h(Child, null)) : null;
      }
    }
    render(h(B, { on: true }), t.c);
    await t.paint();
    render(h(B, { on: false }), t.c);
    await t.paint();
    await t.tick();
  });

  same("a layout cleanup that throws on unmount reaches the boundary", async (t) => {
    const { createElement: h, render, useLayoutEffect, Component } = t.R;
    function Child() {
      useLayoutEffect(
        () => () => {
          throw new Error("unmount");
        },
        [],
      );
      return null;
    }
    class B extends Component {
      componentDidCatch(e: Error) {
        t.log("caught", e.message);
        this.setState({});
      }
      render() {
        return this.props.on ? h(Child, null) : null;
      }
    }
    render(h(B, { on: true }), t.c);
    render(h(B, { on: false }), t.c);
    await t.tick();
  });

  same("options.requestAnimationFrame schedules the passive flush", async (t) => {
    const { createElement: h, render, useEffect, options } = t.R;
    const frames: (() => void)[] = [];
    options.requestAnimationFrame = (f: () => void) => frames.push(f);
    function App(p: { n: number }) {
      useEffect(() => t.log("effect", p.n));
      return null;
    }
    render(h(App, { n: 1 }), t.c);
    render(h(App, { n: 2 }), t.c);
    t.log("frames", frames.length);
    frames.splice(0).forEach((f) => f());
    options.requestAnimationFrame = undefined;
    render(h(App, { n: 3 }), t.c);
    await t.paint();
  });

  same("options.__s skips effects (as a server renderer sets it)", async (t) => {
    const { createElement: h, render, useEffect, useLayoutEffect, options } = t.R;
    function App() {
      useEffect(() => t.log("effect"));
      useLayoutEffect(() => t.log("layout"));
      return h("b", null);
    }
    options.__s = true;
    render(h(App, null), t.c);
    options.__s = undefined;
    await t.paint();
    t.snap("server");
  });

  same("useImperativeHandle sets object and callback refs, with cleanups", async (t) => {
    const { createElement: h, render, useImperativeHandle, createRef } = t.R;
    const obj = createRef();
    const fn = (v: unknown) => {
      t.log("fn", v);
      return v === null ? undefined : () => t.log("fn cleanup");
    };
    const plain = (v: unknown) => t.log("plain", v);
    function App(p: { r: unknown; v: number; deps?: boolean }) {
      useImperativeHandle(p.r, () => ({ v: p.v }), p.deps ? [p.v] : undefined);
      return null;
    }
    render(h(App, { r: obj, v: 1 }), t.c);
    t.log("obj", obj.current);
    render(h(App, { r: obj, v: 2, deps: true }), t.c);
    render(h(App, { r: obj, v: 2, deps: true }), t.c);
    render(h(App, { r: fn, v: 3, deps: true }), t.c);
    render(h(App, { r: plain, v: 4, deps: true }), t.c);
    render(h(App, { r: null, v: 5, deps: true }), t.c);
    t.log("obj", obj.current);
    render(null, t.c);
  });
});
