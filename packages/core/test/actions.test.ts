// @reactre/core/features/actions, on the unbundled runtime (the core's sources, async code in):
// actions, optimistic signals and stores, affects and until. Like async.test.ts, it turns the
// async runtime on for its own tests and off after them.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import {
  action,
  affects,
  createOptimistic,
  createOptimisticStore,
  TimeoutError,
  until,
} from "../src/features/actions.ts";
import * as asyncApi from "../src/features/async.ts";
import { __hooks, isPending, memo, NotReadyError, refresh } from "../src/features/async.ts";
import * as context from "../src/features/context.ts";
import { createStore } from "../src/features/store.ts";
import * as core from "../src/index.ts";
import { effect, signal } from "../src/index.ts";

beforeAll(() => core.__installAsync(__hooks));
afterAll(() => core.__installAsync(false));
beforeEach(installFakeDocument);

/** A Promise with its resolve and reject. */
function deferred<T>(): { p: Promise<T>; ok: (v: T) => void; no: (e: unknown) => void } {
  let ok!: (v: T) => void, no!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((ok = a), (no = b)));
  return { p, ok, no };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("action", () => {
  test("an optimistic write shows at once and reverts when the action's transition ends", async () => {
    const [likes, setLikes] = createOptimistic(0);
    const seen: number[] = [];
    effect(() => void seen.push(likes()));
    const server = deferred<string>();
    const like = action(function* (by: number) {
      setLikes((n) => n + by);
      const r = (yield server.p) as string;
      return r + by;
    });
    const done = like(2);
    expect(likes()).toBe(2);
    server.ok("ok");
    expect(await done).toBe("ok2");
    expect(seen).toEqual([0, 2, 0]);
  });

  test("a write outside an action sets the base; a second write in one action keeps its override", async () => {
    const [v, setV] = createOptimistic("a");
    setV("b");
    expect(v()).toBe("b");
    const go = action(function* () {
      setV("c");
      setV((x) => x + "!");
      yield 0;
      expect(v()).toBe("c!");
    });
    await go();
    expect(v()).toBe("b");
  });

  test("a derived optimistic value: a write outside an action holds until its function runs again", async () => {
    const [src, setSrc] = signal(1);
    const [v, setV] = createOptimistic(() => src() * 10);
    expect(v()).toBe(10);
    setV(5);
    expect(v()).toBe(5);
    setSrc(2);
    expect(v()).toBe(20);
  });

  test("a rejected yield is thrown in; a throw from the generator rejects, and its writes revert", async () => {
    const [v, setV] = createOptimistic(0);
    const caught = action(function* () {
      try {
        yield Promise.reject(new Error("net"));
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(await caught()).toBe("net");
    const fails = action(function* () {
      setV(9);
      yield 0;
      throw new Error("bad");
    });
    const p = fails();
    expect(v()).toBe(9);
    await expect(p).rejects.toThrow("bad");
    expect(v()).toBe(0);
    const early = action(function* (): Generator<unknown, void> {
      throw new Error("at once");
    });
    await expect(early()).rejects.toThrow("at once");
  });

  test("an async generator: its yields are awaited; its rejection rejects", async () => {
    const [v, setV] = createOptimistic(0);
    const go = action(async function* () {
      setV(1);
      const x = (yield Promise.resolve(2)) as number;
      setV(x);
      return x * 2;
    });
    const p = go();
    expect(v()).toBe(1);
    expect(await p).toBe(4);
    expect(v()).toBe(0);
    const bad = action(async function* (): AsyncGenerator<unknown, void> {
      yield 1;
      throw new Error("async bad");
    });
    await expect(bad()).rejects.toThrow("async bad");
  });

  test("a refresh in an action joins its transition: what it re-runs waits for the action's end", async () => {
    let calls = 0;
    const ds = [deferred<string>(), deferred<string>()];
    const data = memo(() => ds[calls++]!.p);
    const seen: string[] = [];
    effect(() => void seen.push(data()));
    ds[0]!.ok("a");
    await tick();
    const gate = deferred<void>();
    const go = action(function* () {
      refresh(data);
      yield gate.p;
    });
    const p = go();
    ds[1]!.ok("b");
    await tick();
    expect(seen).toEqual(["a"]);
    expect(data()).toBe("b");
    gate.ok();
    await p;
    expect(seen).toEqual(["a", "b"]);
  });

  test("an action called in another's code settles as it returns, so the other can yield it", async () => {
    const [v, setV] = createOptimistic(0);
    const seen: number[] = [];
    effect(() => void seen.push(v()));
    const log: string[] = [];
    const inner = action(function* (fail: boolean) {
      setV((n) => n + 10);
      yield Promise.resolve();
      if (fail) throw new Error("inner failed");
      return "inner";
    });
    const outer = action(function* () {
      setV(1);
      log.push((yield inner(false)) as string);
      try {
        yield inner(true);
      } catch (e) {
        log.push((e as Error).message);
      }
      // The inner actions' optimistic writes show until the shared transition ends.
      log.push("v " + v());
      return "outer";
    });
    expect(await outer()).toBe("outer");
    expect(log).toEqual(["inner", "inner failed", "v 21"]);
    // Reverted together, at the end.
    expect(v()).toBe(0);
    expect(seen.at(-1)).toBe(0);
    // Called outside an action's code, its Promise still settles when the transition ends.
    const gate = deferred<void>();
    const order: string[] = [];
    const slow = action(function* () {
      yield gate.p;
    });
    const quick = action(function* () {
      yield Promise.resolve();
    });
    const a = slow().then(() => order.push("slow")),
      b = quick().then(() => order.push("quick"));
    await tick();
    expect(order).toEqual([]);
    gate.ok();
    await Promise.all([a, b]);
    expect(order.sort()).toEqual(["quick", "slow"]);
  });
});

describe("createOptimisticStore", () => {
  test("a value store: writes in an action revert, writes outside are the store's", async () => {
    const [s, set] = createOptimisticStore({ todos: [{ id: 1, title: "a" }] });
    const seen: string[] = [];
    effect(() => void seen.push(s.todos.map((t) => t.title).join()));
    set((d) => {
      d.todos.push({ id: 2, title: "b" });
    });
    const add = action(function* () {
      set((d) => {
        d.todos.push({ id: -1, title: "new" });
      });
      set(() => ({ todos: [{ id: 9, title: "replaced" }] }));
      yield 0;
    });
    const p = add();
    expect(seen.at(-1)).toBe("replaced");
    await p;
    expect(seen.at(-1)).toBe("a,b");
    expect("todos" in s).toBe(true);
    expect(Object.keys(s)).toEqual(["todos"]);
    await refresh(s);
  });

  test("a derived store from an async function: reads wait for its first value; refresh fetches again", async () => {
    const root = new FakeElement("DIV");
    let calls = 0;
    const ds = [deferred<{ id: number; t: string }[]>(), deferred<{ id: number; t: string }[]>()];
    const [todos, setTodos] = createOptimisticStore(() => ds[calls++]!.p, [] as { id: number; t: string }[]);
    const runtime = { ...core, ...context, ...asyncApi, todos, setTodos };
    const js = compileSource(`
      import { For, render } from "@reactre/core";
      import { Loading } from "@reactre/core/features/async";
      render(() => <div><Loading fallback="..."><ul><For each={[...todos]} key={(t) => t.id}>{(t) => <li>{t.t.trim()}</li>}</For></ul></Loading></div>, root);
    `).replace(/^import \{([^}]*)\} from "@reactre\/core(?:\/features\/\w+)?";$/gm, (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
    );
    new Function("rr", "root", "todos", js)(runtime, root, todos);
    expect(text(root)).toBe("...");
    expect(() => todos.length).toThrow(NotReadyError);
    ds[0]!.ok([{ id: 1, t: "a" }]);
    await tick();
    expect(text(root)).toBe("a");
    const done = refresh(todos);
    ds[1]!.ok([
      { id: 1, t: "a" },
      { id: 2, t: "b" },
    ]);
    await done;
    await tick();
    expect(text(root)).toBe("ab");
    // A write outside an action goes to the derived base, until it runs again.
    setTodos((d) => {
      d.push({ id: 3, t: "c" });
    });
    expect(text(root)).toBe("abc");
  });

  test("compiled, it is a store root: `each={todos}` and `{t.t}` follow optimistic writes and their revert", async () => {
    const root = new FakeElement("DIV");
    const runtime = { ...core, ...context, ...asyncApi, createOptimisticStore, action };
    const js = compileSource(`
      import { For, render } from "@reactre/core";
      import { action, createOptimisticStore } from "@reactre/core/features/actions";
      const [todos, setTodos] = createOptimisticStore([{ id: 1, t: "a" }]);
      render(() => <ul><For each={todos} key={(t) => t.id}>{(t) => <li>{t.t}</li>}</For></ul>, root);
      let confirm;
      globalThis.__edit = action(function* () {
        setTodos((d) => {
          d[0].t = "z";
          d.push({ id: 2, t: "b" });
        });
        yield new Promise((ok) => (confirm = ok));
      });
      globalThis.__confirm = () => confirm();
    `).replace(/^import \{([^}]*)\} from "@reactre\/core(?:\/features\/\w+)?";$/gm, (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
    );
    expect(js).toContain("each: () => ([...(todos)])");
    new Function("rr", "root", js)(runtime, root);
    const g = globalThis as unknown as { __edit: () => Promise<void>; __confirm: () => void };
    expect(text(root)).toBe("a");
    const done = g.__edit();
    expect(text(root)).toBe("zb");
    g.__confirm();
    await done;
    expect(text(root)).toBe("a");
  });

  test("a derived store from a draft-changing function, with a key of its own", () => {
    const [n, setN] = signal(1);
    const [s] = createOptimisticStore<{ n: number }>(
      (d) => {
        d.n = n();
      },
      { n: 0 },
      { key: null },
    );
    expect(s.n).toBe(1);
    setN(2);
    expect(s.n).toBe(2);
  });
});

describe("affects", () => {
  test("marks a signal, a store key and a whole store pending until the transition ends", async () => {
    const [v] = signal(1);
    const [s] = createStore({ a: 1, b: 2 });
    const [o] = createOptimisticStore({ x: 1 });
    const flags: boolean[][] = [];
    effect(
      () => void flags.push([isPending(() => v()), isPending(() => s.a), isPending(() => s.b), isPending(() => o.x)]),
    );
    const gate = deferred<void>();
    const go = action(function* () {
      affects(v);
      affects(s, "a");
      affects(o);
      yield gate.p;
    });
    const p = go();
    expect(flags.at(-1)).toEqual([true, true, false, true]);
    gate.ok();
    await p;
    expect(flags.at(-1)).toEqual([false, false, false, false]);
    expect(() => affects(v)).toThrow("call it in an action's code");
  });

  test("a target whose read is not ready marks what it read", async () => {
    const d = deferred<number>();
    const m = memo(() => d.p);
    const go = action(function* () {
      affects(m);
      yield 0;
    });
    await go();
    d.ok(1);
    expect(() =>
      core.__capture(() => {
        throw new Error("passes");
      }),
    ).toThrow("passes");
  });
});

describe("until", () => {
  test("resolves with the first truthy value, reading optimistic values as their base", async () => {
    const [confirmed, setConfirmed] = signal<number[]>([]);
    const [mine, setMine] = createOptimistic<number[]>([]);
    const [opt, setOpt] = createOptimisticStore({ ids: [] as number[] });
    let saw: number[] | undefined;
    const send = action(function* (id: number) {
      setMine((l) => [...l, id]);
      setOpt((d) => {
        d.ids.push(id);
      });
      saw = (yield until(() =>
        mine().includes(id) || opt.ids.includes(id) ? null : confirmed().includes(id) && confirmed(),
      )) as number[];
    });
    const p = send(7);
    expect(mine()).toEqual([7]);
    expect(opt.ids).toEqual([7]);
    setConfirmed([7]);
    await p;
    expect(saw).toEqual([7]);
  });

  test("waits through a read that is not ready", async () => {
    const d = deferred<number>();
    const m = memo(() => d.p);
    const p = until(() => m() > 1);
    d.ok(2);
    expect(await p).toBe(true);
  });

  test("rejects on a throw, a timeout, or an abort", async () => {
    await expect(
      until(() => {
        throw new Error("pred");
      }),
    ).rejects.toThrow("pred");
    const [never] = signal(false);
    const t = until(never, { timeout: 1 });
    await expect(t).rejects.toBeInstanceOf(TimeoutError);
    await expect(until(never, { timeout: 1 })).rejects.toThrow("did not come true in time");
    const c = new AbortController();
    const a = until(never, { signal: c.signal });
    c.abort(new Error("stop"));
    await expect(a).rejects.toThrow("stop");
    await expect(until(never, { signal: AbortSignal.abort(new Error("before")) })).rejects.toThrow("before");
    expect(await until(() => 3, { timeout: 1000, signal: new AbortController().signal })).toBe(3);
  });
});

describe("without features/async's boundaries", () => {
  test("a read not ready under actions alone waits on its own", async () => {
    core.__installAsync(false);
    core.__installAsync();
    try {
      const d = deferred<number>();
      const m = memo(() => d.p);
      const seen: number[] = [];
      effect(() => void seen.push(m()));
      d.ok(1);
      await tick();
      expect(seen).toEqual([1]);
    } finally {
      core.__installAsync(__hooks);
    }
  });
});

const text = (n: FakeElement): string => n.textContent ?? "";
