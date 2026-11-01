// Ports of Solid 2.0's server rendering tests: the server's primitives (signals, memos, effects,
// stores, boundaries, context and owners as they run during a server render), control flow
// rendered to HTML, async data under <Loading> with renderToString and renderToStream, escaping,
// classes, styles and spread attributes. From solid-js 2.0.0-rc.20 (solidjs/solid@5e68925):
// packages/solid/test/server/signals.spec.ts, packages/solid/test/server/flow.spec.ts,
// packages/solid/test/server/ssr-async.spec.ts, packages/web/test/server/ssr-stream.spec.tsx,
// packages/web/test/server/ssr-class.spec.tsx, ssr-class-style-separators.spec.tsx,
// ssr-element-nullish-attrs.spec.tsx, ssr-element-names.spec.tsx, ssr-text-separators.spec.tsx and
// escape-late-values.spec.tsx. Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan
// Carniato; the license is in ./harness.ts.
//
// Solid's server tests call its server primitives and flow components as functions. reactre's
// control flow is compiled away and its server primitives are what a server build gives an app,
// so each port here is a module of TSX built as a server build is (`server` below): compiled with
// the compiler's server mode and bundled through its Bun plugin with `server: true`, which points
// the feature modules (a context's provider, <Errored>, features/async) at @reactre/core/server.
// Each bundle has a core of its own, so the async runtime it turns on stays in it. Solid's
// `createRoot(fn, { id })` around a test is the render's root here. Where Solid's renderToStream
// gives `{ pipe, then }`, reactre's is a ReadableStream: its first chunk is the shell, and the
// boundaries' content comes after it in `<template>`s. reactre's escaping also escapes `>` and
// `"` in text, so an escaped value is compared with reactre's `escape`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileSource, reactreCompiler } from "@reactre/compiler";

import { createRoot, getOwner } from "../../src/features/owner.ts";
import { onCleanup } from "../../src/index.ts";
import * as serverApi from "../../src/server.ts";
import { gap } from "./harness.ts";

// #region Harness

/** Where the bundles are written: a temporary folder the coverage run leaves out (bunfig.toml). */
let out: string;
let built = 0;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "reactre-plugin-solid-ssr-"));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** The path the entry is loaded as: a file of this folder in name only, so its imports resolve from here. */
const ENTRY = new URL("./ssr-entry.virtual.js", import.meta.url).pathname;

/** What a module built by `server` exports: its own, and @reactre/core/server's render functions. */
interface Built {
  App: () => unknown;
  renderToString(app: () => unknown, options?: { hydrate?: boolean }): string;
  renderToStream(app: () => unknown): ReadableStream<Uint8Array>;
  renderToStringAsync(app: () => unknown): Promise<string>;
  [k: string]: unknown;
}

/**
 * Build the TSX module `src` as a server build of an app is built, and load it. Its exports are
 * the module's, with @reactre/core/server's render functions.
 */
async function server(src: string): Promise<Built> {
  const code = src + '\nexport { renderToString, renderToStream, renderToStringAsync } from "@reactre/core/server";\n';
  const r = await Bun.build({
    entrypoints: ["reactre-solid:entry"],
    target: "bun",
    plugins: [
      {
        name: "entry",
        setup(b) {
          b.onResolve({ filter: /^reactre-solid:entry$/ }, () => ({ path: ENTRY }));
          b.onLoad({ filter: /ssr-entry\.virtual\.js$/ }, () => ({
            contents: compileSource(code, "tsx", { server: true }),
            loader: "js",
          }));
        },
      },
      reactreCompiler({ server: true, wholeProgram: false }),
    ],
  });
  if (!r.success) throw new AggregateError(r.logs, "the server build failed");
  const file = join(out, `m${built++}.js`);
  await Bun.write(file, await r.outputs[0]!.text());
  return (await import(file)) as Built;
}

/** `src`'s App rendered with renderToString. */
const str = async (src: string): Promise<string> => {
  const m = await server(src);
  return m.renderToString(m.App);
};

/** A stream read as it comes: its chunks so far, and a promise of its end (or of its error). */
interface Read {
  readonly chunks: string[];
  readonly done: Promise<void>;
  error: unknown;
}

function read(s: ReadableStream<Uint8Array>): Read {
  const chunks: string[] = [],
    dec = new TextDecoder(),
    r = s.getReader();
  const res = { chunks, error: undefined as unknown, done: Promise.resolve() };
  res.done = (async () => {
    try {
      for (;;) {
        const x = await r.read();
        if (x.done) return;
        chunks.push(dec.decode(x.value));
      }
    } catch (e) {
      res.error = e;
    }
  })();
  return res;
}

/** Solid's `collectChunks`: the shell (the first chunk), every chunk, and their join, once the stream ends. */
async function collect(m: Built): Promise<{ shell: string; chunks: string[]; full: string; error: unknown }> {
  const r = read(m.renderToStream(m.App));
  await r.done;
  return { shell: r.chunks[0] ?? "", chunks: r.chunks, full: r.chunks.join(""), error: r.error };
}

/** The content of each boundary a stream sent, in order: Solid's fragment results. */
const templates = (html: string): string[] =>
  [...html.matchAll(/<template id="rr:t\d+">([\s\S]*?)<\/template>/g)].map((x) => x[1]!);

/** Let timers and promise callbacks run. */
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A function an API of Solid's that reactre lacks would be: read off `mod`, throwing when it is not there. */
function missing<F>(mod: object, name: string): F {
  const f = (mod as Record<string, unknown>)[name];
  if (typeof f !== "function") throw new Error(`reactre has no ${name}`);
  return f as F;
}

// #endregion

describe("packages/solid/test/server/signals.spec.ts", () => {
  describe("Server createSignal", () => {
    test("creates and reads a plain signal", async () => {
      const m = await server(`
        import { signal } from "@reactre/core";
        const [value] = signal(5);
        export const v = value();
      `);
      expect(m["v"]).toBe(5);
    });

    test("creates signal with undefined", async () => {
      const m = await server(`
        import { signal } from "@reactre/core";
        const [value] = signal();
        export const v = value();
      `);
      expect(m["v"]).toBeUndefined();
    });

    test("sets a plain signal", async () => {
      const m = await server(`
        import { signal } from "@reactre/core";
        const [value, setValue] = signal(5);
        export const before = value();
        setValue(10);
        export const after = value();
      `);
      expect([m["before"], m["after"]]).toEqual([5, 10]);
    });

    test("sets signal with functional updater", async () => {
      const m = await server(`
        import { signal } from "@reactre/core";
        const [value, setValue] = signal(5);
        setValue((prev) => prev + 1);
        export const v = value();
      `);
      expect(m["v"]).toBe(6);
    });
  });

  describe("Server createMemo", () => {
    test("creates and reads a memo", async () => {
      const m = await server(`
        import { memo } from "@reactre/core";
        const hello = memo(() => "Hello");
        export const v = hello();
      `);
      expect(m["v"]).toBe("Hello");
    });

    gap("ssr-semantics", "a memo on the server computes when first read", "memo is eager by default", async () => {
      const m = await server(`
        import { memo } from "@reactre/core";
        let calls = 0;
        const answer = memo(() => (calls++, 42));
        export const made = calls;
        export const v = answer();
        export const after = calls;
      `);
      // Should have already computed eagerly.
      expect(m["made"]).toBe(1);
      expect(m["v"]).toBe(42);
      expect(m["after"]).toBe(1);
    });

    test("memo can be lazy", async () => {
      const m = await server(`
        import { memo } from "@reactre/core";
        let calls = 0;
        const answer = memo(() => (calls++, 42), { lazy: true });
        export const made = calls;
        export const first = [answer(), calls];
        export const second = [answer(), calls];
      `);
      expect(m["made"]).toBe(0);
      expect(m["first"]).toEqual([42, 1]);
      expect(m["second"]).toEqual([42, 1]);
    });

    test("memo with defaulted prev", async () => {
      const m = await server(`
        import { memo } from "@reactre/core";
        const next = memo((prev) => (prev ?? 10) + 1);
        export const v = next();
      `);
      expect(m["v"]).toBe(11);
    });

    test("memo throws NotReadyError for unresolved async", async () => {
      const m = await server(`
        import { memo } from "@reactre/core";
        import { NotReadyError } from "@reactre/core/features/async";
        const p = new Promise(() => {});
        const data = memo(() => p);
        let thrown;
        try { data(); } catch (e) { thrown = e; }
        export const notReady = thrown instanceof NotReadyError;
      `);
      expect(m["notReady"]).toBe(true);
    });

    test("memo resolves async value", async () => {
      const m = await server(`
        import { memo } from "@reactre/core";
        // Async memos need features/async loaded (a bare import of it is dropped from a bundle).
        export { NotReadyError } from "@reactre/core/features/async";
        let resolve;
        export const p = new Promise((r) => (resolve = r));
        export const data = memo(() => p);
        try { data(); } catch {}
        resolve("done");
      `);
      await (m["p"] as Promise<string>);
      await tick();
      // After the promise resolves, the value is set and the error cleared.
      expect((m["data"] as () => string)()).toBe("done");
    });
  });

  describe("Server createEffect", () => {
    test("runs compute but not effectFn on the server", async () => {
      const m = await server(`
        import { reaction } from "@reactre/core/features/reaction";
        export const calls = { compute: 0, effect: 0 };
        export function App() {
          reaction(() => (calls.compute++, 1), () => void calls.effect++);
          return <p>x</p>;
        }
      `);
      expect(m.renderToString(m.App)).toBe("<p>x</p>");
      expect(m["calls"]).toEqual({ compute: 1, effect: 0 });
    });

    gap(
      "memo-options",
      "an effect has no ssrSource option",
      "ssrSource client skips both compute and effectFn",
      async () => {
        const m = await server(`
        import { reaction } from "@reactre/core/features/reaction";
        export const calls = { compute: 0, effect: 0 };
        export function App() {
          reaction(() => (calls.compute++, 1), () => void calls.effect++, { ssrSource: "client" });
          return <p>x</p>;
        }
      `);
        m.renderToString(m.App);
        expect(m["calls"]).toEqual({ compute: 0, effect: 0 });
      },
    );
  });

  describe("Server createRenderEffect", () => {
    gap(
      "render-effects",
      "reaction is createEffect, whose apply half does not run on the server; reactre has no render effect",
      "computes and runs effect once",
      async () => {
        const m = await server(`
        import { reaction } from "@reactre/core/features/reaction";
        export const calls = { compute: 0, effect: [] };
        export function App() {
          reaction(() => (calls.compute++, 42), (v, prev) => void calls.effect.push([v, prev]));
          return <p>x</p>;
        }
      `);
        m.renderToString(m.App);
        expect(m["calls"]).toEqual({ compute: 1, effect: [[42, undefined]] });
      },
    );

    // reaction takes no defer option: this passes because its apply half never runs on the server.
    test("defer: true skips the initial effect run but still computes (#2811)", async () => {
      const m = await server(`
        import { reaction } from "@reactre/core/features/reaction";
        export const calls = { compute: 0, effect: 0 };
        export function App() {
          reaction(() => (calls.compute++, 42), () => void calls.effect++, { defer: true });
          return <p>x</p>;
        }
      `);
      m.renderToString(m.App);
      expect(m["calls"]).toEqual({ compute: 1, effect: 0 });
    });
  });

  describe("Server createTrackedEffect", () => {
    gap("render-effects", "createTrackedEffect is missing", "is a no-op", () => {
      const createTrackedEffect = missing<(fn: () => void) => void>(serverApi, "createTrackedEffect");
      let calls = 0;
      createRoot(() => createTrackedEffect(() => void calls++));
      expect(calls).toBe(0);
    });
  });

  describe("Server createReaction", () => {
    gap("create-reaction", "createReaction is missing", "calls tracking function once", () => {
      const createReaction = missing<(fn: () => void) => (tracking: () => void) => void>(serverApi, "createReaction");
      let effects = 0,
        tracked = 0;
      createReaction(() => void effects++)(() => void tracked++);
      expect([tracked, effects]).toEqual([1, 0]);
    });
  });

  describe("Server createStore", () => {
    test("creates and reads a store", async () => {
      const m = await server(`
        import { createStore } from "@reactre/core/features/store";
        const [state] = createStore({ count: 0, name: "test" });
        export const v = [state.count, state.name];
      `);
      expect(m["v"]).toEqual([0, "test"]);
    });

    test("sets store values via setter", async () => {
      const m = await server(`
        import { createStore } from "@reactre/core/features/store";
        const [state, setState] = createStore({ count: 0 });
        setState((s) => { s.count = 5; });
        export const v = state.count;
      `);
      expect(m["v"]).toBe(5);
    });

    test("applies a returned replacement array, growing and shrinking (#3064)", async () => {
      const m = await server(`
        import { createStore } from "@reactre/core/features/store";
        const [state, setState] = createStore([{ id: "x" }]);
        setState((draft) => [...draft, { id: "y" }]);
        export const grown = [state.length, state[1].id];
        setState(() => [{ id: "z" }]);
        export const shrunk = [state.length, state[0].id];
      `);
      expect(m["grown"]).toEqual([2, "y"]);
      expect(m["shrunk"]).toEqual([1, "z"]);
    });

    test("applies a returned replacement object, dropping absent keys", async () => {
      const m = await server(`
        import { createStore } from "@reactre/core/features/store";
        const [state, setState] = createStore({ a: 1, b: 2 });
        setState(() => ({ a: 10, c: 3 }));
        export const v = [state.a, state.c, "b" in state];
      `);
      expect(m["v"]).toEqual([10, 3, false]);
    });

    test("ignores non-wrappable and self returns", async () => {
      const m = await server(`
        import { createStore } from "@reactre/core/features/store";
        const [state, setState] = createStore({ count: 1 });
        setState(() => 42);
        export const first = state.count;
        setState((s) => s);
        export const second = state.count;
      `);
      expect([m["first"], m["second"]]).toEqual([1, 1]);
    });
  });

  describe("Server optimistic no-ops", () => {
    gap("ssr-semantics", "an optimistic write lands on the server", "createOptimistic writes do not land", async () => {
      const m = await server(`
        import { createOptimistic } from "@reactre/core/features/actions";
        const [value, setValue] = createOptimistic(1);
        setValue(2);
        export const v = value();
      `);
      expect(m["v"]).toBe(1);
    });

    gap(
      "ssr-semantics",
      "an optimistic setter runs its updater on the server",
      "createOptimistic never invokes updaters",
      async () => {
        const m = await server(`
        import { createOptimistic } from "@reactre/core/features/actions";
        const [value, setValue] = createOptimistic(1);
        export let called = 0;
        setValue(() => (called++, 2));
        export const v = value();
      `);
        expect([m["called"], m["v"]]).toEqual([0, 1]);
      },
    );

    gap(
      "ssr-semantics",
      "an optimistic store's setter runs on the server",
      "createOptimisticStore setters do not run or land",
      async () => {
        const m = await server(`
        import { createOptimisticStore } from "@reactre/core/features/actions";
        const [state, setState] = createOptimisticStore([{ id: "x" }]);
        export let called = 0;
        setState((draft) => { called++; draft.push({ id: "y" }); });
        export const length = state.length;
        setState(() => [{ id: "z" }]);
        export const id = state[0].id;
      `);
        expect([m["called"], m["length"], m["id"]]).toEqual([0, 1, "x"]);
      },
    );
  });

  describe("Server reconcile", () => {
    test("reconciles plain objects", async () => {
      // reactre's reconcile gives a setter's function, which writes the draft in place.
      const m = await server(`
        import { reconcile } from "@reactre/core/features/store";
        const target = { a: 1, b: 2 };
        reconcile({ a: 3, c: 4 })(target);
        export const v = [target.a, target.c, target.b];
      `);
      expect(m["v"]).toEqual([3, 4, undefined]);
    });
  });

  describe("Server deep", () => {
    gap("ssr-semantics", "deep() returns a copy, on the server too", "is identity", async () => {
      const m = await server(`
        import { deep } from "@reactre/core/features/store";
        export const obj = { a: 1 };
        export const same = deep(obj) === obj;
      `);
      expect(m["same"]).toBe(true);
    });
  });

  describe("Server mapArray", () => {
    gap("list-functions", "mapArray is missing", "maps array items", () => {
      const mapArray = missing<
        (list: () => number[], fn: (item: number, index: () => number) => string) => () => string[]
      >(serverApi, "mapArray");
      createRoot(() => {
        const mapped = mapArray(
          () => [1, 2, 3],
          (item, index) => `${item}-${index()}`,
        );
        expect(mapped()).toEqual(["1-0", "2-1", "3-2"]);
      });
    });
  });

  describe("Server repeat", () => {
    gap("list-functions", "repeat is missing", "repeats with from offset", () => {
      const repeat = missing<
        (count: () => number, fn: (i: number) => string, options: { from: () => number }) => () => string[]
      >(serverApi, "repeat");
      expect(
        repeat(
          () => 2,
          (i) => `item-${i}`,
          { from: () => 5 },
        )(),
      ).toEqual(["item-5", "item-6"]);
    });
  });

  describe("Server createErrorBoundary", () => {
    test("returns fn result when no error", async () => {
      const html = await str(`
        import { Errored } from "@reactre/core/features/errors";
        export const App = () => <Errored fallback={(err) => "error: " + err}>ok</Errored>;
      `);
      expect(html).toBe("ok");
    });

    test("catches sync errors", async () => {
      const html = await str(`
        import { Errored } from "@reactre/core/features/errors";
        const Boom = () => { throw new Error("boom"); };
        export const App = () => <Errored fallback={(err) => "caught: " + err.message}><Boom /></Errored>;
      `);
      expect(html).toBe("caught: boom");
    });

    test("catches errors thrown from createEffect on the server (#2777)", async () => {
      const html = await str(`
        import { Errored } from "@reactre/core/features/errors";
        import { reaction } from "@reactre/core/features/reaction";
        const Child = () => {
          reaction(() => { throw new Error("server effect boom"); }, () => {});
          return "children";
        };
        export const App = () => <Errored fallback={(err) => "caught: " + err.message}><Child /></Errored>;
      `);
      expect(html).toBe("caught: server effect boom");
    });
  });

  describe("Server createLoadingBoundary", () => {
    test("returns fn result when no async", async () => {
      const html = await str(`
        import { Loading } from "@reactre/core/features/async";
        export const App = () => <Loading fallback="loading">content</Loading>;
      `);
      expect(html).toBe("content");
    });

    test("returns fallback when NotReadyError thrown", async () => {
      // A read of an async memo that has no value yet is what throws the not-ready signal.
      const html = await str(`
        import { Loading, memo } from "@reactre/core/features/async";
        const data = memo(() => new Promise(() => {}));
        const Child = () => <p>{data()}</p>;
        export const App = () => <Loading fallback="loading"><Child /></Loading>;
      `);
      expect(html).toBe("loading");
    });
  });

  describe("Server utilities", () => {
    test("untrack is identity", () => {
      expect(serverApi.untrack(() => 42)).toBe(42);
    });

    test("isPending returns false for sync", async () => {
      const m = await server(`
        import { isPending } from "@reactre/core/features/async";
        export const v = isPending(() => 42);
      `);
      expect(m["v"]).toBe(false);
    });

    gap(
      "ssr-semantics",
      "isPending is false for a first async read, as on the client",
      "isPending propagates NotReadyError from ownerful initial async reads",
      async () => {
        const m = await server(`
        import { isPending, memo, NotReadyError } from "@reactre/core/features/async";
        const data = memo(() => new Promise(() => {}));
        let thrown;
        try { isPending(() => data()); } catch (e) { thrown = e; }
        export const notReady = thrown instanceof NotReadyError;
      `);
        expect(m["notReady"]).toBe(true);
      },
    );

    test("latest passes through", async () => {
      const m = await server(`
        import { latest } from "@reactre/core/features/async";
        export const v = latest(() => 42);
      `);
      expect(m["v"]).toBe(42);
    });

    gap("ssr-semantics", "action() wraps its function on the server too", "action passes through", async () => {
      const m = await server(`
        import { action } from "@reactre/core/features/actions";
        const fn = function* (x) { return x + 1; };
        export const same = action(fn) === fn;
      `);
      expect(m["same"]).toBe(true);
    });

    test("onSettled is no-op", async () => {
      const m = await server(`
        import { onSettled } from "@reactre/core/features/timing";
        let threw = false;
        try { onSettled(() => {}); } catch { threw = true; }
        export const v = threw;
      `);
      expect(m["v"]).toBe(false);
    });
  });

  describe("Server context", () => {
    test("createContext and useContext", async () => {
      const html = await str(`
        import { createContext, useContext } from "@reactre/core/features/context";
        const Ctx = createContext("default");
        export const App = () => <p>{useContext(Ctx)}</p>;
      `);
      expect(html).toBe("<p>default</p>");
    });

    test("default-less createContext throws when read outside a Provider", async () => {
      const m = await server(`
        import { createContext, useContext } from "@reactre/core/features/context";
        const Ctx = createContext();
        export const App = () => <p>{useContext(Ctx)}</p>;
      `);
      expect(() => m.renderToString(m.App)).toThrow();
    });
  });

  describe("Server owner tree", () => {
    test("getOwner returns owner inside createRoot", () => {
      createRoot(() => expect(getOwner()).not.toBeNull());
    });

    test("getOwner returns null outside createRoot", () => {
      expect(getOwner()).toBeNull();
    });

    gap(
      "dispose-order",
      "a root's cleanups run first-registered first, before its children's",
      "cleanup order is unwind: children before owner, later registrations before earlier (#3572)",
      () => {
        const order: string[] = [];
        const dispose = createRoot((d) => {
          onCleanup(() => order.push("A"));
          onCleanup(() => order.push("B"));
          createRoot(() => onCleanup(() => order.push("C")));
          return d;
        });
        dispose();
        expect(order).toEqual(["C", "B", "A"]);
      },
    );

    gap(
      "cleanup-throw",
      "a throwing cleanup stops the teardown",
      "a throwing cleanup does not stop the walk; the first error is rethrown after (#4193)",
      () => {
        const order: string[] = [];
        const dispose = createRoot((d) => {
          onCleanup(() => order.push("A"));
          onCleanup(() => {
            throw new Error("owner threw");
          });
          createRoot(() => {
            onCleanup(() => order.push("C"));
            onCleanup(() => {
              throw new Error("child threw");
            });
          });
          createRoot(() => onCleanup(() => order.push("D")));
          return d;
        });
        expect(dispose).toThrow("child threw");
        expect(order).toEqual(["D", "C", "A"]);
      },
    );

    test("a child cleanup that disposes the root runs once (#3601)", () => {
      let cleanups = 0;
      let dispose!: () => void;
      createRoot((d) => {
        dispose = d;
        createRoot(() =>
          onCleanup(() => {
            cleanups++;
            dispose();
          }),
        );
      });
      dispose();
      expect(cleanups).toBe(1);
    });
  });
});

describe("packages/solid/test/server/flow.spec.ts", () => {
  describe("Server For", () => {
    test("maps array to elements", async () => {
      const html = await str(`
        import { For } from "@reactre/core";
        export const App = () => <ul><For each={[1, 2, 3]} keyed={false}>{(item, index) => <li>{item()}-{index}</li>}</For></ul>;
      `);
      expect(html).toBe("<ul><li>1-0</li><li>2-1</li><li>3-2</li></ul>");
    });

    test("returns fallback for empty array", async () => {
      const html = await str(`
        import { For } from "@reactre/core";
        export const App = () => <ul><For each={[]} key={(x) => x} fallback={<li>empty</li>}>{(item) => <li>{item}</li>}</For></ul>;
      `);
      expect(html).toBe("<ul><li>empty</li></ul>");
    });
  });

  describe("Server Repeat", () => {
    test("repeats count times", async () => {
      const html = await str(`
        import { Repeat } from "@reactre/core";
        export const App = () => <ul><Repeat count={3}>{(i) => <li>item-{i}</li>}</Repeat></ul>;
      `);
      expect(html).toBe("<ul><li>item-0</li><li>item-1</li><li>item-2</li></ul>");
    });
  });

  describe("Server Show", () => {
    test("shows children when truthy", async () => {
      expect(
        await str(`import { Show } from "@reactre/core"; export const App = () => <Show when={true}>visible</Show>;`),
      ).toBe("visible");
    });

    test("shows fallback when falsy", async () => {
      expect(
        await str(
          `import { Show } from "@reactre/core"; export const App = () => <Show when={false} fallback="hidden">visible</Show>;`,
        ),
      ).toBe("hidden");
    });

    test("passes accessor to non-keyed function children", async () => {
      expect(
        await str(
          `import { Show } from "@reactre/core"; export const App = () => <Show when={"hello"}>{(item) => "got: " + item()}</Show>;`,
        ),
      ).toBe("got: hello");
    });

    test("passes raw value to keyed function children", async () => {
      expect(
        await str(
          `import { Show } from "@reactre/core"; export const App = () => <Show when={"hello"} keyed>{(item) => "got: " + item}</Show>;`,
        ),
      ).toBe("got: hello");
    });
  });

  describe("Server Switch/Match", () => {
    test("renders matching case", async () => {
      const html = await str(`
        import { Match, Switch } from "@reactre/core";
        export const App = () => (
          <Switch>
            <Match when={false}>first</Match>
            <Match when={true}>second</Match>
            <Match when={true}>third</Match>
          </Switch>
        );
      `);
      expect(html).toBe("second");
    });

    gap(
      "match-placement",
      "a <Match> stands only directly in a <Switch>",
      "skips nullish child slots from conditionally excluded Matches (#2911)",
      async () => {
        const html = await str(`
        import { Match, Show, Switch } from "@reactre/core";
        export const App = () => (
          <Switch fallback="none">
            <Show when={false}><Match when={true}>excluded</Match></Show>
            <Match when={false}>first</Match>
            <Match when={true}>second</Match>
          </Switch>
        );
      `);
        expect(html).toBe("second");
      },
    );

    test("passes raw value to keyed matching case", async () => {
      const html = await str(`
        import { Match, Switch } from "@reactre/core";
        export const App = () => (
          <Switch>
            <Match when={false}>first</Match>
            <Match when={"second"} keyed>{(value) => value}</Match>
          </Switch>
        );
      `);
      expect(html).toBe("second");
    });

    test("renders fallback when no match", async () => {
      const html = await str(`
        import { Match, Switch } from "@reactre/core";
        export const App = () => <Switch fallback="default"><Match when={false}>first</Match></Switch>;
      `);
      expect(html).toBe("default");
    });
  });

  describe("Server Errored", () => {
    test("renders children when no error", async () => {
      expect(
        await str(
          `import { Errored } from "@reactre/core/features/errors"; export const App = () => <Errored fallback="error">ok</Errored>;`,
        ),
      ).toBe("ok");
    });
  });

  describe("Hydration key alignment", () => {
    gap("owner-ids", "owners have no id", "Show (non-keyed) children run under value memo scope", async () => {
      const m = await server(`
        import { Show } from "@reactre/core";
        import { getOwner } from "@reactre/core/features/owner";
        export const seen = {};
        const Child = () => ((seen.id = getOwner()?.id), "content");
        export const App = () => <Show when={true}><Child /></Show>;
      `);
      m.renderToString(m.App);
      expect((m["seen"] as { id?: string }).id).toBe("t2");
    });

    gap("owner-ids", "owners have no id", "Repeat items run under per-item owners", async () => {
      const m = await server(`
        import { Repeat } from "@reactre/core";
        import { getOwner } from "@reactre/core/features/owner";
        export const ids = [];
        export const App = () => <ul><Repeat count={3}>{(i) => (ids.push(getOwner()?.id), <li>item-{i}</li>)}</Repeat></ul>;
      `);
      expect(m.renderToString(m.App)).toBe("<ul><li>item-0</li><li>item-1</li><li>item-2</li></ul>");
      expect(m["ids"]).toEqual(["t00", "t01", "t02"]);
    });
  });
});

describe("packages/solid/test/server/ssr-async.spec.ts", () => {
  describe("Basic Async (hole path)", () => {
    test("single async memo resolves through hole re-execution", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        let ok;
        const p = new Promise((r) => (ok = r));
        export const resolve = (v) => ok(v);
        const Data = () => {
          const data = memo(() => p);
          return <div>{data()}</div>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
      const r = read(m.renderToStream(m.App));
      await tick();
      // The shell has the fallback, between the markers the content will replace.
      expect(r.chunks[0]).toBe("<!--rr:b0-->Loading...<!--/rr:b0-->");
      (m["resolve"] as (v: string) => void)("Hello World");
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<div>Hello World</div>"]);
    });

    gap(
      "async-signal",
      "signal(fn) of features/memo holds the Promise as its value",
      "createSignal(fn) async value triggers Loading fallback (mirrors createMemo)",
      async () => {
        const m = await server(`
        import { Loading } from "@reactre/core/features/async";
        import { signal } from "@reactre/core/features/memo";
        let ok;
        const p = new Promise((r) => (ok = r));
        export const resolve = (v) => ok(v);
        const Data = () => {
          const [data] = signal(() => p);
          return <div>{data()}</div>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
        const r = read(m.renderToStream(m.App));
        await tick();
        expect(r.chunks[0]).toContain("Loading...");
        (m["resolve"] as (v: string) => void)("Hello World");
        await r.done;
        expect(templates(r.chunks.join(""))).toEqual(["<div>Hello World</div>"]);
      },
    );

    test("synchronous children bypass async path entirely", async () => {
      const html = await str(`
        import { Loading } from "@reactre/core/features/async";
        export const App = () => <Loading fallback="Loading..."><div>Hello</div></Loading>;
      `);
      expect(html).toBe("<div>Hello</div>");
      expect(html).not.toContain("Loading...");
    });
  });

  describe("Parallel Async", () => {
    test("multiple independent async memos resolve in one pass", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        let okA, okB;
        const pA = new Promise((r) => (okA = r)), pB = new Promise((r) => (okB = r));
        export const resolve = () => (okA("Alpha"), okB("Beta"));
        const Data = () => {
          const a = memo(() => pA), b = memo(() => pB);
          return <div>{a()} and {b()}</div>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
      const r = read(m.renderToStream(m.App));
      await tick();
      expect(r.chunks[0]).toContain("Loading...");
      (m["resolve"] as () => void)();
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<div>Alpha and Beta</div>"]);
    });

    test("waits for all memos before re-executing holes", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        let okA, okB;
        const pA = new Promise((r) => (okA = r)), pB = new Promise((r) => (okB = r));
        export const resolveA = () => okA("A");
        export const resolveB = () => okB("B");
        const Data = () => {
          const a = memo(() => pA), b = memo(() => pB);
          return <p>{a()}-{b()}</p>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
      const r = read(m.renderToStream(m.App));
      (m["resolveA"] as () => void)();
      await tick();
      // B is still pending: the boundary's content has not come.
      expect(templates(r.chunks.join(""))).toEqual([]);
      (m["resolveB"] as () => void)();
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<p>A-B</p>"]);
    });
  });

  describe("Nested Boundaries", () => {
    test("inner Loading handles async, outer Loading sees sync children", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        let ok;
        const p = new Promise((r) => (ok = r));
        export const resolve = () => ok("Resolved");
        const Data = () => {
          const data = memo(() => p);
          return <div>{data()}</div>;
        };
        export const App = () => (
          <Loading fallback="Outer loading">
            <Loading fallback="Inner loading"><Data /></Loading>
          </Loading>
        );
      `);
      const r = read(m.renderToStream(m.App));
      await tick();
      expect(r.chunks[0]).toContain("Inner loading");
      expect(r.chunks[0]).not.toContain("Outer loading");
      (m["resolve"] as () => void)();
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<div>Resolved</div>"]);
    });
  });

  describe("Chained Async", () => {
    test("memo depending on async memo resolves in one pass", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        let ok;
        const p = new Promise((r) => (ok = r));
        export const resolve = () => ok(5);
        const Data = () => {
          const base = memo(() => p);
          const doubled = memo(() => base() * 2);
          return <span>{doubled()}</span>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
      const r = read(m.renderToStream(m.App));
      (m["resolve"] as () => void)();
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<span>10</span>"]);
    });
  });

  describe("Conditional Async", () => {
    test("async inside Show when=true propagates through", async () => {
      const m = await server(`
        import { Show } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        let ok;
        const p = new Promise((r) => (ok = r));
        export const resolve = () => ok("shown");
        const Data = () => {
          const data = memo(() => p);
          return <Show when={true}><b>{data()}</b></Show>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
      const r = read(m.renderToStream(m.App));
      await tick();
      expect(r.chunks[0]).toContain("Loading...");
      (m["resolve"] as () => void)();
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<b>shown</b>"]);
    });

    test("async inside Show when=false produces no async", async () => {
      const html = await str(`
        import { Show } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        const data = memo(() => new Promise(() => {}));
        export const App = () => <Loading fallback="Loading..."><Show when={false} fallback={<i>no</i>}><b>{data()}</b></Show></Loading>;
      `);
      expect(html).toBe("<i>no</i>");
    });
  });

  describe("Async in For", () => {
    test("async inside For iterations captured as holes", async () => {
      const m = await server(`
        import { For } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        let ok;
        const p = new Promise((r) => (ok = r));
        export const resolve = () => ok("!");
        const Data = () => {
          const suffix = memo(() => p);
          return <ul><For each={["a", "b"]} key={(x) => x}>{(x) => <li>{x}{suffix()}</li>}</For></ul>;
        };
        export const App = () => <Loading fallback="Loading..."><Data /></Loading>;
      `);
      const r = read(m.renderToStream(m.App));
      await tick();
      expect(r.chunks[0]).toContain("Loading...");
      (m["resolve"] as () => void)();
      await r.done;
      expect(templates(r.chunks.join(""))).toEqual(["<ul><li>a!</li><li>b!</li></ul>"]);
    });
  });

  describe("Error + Async", () => {
    test("Errored inside Loading — sync error caught by Errored", async () => {
      const html = await str(`
        import { Loading } from "@reactre/core/features/async";
        import { Errored } from "@reactre/core/features/errors";
        const Boom = () => { throw new Error("sync boom"); };
        export const App = () => (
          <Loading fallback="Loading...">
            <Errored fallback={(e) => <span>{e.message}</span>}><Boom /></Errored>
          </Loading>
        );
      `);
      expect(html).toBe("<span>sync boom</span>");
    });

    test("Errored inside Loading — async rejection resolves to error fallback HTML", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        import { Errored } from "@reactre/core/features/errors";
        let no;
        const p = new Promise((_, r) => (no = r));
        export const reject = () => no(new Error("async boom"));
        const Data = () => {
          const data = memo(() => p);
          return <p>{data()}</p>;
        };
        export const App = () => (
          <Loading fallback="Loading...">
            <Errored fallback={(e) => <span>{e.message}</span>}><Data /></Errored>
          </Loading>
        );
      `);
      const r = read(m.renderToStream(m.App));
      (m["reject"] as () => void)();
      await r.done;
      expect(r.error).toBeUndefined();
      expect(templates(r.chunks.join(""))).toEqual(["<span>async boom</span>"]);
    });

    test("No Errored — sync error during initial render propagates up", async () => {
      const m = await server(`
        const Boom = () => { throw new Error("unhandled"); };
        export const App = () => <div><Boom /></div>;
      `);
      expect(() => m.renderToString(m.App)).toThrow("unhandled");
    });
  });
});

describe("packages/web/test/server/ssr-stream.spec.tsx", () => {
  describe("SSR Streaming — No Loading Boundary", () => {
    test("top-level async memo blocks the shell", async () => {
      const { shell } = await collect(
        await server(`
        import { memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("TopLevel"), 20)));
          return <div><p>{data()}</p></div>;
        }
      `),
      );
      expect(shell).toContain("TopLevel");
    });

    test("top-level async memo resolves in .then() path", async () => {
      const m = await server(`
        import { memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("Resolved"), 10)));
          return <p>{data()}</p>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p>Resolved</p>");
    });

    test("top-level isPending guard follows Loading path without boundary", async () => {
      const { shell } = await collect(
        await server(`
        import { isPending, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("Ready"), 10)));
          return <button disabled={isPending(data)}>{data()}</button>;
        }
      `),
      );
      expect(shell).toContain("<button");
      expect(shell).toContain("Ready");
      expect(shell).not.toContain("disabled");
    });

    test("async memo above Loading boundary blocks shell, inner streams", async () => {
      const { shell, full } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const outer = memo(() => new Promise((r) => setTimeout(() => r("Outer"), 10)));
          const inner = memo(() => new Promise((r) => setTimeout(() => r("Inner"), 40)));
          return (
            <div>
              <h1>{outer()}</h1>
              <Loading fallback={<span>Loading inner...</span>}><p>{inner()}</p></Loading>
            </div>
          );
        }
      `),
      );
      expect(shell).toContain("Outer");
      expect(shell).toContain("Loading inner...");
      expect(full).toContain("Inner");
    });

    test("multiple top-level async memos all block the shell", async () => {
      const { shell } = await collect(
        await server(`
        import { memo } from "@reactre/core/features/async";
        export function App() {
          const a = memo(() => new Promise((r) => setTimeout(() => r("Alpha"), 5)));
          const b = memo(() => new Promise((r) => setTimeout(() => r("Beta"), 20)));
          return <div><p>{a()}</p><p>{b()}</p></div>;
        }
      `),
      );
      expect(shell).toContain("Alpha");
      expect(shell).toContain("Beta");
    });
  });

  describe("SSR Streaming — Basic Rendering", () => {
    test("sync component renders to HTML", async () => {
      const { full } = await collect(await server(`export const App = () => <div><h1>Hello</h1><p>World</p></div>;`));
      expect(full).toBe("<div><h1>Hello</h1><p>World</p></div>");
    });

    test("isPending guard follows Loading path inside Loading boundary", async () => {
      const { shell, full } = await collect(
        await server(`
        import { isPending, Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("Ready"), 10)));
          return (
            <Loading fallback={<button disabled>Loading...</button>}>
              <button disabled={isPending(data)}>{data()}</button>
            </Loading>
          );
        }
      `),
      );
      expect(shell).toContain("<button");
      expect(shell).toContain("disabled");
      expect(shell).toContain("Loading...");
      expect(full).toContain("Ready");
    });

    test("bare async memo as direct Loading child (issue #2677)", async () => {
      const { shell, full } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("Bare Data"), 10)));
          return <div><Loading fallback={<span>Loading...</span>}>{data()}</Loading></div>;
        }
      `),
      );
      expect(shell).toContain("Loading...");
      expect(full).toContain("Bare Data");
    });

    test("bare rejected async memo under Errored inside Loading resolves to error fallback", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        import { Errored } from "@reactre/core/features/errors";
        export function App() {
          const data = memo(() => Promise.reject(new Error("boom")));
          return (
            <div>
              <Loading fallback={<span>Pending</span>}>
                <Errored fallback={(e) => <span>err: {e.message}</span>}>{data().title}</Errored>
              </Loading>
            </div>
          );
        }
      `);
      const html = await m.renderToStringAsync(m.App);
      expect(html).toContain("err:");
      expect(html).toContain("boom");
    });

    test("async memo — shell contains fallback, final has resolved value", async () => {
      const { shell, full } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("Resolved"), 20)));
          return <div><Loading fallback={<span>Fallback</span>}><p>{data()}</p></Loading></div>;
        }
      `),
      );
      expect(shell).toContain("Fallback");
      expect(full).toContain("Resolved");
      expect(full).toContain("<template");
    });

    test("parallel async boundaries", async () => {
      const { shell, full } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const fast = memo(() => new Promise((r) => setTimeout(() => r("Fast"), 5)));
          const slow = memo(() => new Promise((r) => setTimeout(() => r("Slow"), 30)));
          return (
            <div>
              <Loading fallback={<span>Loading fast...</span>}><p>{fast()}</p></Loading>
              <Loading fallback={<span>Loading slow...</span>}><p>{slow()}</p></Loading>
            </div>
          );
        }
      `),
      );
      expect(shell).toContain("Loading fast...");
      expect(shell).toContain("Loading slow...");
      expect(full).toContain("Fast");
      expect(full).toContain("Slow");
    });

    test("nested Loading boundaries", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const outer = memo(() => new Promise((r) => setTimeout(() => r("Outer"), 10)));
          const inner = memo(() => new Promise((r) => setTimeout(() => r("Inner"), 20)));
          return (
            <Loading fallback={<span>Outer loading</span>}>
              <div>
                <p>{outer()}</p>
                <Loading fallback={<span>Inner loading</span>}><p>{inner()}</p></Loading>
              </div>
            </Loading>
          );
        }
      `);
      const html = await m.renderToStringAsync(m.App);
      expect(html).toBe("<div><p>Outer</p><p>Inner</p></div>");
    });
  });

  describe("SSR Streaming — deferStream", () => {
    gap("memo-options", "a memo has no deferStream option", "deferStream blocks the shell until resolved", async () => {
      const { shell } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r("Deferred"), 10)), { deferStream: true });
          return <div><Loading fallback={<span>Fallback</span>}><p>{data()}</p></Loading></div>;
        }
      `),
      );
      expect(shell).toContain("Deferred");
      expect(shell).not.toContain("Fallback");
    });
  });

  describe("SSR Streaming — Error Handling", () => {
    gap(
      "hydration",
      "an error after the shell is not serialized for the client's boundary",
      "error in async computation caught by Errored boundary",
      async () => {
        const { shell, full, error } = await collect(
          await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        import { Errored } from "@reactre/core/features/errors";
        export function App() {
          const data = memo(async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error("Boom"); });
          return (
            <Errored fallback={(err) => <span>Error: {String(err)}</span>}>
              <Loading fallback={<span>Loading...</span>}><p>{data()}</p></Loading>
            </Errored>
          );
        }
      `),
        );
        expect(shell).toContain("Loading...");
        expect(shell).not.toContain("Boom");
        expect(error).toBeUndefined();
        expect(full).toContain('new Error("Boom")');
      },
    );

    test("stream completes after error (no hang)", async () => {
      const { full, error } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        import { Errored } from "@reactre/core/features/errors";
        export function App() {
          const data = memo(async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error("fail"); });
          return (
            <Loading fallback={<span>Loading...</span>}>
              <Errored fallback={<span>Caught</span>}><p>{data()}</p></Errored>
            </Loading>
          );
        }
      `),
      );
      expect(error).toBeUndefined();
      expect(full).toContain("Caught");
    });
  });

  describe("SSR Streaming — Flow Controls", () => {
    test("Show with async memo", async () => {
      const m = await server(`
        import { Show } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r(true), 5)));
          return <Loading fallback="Loading..."><Show when={data()} fallback={<p>No</p>}><p>Yes</p></Show></Loading>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p>Yes</p>");
    });

    test("For with async items", async () => {
      const m = await server(`
        import { For } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const items = memo(() => new Promise((r) => setTimeout(() => r(["A", "B", "C"]), 5)));
          return <Loading fallback="Loading..."><ul><For each={items()} key={(x) => x}>{(item) => <li>{item}</li>}</For></ul></Loading>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<ul><li>A</li><li>B</li><li>C</li></ul>");
    });

    test("Switch/Match with async memo", async () => {
      const m = await server(`
        import { Match, Switch } from "@reactre/core";
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const status = memo(() => new Promise((r) => setTimeout(() => r("success"), 5)));
          return (
            <Loading fallback="Loading...">
              <Switch fallback={<p>Unknown</p>}>
                <Match when={status() === "success"}><p>Success!</p></Match>
                <Match when={status() === "error"}><p>Error!</p></Match>
              </Switch>
            </Loading>
          );
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p>Success!</p>");
    });
  });

  describe("SSR Streaming — Multiple Async in One Boundary", () => {
    test("two async memos in one Loading — shell shows fallback, stream has both", async () => {
      const { shell, full } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const a = memo(() => new Promise((r) => setTimeout(() => r("First"), 5)));
          const b = memo(() => new Promise((r) => setTimeout(() => r("Second"), 15)));
          return <Loading fallback={<span>Loading...</span>}><p>{a()}</p><p>{b()}</p></Loading>;
        }
      `),
      );
      expect(shell).toContain("Loading...");
      expect(templates(full)).toEqual(["<p>First</p><p>Second</p>"]);
    });
  });

  describe("SSR Streaming — Chained Async", () => {
    test("sync memo derived from async memo resolves", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const base = memo(() => new Promise((r) => setTimeout(() => r(10), 5)));
          const doubled = memo(() => base() * 2);
          return <Loading fallback="Loading..."><p>{doubled()}</p></Loading>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p>20</p>");
    });
  });

  describe("SSR Streaming — Edge Cases", () => {
    test("fast async resolves before shell flush (0ms)", async () => {
      const { full } = await collect(
        await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => Promise.resolve("Instant"));
          return <Loading fallback={<span>Loading...</span>}><p>{data()}</p></Loading>;
        }
      `),
      );
      expect(full).toContain("Instant");
    });

    test("async resolving to null renders empty", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r(null), 5)));
          return <Loading fallback="Loading..."><p>{data()}</p></Loading>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p></p>");
    });

    test("async resolving to undefined renders empty", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r(undefined), 5)));
          return <Loading fallback="Loading..."><p>{data()}</p></Loading>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p></p>");
    });

    test("async resolving to empty string renders empty", async () => {
      const m = await server(`
        import { Loading, memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise((r) => setTimeout(() => r(""), 5)));
          return <Loading fallback="Loading..."><p>{data()}</p></Loading>;
        }
      `);
      expect(await m.renderToStringAsync(m.App)).toBe("<p></p>");
    });
  });

  describe("renderToString — Sync Rendering", () => {
    test("nested sync components", async () => {
      const html = await str(`
        const Inner = (props) => <span>{props.text}</span>;
        const Outer = () => <div><Inner text="hello" /><Inner text="world" /></div>;
        export const App = () => <Outer />;
      `);
      expect(html).toBe("<div><span>hello</span><span>world</span></div>");
    });

    test("sync flow controls render correctly", async () => {
      const html = await str(`
        import { For, Show } from "@reactre/core";
        export const App = () => (
          <div>
            <Show when={true}><p>shown</p></Show>
            <ul><For each={["a", "b"]} key={(x) => x}>{(x) => <li>{x}</li>}</For></ul>
          </div>
        );
      `);
      expect(html).toBe("<div><p>shown</p><ul><li>a</li><li>b</li></ul></div>");
    });

    gap(
      "ssr-semantics",
      "an async read outside every <Loading> renders nothing",
      "throws on async content without Loading boundary",
      async () => {
        const m = await server(`
        import { memo } from "@reactre/core/features/async";
        export function App() {
          const data = memo(() => new Promise(() => {}));
          return <p>{data()}</p>;
        }
      `);
        expect(() => m.renderToString(m.App)).toThrow();
      },
    );
  });
});

describe("packages/web/test/server/ssr-class.spec.tsx and ssr-class-style-separators.spec.tsx", () => {
  test("dynamic numeric class matches the static form", async () => {
    expect(
      await str(
        `import { signal } from "@reactre/core"; const [v] = signal(1); export const App = () => <div class={v()} />;`,
      ),
    ).toBe('<div class="1"></div>');
  });

  test("dynamic zero class matches the static form", async () => {
    expect(
      await str(
        `import { signal } from "@reactre/core"; const [v] = signal(0); export const App = () => <div class={v()} />;`,
      ),
    ).toBe('<div class="0"></div>');
  });

  gap(
    "class-values",
    "an array from an expression is written as its string",
    "standalone booleans in arrays are ignored",
    async () => {
      expect(
        await str(
          `import { signal } from "@reactre/core"; const [v] = signal([true, false, "active"]); export const App = () => <div class={v()} />;`,
        ),
      ).toBe('<div class="active"></div>');
    },
  );

  gap(
    "class-values",
    "an object from an expression is written as its string",
    "a skipped first class key leaves no leading space",
    async () => {
      expect(
        await str(
          `import { signal } from "@reactre/core"; const [v] = signal({ off: false, on: true }); export const App = () => <div class={v()} />;`,
        ),
      ).toBe('<div class="on"></div>');
    },
  );

  test("a skipped first style key leaves no leading semicolon", async () => {
    expect(
      await str(
        `import { signal } from "@reactre/core"; const [v] = signal({ color: undefined, top: "1px" }); export const App = () => <div style={v()} />;`,
      ),
    ).toBe('<div style="top:1px"></div>');
  });
});

describe("packages/web/test/server/ssr-element-nullish-attrs.spec.tsx and ssr-element-names.spec.tsx", () => {
  test("through a spread and through a dynamic() tag", async () => {
    const m = await server(`
      import { dynamic } from "@reactre/core/features/dynamic";
      const props = { style: undefined, class: undefined, "data-x": "1" };
      const Button = dynamic(() => "button");
      export const Spread = () => <button {...props} />;
      export const App = () => <Button {...props} />;
    `);
    expect(m.renderToString(m["Spread"] as () => unknown)).toBe('<button data-x="1"></button>');
    expect(m.renderToString(m.App)).toBe('<button data-x="1"></button>');
  });

  test("through a compiled spread", async () => {
    expect(
      await str(`
        const props = { "a b": "v", 'a"b': true, "x><script>alert(1)</script": "", "data-ok": "1" };
        export const App = () => <div {...props} />;
      `),
    ).toBe('<div data-ok="1"></div>');
  });

  test("a tag that is not one HTML element name throws, on every render", async () => {
    const m = await server(`
      import { Dynamic } from "@reactre/core";
      import { signal } from "@reactre/core";
      const [tag] = signal("div x");
      export const App = () => <Dynamic component={tag()} />;
    `);
    expect(() => m.renderToString(m.App)).toThrow("is not a valid tag name");
  });

  test("custom elements and case-sensitive SVG names render", async () => {
    const m = await server(`
      import { Dynamic } from "@reactre/core";
      export const App = () => <Dynamic component="my-widget" data-x="1" />;
      export const Svg = () => <Dynamic component="foreignObject" />;
    `);
    expect(m.renderToString(m.App)).toBe('<my-widget data-x="1"></my-widget>');
    expect(m.renderToString(m["Svg"] as () => unknown)).toBe("<foreignObject></foreignObject>");
  });
});

describe("packages/web/test/server/ssr-text-separators.spec.tsx", () => {
  test("dynamic() tag instances in a list get no separator", async () => {
    const m = await server(`
      import { dynamic } from "@reactre/core/features/dynamic";
      const Span = dynamic(() => "span");
      export const App = () => <div>{[1, 2].map((i) => <Span>{i}</Span>)}</div>;
    `);
    expect(m.renderToString(m.App, { hydrate: true }).replace(/<!--\[-->|<!--]-->/g, "")).toBe(
      "<div><span>1</span><span>2</span></div>",
    );
  });

  gap(
    "array-text",
    "the array is written as its string, on the server as on the client",
    "adjacent memos that yield text are separated",
    async () => {
      const m = await server(`
      import { memo } from "@reactre/core";
      export const App = () => <div>{["a", "b"].map((s) => memo(() => s)())}</div>;
    `);
      expect(m.renderToString(m.App, { hydrate: true }).replace(/<!--\[-->|<!--]-->/g, "")).toBe(
        "<div>a<!---->b</div>",
      );
    },
  );

  test("text on either side of an element is not separated from it", async () => {
    const m = await server(`export const App = () => <div>{["a", <b>x</b>, "c"]}</div>;`);
    expect(m.renderToString(m.App)).toBe("<div>a<b>x</b>c</div>");
  });
});

describe("packages/web/test/server/escape-late-values.spec.tsx", () => {
  const XSS = `x <script>alert(1)</script> y & A > B "q"`;
  const ESCAPED = serverApi.escape(XSS);

  test("string produced by a flow-control memo is escaped (the report)", async () => {
    const m = await server(`
      import { Show } from "@reactre/core";
      import { dynamic } from "@reactre/core/features/dynamic";
      const XSS = ${JSON.stringify(XSS)};
      const Text = () => XSS;
      const DynText = dynamic(() => Text);
      export const Direct = () => <div><Text /></div>;
      export const Dyn = () => <div><DynText /></div>;
      export const App = () => <div><Show when={true}><Text /></Show></div>;
    `);
    for (const name of ["Direct", "Dyn", "App"])
      expect(m.renderToString(m[name] as () => unknown)).toBe(`<div>${ESCAPED}</div>`);
    expect(ESCAPED).not.toContain("<script>");
  });

  test("arrays a memo yields are escaped item-wise, nodes untouched", async () => {
    const m = await server(`
      import { dynamic } from "@reactre/core/features/dynamic";
      const XSS = ${JSON.stringify(XSS)};
      const Rows = () => [XSS, <b>{XSS}</b>, 7, null, XSS];
      const DynRows = dynamic(() => Rows);
      export const App = () => <div><DynRows /></div>;
    `);
    expect(m.renderToString(m.App)).toBe(`<div>${ESCAPED}<b>${ESCAPED}</b>7${ESCAPED}</div>`);
  });

  test("top-level render of a bare string escapes", async () => {
    const m = await server(`
      import { Show } from "@reactre/core";
      const XSS = ${JSON.stringify(XSS)};
      export const Bare = () => XSS;
      export const App = () => <Show when={true}>{XSS}</Show>;
    `);
    expect(m.renderToString(m["Bare"] as () => unknown)).toBe(ESCAPED);
    expect(m.renderToString(m.App)).toBe(ESCAPED);
  });

  test("template holes inside flow controls escape exactly once", async () => {
    const m = await server(`
      import { Show } from "@reactre/core";
      const s = "<b>&</b>";
      export const App = () => <Show when={true}><p>{s}</p></Show>;
    `);
    expect(m.renderToString(m.App)).toBe("<p>&lt;b&gt;&amp;&lt;/b&gt;</p>");
  });
});
