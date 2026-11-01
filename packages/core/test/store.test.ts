// Stores (@reactre/core/features/store) on the unbundled runtime: what a read subscribes to, how
// the setter's draft writes, derived stores, reconcile, snapshot and deep, merge and omit, and
// how stores behave in compiled TSX, outside lists and in <For> rows. TSX sources here are
// compiled as the plugin compiles them.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import * as forApi from "../src/features/for.ts";
import { createRoot } from "../src/features/owner.ts";
import * as store from "../src/features/store.ts";
import { createProjection, createStore, deep, merge, omit, path, reconcile, snapshot } from "../src/features/store.ts";
import * as core from "../src/index.ts";
import { batch, effect, signal } from "../src/index.ts";

/** What a source's imports of @reactre/core and of its store feature bind to. */
const runtime = { ...core, ...store, ...forApi };

beforeEach(installFakeDocument);

/** Compile a TSX module body ending in `return { ... }` and run it, `root` in scope. */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src)
    .replace(/^import \{([^}]*)\} from "@reactre\/core(?:\/features\/(?:store|for))?";$/gm, (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
    )
    .replace(/^import \* as (\w+) from "@reactre\/core(?:\/features\/store)?";$/gm, "const $1 = rr;");
  return new Function("rr", "root", js)(runtime, root) as T;
}

/** A root inside a fake document. */
const box = (): FakeElement => {
  const doc = new FakeElement("HTML");
  doc.isDocument = true;
  const root = new FakeElement("DIV");
  doc.appendChild(root);
  return root;
};

/** How many times `fn` has run, as an effect: it runs once now. */
function runs(fn: () => unknown): () => number {
  let n = 0;
  effect(() => {
    fn();
    n++;
  });
  return () => n;
}

type Todo = { id: number; title: string; done: boolean };

describe("reads", () => {
  test("a read subscribes to that property alone, at any depth", () => {
    const [s, set] = createStore({ a: 1, b: 2, user: { name: "ann", age: 3 } });
    const a = runs(() => s.a),
      name = runs(() => s.user.name);
    set((d) => {
      d.b = 3;
      d.user.age = 4;
    });
    expect([a(), name()]).toEqual([1, 1]);
    set((d) => {
      d.a = 2;
    });
    set((d) => {
      d.user.name = "bob";
    });
    expect([a(), name()]).toEqual([2, 2]);
    expect(s.user.name).toBe("bob");
    // An identical write re-runs nothing.
    set((d) => {
      d.a = 2;
    });
    expect(a()).toBe(2);
  });

  test("arrays are followed by index and by length", () => {
    const [s, set] = createStore({ list: [{ id: 1, title: "a", done: false }] as Todo[] });
    const first = runs(() => s.list[0]?.title),
      len = runs(() => s.list.length),
      all = runs(() => s.list.map((t) => t.title).join());
    set((d) => {
      d.list.push({ id: 2, title: "b", done: false });
    });
    expect([first(), len(), all()]).toEqual([1, 2, 2]);
    set((d) => {
      d.list[1]!.title = "B";
    });
    expect([first(), len(), all()]).toEqual([1, 2, 3]);
    set((d) => {
      d.list.splice(0, 1);
    });
    expect([first(), len(), all()]).toEqual([2, 3, 4]);
    expect(s.list.map((t) => t.title)).toEqual(["B"]);
    // Cutting the length re-runs what read the indexes cut.
    const [l, setL] = createStore(["x", "y", "z"]);
    const third = runs(() => l[2]);
    setL((d) => {
      d.length = 1;
    });
    expect(third()).toBe(2);
    expect([...l]).toEqual(["x"]);
  });

  test("a store's items keep their proxies, so <For> skips rows whose item has not changed", () => {
    const [s, set] = createStore({ list: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const [, two] = s.list;
    set((d) => {
      d.list = d.list.filter((t) => t.id !== 1);
    });
    expect(s.list[0]).toBe(two!);
    expect(s.list[0]).not.toBe(snapshot(s.list)[0]!);
  });

  test("Object.keys and `in` follow the keys added and deleted", () => {
    const [s, set] = createStore<Record<string, number>>({ a: 1 });
    const keys = runs(() => Object.keys(s)),
      has = runs(() => "b" in s);
    set((d) => {
      d["a"] = 2;
    });
    expect([keys(), has()]).toEqual([1, 1]);
    set((d) => {
      d["b"] = 1;
    });
    expect([keys(), has()]).toEqual([2, 2]);
    set((d) => {
      delete d["b"];
      delete d["none"];
    });
    expect([keys(), has()]).toEqual([3, 3]);
    expect({ ...s }).toEqual({ a: 2 });
  });

  test("a missing property is followed until it is set", () => {
    const [s, set] = createStore<{ user?: { name: string } }>({});
    const name = runs(() => s.user?.name);
    set((d) => {
      d.user = { name: "ann" };
    });
    expect(name()).toBe(2);
    expect(s.user!.name).toBe("ann");
  });

  test("a store is read-only: writes throw, naming the setter", () => {
    const [s] = createStore({ a: 1 }) as [Record<string, number>, unknown];
    expect(() => (s["a"] = 2)).toThrow("reactre: a store is written through the draft its setter gives");
    expect(() => delete s["a"]).toThrow("reactre: a store");
    expect(() => Object.defineProperty(s, "b", { value: 1 })).toThrow("reactre: a store");
  });

  test("only plain objects and arrays are wrapped: a Date, a class instance and a frozen object are as they are", () => {
    class Point {
      x = 1;
    }
    const at = new Date(0),
      p = new Point(),
      frozen = Object.freeze({ a: 1 }),
      bare = Object.assign(Object.create(null) as Record<string, number>, { a: 1 });
    const [s] = createStore({ at, p, frozen, bare });
    expect(s.at).toBe(at);
    expect(s.p).toBe(p);
    expect(s.frozen).toBe(frozen);
    expect(s.bare).not.toBe(bare);
    expect(s.bare["a"]).toBe(1);
  });

  test("a getter in a store reads through the store, so it is tracked", () => {
    const [s, set] = createStore({
      first: "a",
      last: "b",
      get full(): string {
        return this.first + " " + this.last;
      },
    });
    const full = runs(() => s.full);
    set((d) => {
      d.last = "c";
    });
    expect(full()).toBe(2);
    expect(s.full).toBe("a c");
  });

  test("a store inside another reads as the same store", () => {
    const [inner, setInner] = createStore({ n: 1 });
    const [outer] = createStore({ inner });
    expect(outer.inner).toBe(inner);
    const n = runs(() => outer.inner.n);
    setInner((d) => {
      d.n = 2;
    });
    expect(n()).toBe(2);
  });
});

describe("the setter", () => {
  test("its writes are batched", () => {
    const [s, set] = createStore({ a: 1, b: 1 });
    const both = runs(() => s.a + s.b);
    set((d) => {
      d.a = 2;
      d.b = 2;
    });
    expect(both()).toBe(2);
  });

  test("an object it returns replaces the store's contents shallowly", () => {
    const [s, set] = createStore<{ a?: number; b?: number; c?: { n: number } }>({ a: 1, b: 1, c: { n: 1 } });
    const c = s.c!;
    set(() => ({ a: 2, c }));
    expect({ ...s }).toEqual({ a: 2, c: { n: 1 } });
    expect(s.c).toBe(c);
    const [l, setL] = createStore([1, 2, 3]);
    setL(() => [4]);
    expect([...l]).toEqual([4]);
  });

  test("a value that is not an object, or the draft itself, replaces nothing", () => {
    const [s, set] = createStore({ list: [1] });
    set((d) => d.list.push(2) as never);
    set((d) => d);
    expect(snapshot(s)).toEqual({ list: [1, 2] });
  });

  test("the draft subscribes nothing, and nor does the rest of the setter", () => {
    const [n] = signal(0);
    const [s, set] = createStore({ a: 1 });
    let ran = 0;
    effect(() => {
      ran++;
      set((d) => {
        n();
        d.a = d.a + 1;
      });
    });
    expect([ran, s.a]).toEqual([1, 2]);
  });

  test("a shallow store tracks its own properties alone, and replaces its records by reference", () => {
    const rec = { n: 1 };
    const [s, set] = createStore({ rec, list: [rec] }, { shallow: true });
    expect(s.rec).toBe(rec);
    expect(s.list[0]).toBe(rec);
    const r = runs(() => s.rec);
    set((d) => {
      d.rec.n = 2;
    });
    expect(r()).toBe(1);
    set((d) => {
      d.rec = { n: 3 };
    });
    expect(r()).toBe(2);
    expect(s.rec.n).toBe(3);
  });
});

describe("derived stores", () => {
  test("createStore(fn, seed) runs fn on the draft, tracked; a write holds until fn runs again", () => {
    const [count, setCount] = signal(1);
    const [s, set] = createStore<{ n: number; label: string }>(
      (d) => {
        d.n = count() * 2;
      },
      { n: 0, label: "x" },
    );
    const n = runs(() => s.n);
    expect(s.n).toBe(2);
    set((d) => {
      d.n = 5;
      d.label = "y";
    });
    expect(s.n).toBe(5);
    setCount(2);
    expect([s.n, s.label, n()]).toEqual([4, "y", 3]);
  });

  test("a value fn returns is reconciled by key: items keep their identity, and only changes re-run", () => {
    const [rows, setRows] = signal([
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ]);
    const p = createProjection<{ id: number; title: string }[]>(() => rows().map((r) => ({ ...r })), []);
    const [one, two] = p;
    const t1 = runs(() => p[0]!.title),
      t2 = runs(() => p[1]!.title);
    setRows([
      { id: 1, title: "a" },
      { id: 2, title: "B" },
    ]);
    expect([t1(), t2()]).toEqual([1, 2]);
    expect(p[0]).toBe(one!);
    expect(p[1]).toBe(two!);
    // Reordered: the same items, moved.
    setRows([
      { id: 2, title: "B" },
      { id: 1, title: "a" },
    ]);
    expect(p[0]).toBe(two!);
    expect(() => ((p as unknown as number[])[0] = 1)).toThrow("reactre: a store");
  });

  test("createProjection follows another store, and its key option matches items by another property", () => {
    const [src, setSrc] = createStore({ items: [{ k: "a", n: 1 }] });
    const p = createProjection<{ k: string; n: number }[]>(() => src.items.map((i) => ({ ...i })), [], { key: "k" });
    const first = p[0];
    setSrc((d) => {
      d.items[0]!.n = 2;
    });
    expect(p[0]).toBe(first!);
    expect(p[0]!.n).toBe(2);
  });

  test("a projection may change its draft in place, or return the draft", () => {
    const [sel, setSel] = signal(1);
    const flags = createProjection<Record<number, boolean>>((d) => {
      for (const k of Object.keys(d)) delete d[+k];
      d[sel()] = true;
      return d;
    }, {});
    const three = runs(() => flags[3]),
      one = runs(() => flags[1]);
    setSel(2);
    expect([three(), one()]).toEqual([1, 2]);
    expect({ ...flags }).toEqual({ 2: true });
  });

  test("a derived store is disposed with its owner", () => {
    const [n, setN] = signal(1);
    let p!: { n: number };
    const dispose = createRoot((dispose) => {
      p = createProjection<{ n: number }>(() => ({ n: n() }), { n: 0 });
      return dispose;
    });
    dispose();
    setN(2);
    expect(p.n).toBe(1);
  });
});

describe("reconcile", () => {
  test("writes only what differs, keeping items of the same id", () => {
    const [s, set] = createStore({
      user: { name: "a", tags: ["x"] },
      list: [
        { id: 1, title: "a" },
        { id: 2, title: "b" },
      ],
    });
    const [one] = s.list;
    const name = runs(() => s.user.name),
      t1 = runs(() => s.list[0]!.title),
      tags = runs(() => s.user.tags.join());
    set(
      reconcile({
        user: { name: "a", tags: ["x", "y"] },
        list: [
          { id: 1, title: "a" },
          { id: 3, title: "c" },
        ],
      }),
    );
    expect([name(), t1(), tags()]).toEqual([1, 1, 2]);
    expect(s.list[0]).toBe(one!);
    expect(snapshot(s)).toEqual({
      user: { name: "a", tags: ["x", "y"] },
      list: [
        { id: 1, title: "a" },
        { id: 3, title: "c" },
      ],
    });
  });

  test("objects of another id are replaced, not merged, and keys gone from the value are deleted", () => {
    const [s, set] = createStore<{ sel: { id: number; x?: number }; extra?: number }>({
      sel: { id: 1, x: 1 },
      extra: 1,
    });
    const sel = s.sel;
    set(reconcile({ sel: { id: 2 } }));
    expect(s.sel).not.toBe(sel);
    expect(snapshot(s)).toEqual({ sel: { id: 2 } });
  });

  test("key null matches array items by index; items without a key match by index too", () => {
    const [s, set] = createStore({ a: [{ id: 1, n: 1 }], b: [{ n: 1 }] });
    const a0 = s.a[0],
      b0 = s.b[0];
    set(reconcile({ a: [{ id: 2, n: 2 }], b: [{ n: 2 }] }, null));
    expect(s.a[0]).toBe(a0!);
    expect(s.a[0]!.id).toBe(2);
    set(reconcile({ a: [{ id: 2, n: 2 }], b: [{ n: 3 }] }));
    expect(s.b[0]).toBe(b0!);
    expect(s.b[0]!.n).toBe(3);
  });

  test("on part of the draft, or on values it does not wrap", () => {
    const [s, set] = createStore({ list: [{ id: 1, n: 1 }], at: 1 });
    set((d) => {
      reconcile([{ id: 1, n: 2 }])(d.list);
      reconcile(5)(d.at);
    });
    expect(snapshot(s)).toEqual({ list: [{ id: 1, n: 2 }], at: 1 });
  });

  test("on a shallow store, it replaces the values, by reference, and re-runs their readers", () => {
    const first = { v: 1 };
    const [list, setList] = createStore([first, { v: 2 }], { shallow: true });
    const seen: unknown[] = [];
    effect(() => void seen.push(list[0]));
    const fresh = [{ v: 3 }];
    setList(reconcile(fresh, null));
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(first);
    expect(seen[1]).toBe(fresh[0]!);
    expect(list[0]).toBe(fresh[0]!);
    expect(list.length).toBe(1);
    // The old row is the caller's still, unchanged.
    expect(first).toEqual({ v: 1 });
    const a = { v: 1 };
    const [obj, setObj] = createStore<Record<string, { v: number }>>({ a, b: { v: 2 } }, { shallow: true });
    const keys: string[][] = [];
    effect(() => void keys.push(Object.keys(obj)));
    const next: Record<string, { v: number }> = { a: { v: 1 }, c: { v: 3 } };
    setObj(reconcile(next, "v"));
    expect(obj["a"]).toBe(next.a);
    expect(a).toEqual({ v: 1 });
    expect(keys).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
  });
});

describe("path", () => {
  test("writes a value at a path, and re-runs only its readers", () => {
    const [s, set] = createStore({ user: { name: "a", age: 1 }, n: 0 });
    const name = runs(() => s.user.name),
      age = runs(() => s.user.age);
    set(path("user", "name", "b"));
    set(path("n", (n) => n + 1));
    expect(snapshot(s)).toEqual({ user: { name: "b", age: 1 }, n: 1 });
    expect([name(), age()]).toEqual([2, 1]);
  });

  test("a function gets the value there; returning it unchanged writes nothing", () => {
    const [s, set] = createStore({ list: [{ id: 1 }] });
    const list = runs(() => s.list);
    let seen: unknown;
    set(
      path("list", (l) => {
        seen = l;
        return l;
      }),
    );
    expect(snapshot(seen)).toEqual([{ id: 1 }]);
    expect(list()).toBe(1);
  });

  test("an object over an object is merged into it, an array replaces, a value over a value replaces", () => {
    const [s, set] = createStore<{ user: { name: string; age?: number }; tags: string[]; at: number | { x: number } }>({
      user: { name: "a" },
      tags: ["x", "y"],
      at: 1,
    });
    const user = s.user;
    set(path("user", { age: 2 }));
    set(path("tags", ["z"]));
    set(path("at", { x: 1 }));
    expect(s.user).toBe(user);
    expect(snapshot(s)).toEqual({ user: { name: "a", age: 2 }, tags: ["z"], at: { x: 1 } });
  });

  test("with no key, the value is merged into the store; null or undefined writes nothing", () => {
    const [s, set] = createStore<Record<PropertyKey, unknown>>({ a: 1 });
    const sym = Symbol("s");
    const keys = runs(() => Reflect.ownKeys(s));
    set(path({ b: 2, [sym]: 3 }));
    // The setter batches: its two new keys re-run the reader once.
    expect(keys()).toBe(2);
    const at = path as unknown as (v: unknown) => (d: Record<PropertyKey, unknown>) => void;
    set(at(null));
    set(at(undefined));
    expect(keys()).toBe(2);
    expect(s["a"]).toBe(1);
    expect(s["b"]).toBe(2);
    expect(s[sym]).toBe(3);
    set(path((d) => ({ c: (d["b"] as number) + 1 })));
    expect(s["c"]).toBe(3);
  });

  test("a merged getter stays a getter, and re-runs the readers of its key", () => {
    const [s, set] = createStore<{ a: number; b?: number; c?: number }>({ a: 1, c: 0 });
    const b = runs(() => s.b),
      keys = runs(() => Object.keys(s));
    const value = {
      get b(): number {
        return 10;
      },
      get c(): number {
        return 20;
      },
    };
    set(path(value));
    expect(s.b).toBe(10);
    expect(s.c).toBe(20);
    expect(typeof Object.getOwnPropertyDescriptor(snapshot(s), "b")?.value).toBe("number");
    expect([b(), keys()]).toEqual([2, 2]);
  });

  test("a key that is not enumerable is not merged", () => {
    const [s, set] = createStore<Record<string, unknown>>({});
    const value = Object.defineProperty({ a: 1 }, "hidden", { value: 2, enumerable: false });
    set(path(value));
    expect(Object.keys(s)).toEqual(["a"]);
  });

  test("path.DELETE deletes the property", () => {
    const [s, set] = createStore<{ user: { name: string; nickname?: string } }>({
      user: { name: "a", nickname: "b" },
    });
    const has = runs(() => "nickname" in s.user);
    set(path("user", "nickname", path.DELETE));
    expect("nickname" in s.user).toBe(false);
    expect(has()).toBe(2);
  });

  test("several keys, a range and a test of an array's items", () => {
    const todos = (): { id: number; done: boolean; seen: number }[] =>
      [1, 2, 3, 4, 5].map((id) => ({ id, done: id % 2 === 0, seen: 0 }));
    const [s, set] = createStore({ todos: todos(), flags: { a: false, b: false, c: false } });
    set(path("todos", (t) => !t.done, "done", true));
    expect(s.todos.map((t) => t.done)).toEqual([true, true, true, true, true]);
    set(path("todos", { from: 1, to: 3 }, "seen", (n) => n + 1));
    set(path("todos", { by: 2 }, "seen", (n) => n + 10));
    set(path("todos", [0, 4], "id", (id) => -id));
    expect(s.todos.map((t) => t.seen)).toEqual([10, 1, 11, 1, 10]);
    expect(s.todos.map((t) => t.id)).toEqual([-1, 2, 3, 4, -5]);
    set(path("flags", ["a", "c"], true));
    expect(snapshot(s.flags)).toEqual({ a: true, b: false, c: true });
    // A step's keys are put back after it: the function writes the same way each time.
    const bump = path<{ n: number[] }, "n", number>("n", [0, 1], (n) => n + 1);
    const [t, setT] = createStore({ n: [0, 0, 0] });
    setT(bump);
    setT(bump);
    expect(t.n).toEqual([2, 2, 0]);
  });

  test("at depth, through the setter's batch: an effect runs once", () => {
    const [s, set] = createStore({ a: { b: { c: { d: { e: { f: 0, g: 0 } } } } } });
    const seen: number[] = [];
    effect(() => void seen.push(s.a.b.c.d.e.f + s.a.b.c.d.e.g));
    set(path("a", "b", "c", "d", "e", { f: 1, g: 2 }));
    set(path("a", "b", "c", "d", "e", "f", 5));
    expect(seen).toEqual([0, 3, 7]);
  });

  test("__proto__, constructor and prototype are neither followed nor written", () => {
    const polluted = (): unknown => (Object.prototype as Record<string, unknown>)["polluted"];
    const [s, set] = createStore<Record<string, unknown>>({ a: { x: 1 } });
    const at = path as unknown as (...args: unknown[]) => (d: Record<string, unknown>) => void;
    set(at("__proto__", "polluted", 1));
    set(at("constructor", "prototype", "polluted", 1));
    set(at("a", "prototype", 1));
    set(at(JSON.parse('{"__proto__": {"polluted": 1}, "constructor": 2, "b": 3}')));
    expect(polluted()).toBeUndefined();
    expect(snapshot(s)).toEqual({ a: { x: 1 }, b: 3 });
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
  });

  test("its types follow the store", () => {
    const [, set] = createStore({ user: { name: "a" }, list: [{ id: 1 }] });
    set(path("user", "name", "b"));
    set(path("list", 0, "id", (id) => id + 1));
    set(path("list", (item) => item.id > 0, "id", 2));
    // @ts-expect-error: no such key
    set(path("user", "age", 1));
    // @ts-expect-error: a name is a string
    set(path("user", "name", 1));
  });
});

describe("__proto__ and constructor", () => {
  const polluted = (): unknown => (Object.prototype as Record<string, unknown>)["polluted"];

  test("a draft write of __proto__ is dropped; constructor and prototype are own data", () => {
    const [s, set] = createStore<Record<string, unknown>>({ a: 1 });
    set((d) => {
      d["__proto__"] = { polluted: true };
      d["constructor"] = "c";
      d["prototype"] = "p";
    });
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect(s["polluted"]).toBeUndefined();
    expect(s["constructor"]).toBe("c");
    expect(s["prototype"]).toBe("p");
    expect(polluted()).toBeUndefined();
  });

  test("an inherited __proto__ or constructor reads as undefined, so no write reaches Object.prototype", () => {
    const [s, set] = createStore<{ list: number[]; o: Record<string, Record<string, unknown> | undefined> }>({
      list: [3, 1, 2],
      o: {},
    });
    expect(s.o["__proto__"]).toBeUndefined();
    expect(s.o["constructor"]).toBeUndefined();
    set((d) => {
      expect(d.o["__proto__"]).toBeUndefined();
      expect(d.o["constructor"]).toBeUndefined();
      // Array methods that read `constructor` make plain arrays.
      d.list = d.list.filter((n) => n > 1);
    });
    expect(s.list).toEqual([3, 2]);
    expect(Array.isArray(s.list.map((n) => n))).toBe(true);
    expect(polluted()).toBeUndefined();
  });

  test("reconcile, a returned object and snapshot keep an own __proto__ (JSON's) as data", () => {
    const json = JSON.parse('{ "a": 2, "__proto__": { "polluted": true }, "constructor": { "x": 1 } }') as Record<
      string,
      unknown
    >;
    const [s, set] = createStore<Record<string, unknown>>({ a: 1 });
    set(reconcile(json));
    expect(polluted()).toBeUndefined();
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect(s["polluted"]).toBeUndefined();
    expect(snapshot(s["__proto__"])).toEqual({ polluted: true });
    expect(snapshot(s["constructor"])).toEqual({ x: 1 });
    // Own, it is followed as any key is; reconciled again, it is merged into.
    const own = s["__proto__"] as Record<string, unknown>;
    const seen: unknown[] = [];
    effect(() => void seen.push(own["polluted"]));
    set(reconcile(JSON.parse('{ "__proto__": { "polluted": false } }')));
    expect(s["__proto__"]).toBe(own);
    expect(seen).toEqual([true, false]);
    expect(polluted()).toBeUndefined();
    const copy = snapshot(s) as Record<string, unknown>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.hasOwn(copy, "__proto__")).toBe(true);
    const [r, setR] = createStore<Record<string, unknown>>({});
    setR(() => JSON.parse('{ "__proto__": { "polluted": 1 } }'));
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
    expect(snapshot(r["__proto__"])).toEqual({ polluted: 1 });
    expect(polluted()).toBeUndefined();
  });
});

describe("snapshot and deep", () => {
  test("snapshot is a plain deep copy that subscribes nothing; cycles are kept", () => {
    const data: { list: { n: number }[]; at: Date; self?: unknown } = { list: [{ n: 1 }], at: new Date(0) };
    data.self = data;
    const [s, set] = createStore(data);
    let snap!: typeof data;
    const r = runs(() => (snap = snapshot(s)));
    expect(snap).not.toBe(data);
    expect(snap.self).toBe(snap);
    expect(snap.at).toBe(data.at);
    expect(snap.list).toEqual([{ n: 1 }]);
    set((d) => {
      d.list[0]!.n = 2;
    });
    expect(r()).toBe(1);
    expect(snap.list[0]!.n).toBe(1);
    expect(snapshot(5)).toBe(5);
  });

  test("deep subscribes to every property, at every depth", () => {
    const [s, set] = createStore({ a: { b: [{ c: 1 }] }, d: 1 });
    let last: unknown;
    const r = runs(() => (last = deep(s)));
    set((d) => {
      d.a.b[0]!.c = 2;
    });
    set((d) => {
      d.a.b.push({ c: 3 });
    });
    set((d) => {
      (d as Record<string, unknown>)["e"] = 1;
    });
    expect(r()).toBe(4);
    expect(last).toEqual({ a: { b: [{ c: 2 }, { c: 3 }] }, d: 1, e: 1 });
  });
});

describe("merge and omit", () => {
  test("merge: a later source's properties win, undefined included; null sources are skipped", () => {
    const m = merge({ a: 1, b: 2, c: 3 }, null, { b: undefined, d: 4 }, undefined);
    expect({ ...m }).toEqual({ a: 1, b: undefined, c: 3, d: 4 });
  });

  test("merge keeps getters: nothing is read when merging, and each read follows its source", () => {
    const [n, setN] = signal(1);
    let reads = 0;
    const props = {
      get n() {
        reads++;
        return n();
      },
    };
    const m = merge({ n: 0, x: 1 }, props);
    expect(reads).toBe(0);
    const r = runs(() => m.n);
    setN(2);
    expect([m.n, r()]).toEqual([2, 2]);
  });

  test("merge over a store follows its properties, and their deletion", () => {
    const [s, set] = createStore<{ a?: number }>({ a: 1 });
    const m = merge({ a: 0 }, s);
    const r = runs(() => m.a);
    set((d) => {
      d.a = 2;
    });
    expect(m.a).toBe(2);
    set((d) => {
      delete d.a;
    });
    expect([m.a, r()]).toEqual([0, 3]);
    set((d) => {
      d.a = 5;
    });
    const only = merge(s);
    expect(only.a).toBe(5);
    set((d) => {
      delete d.a;
    });
    expect(only.a).toBeUndefined();
  });

  test("omit leaves the keys out and keeps getters", () => {
    const [n, setN] = signal(1);
    const props = {
      label: "x",
      get n() {
        return n();
      },
      id: "i",
    };
    const rest = omit(props, "label", "id");
    expect(Object.keys(rest)).toEqual(["n"]);
    const r = runs(() => rest.n);
    setN(2);
    expect([rest.n, r()]).toEqual([2, 2]);
  });
});

describe("in compiled TSX", () => {
  type App = { count: number; ui: { dark: boolean }; user: { name: string } | null };

  // classList's toggle, over the class attribute, as the DOM's (the fake document has none).
  beforeAll(() => {
    Object.defineProperty(FakeElement.prototype, "classList", {
      configurable: true,
      get(this: FakeElement) {
        return {
          toggle: (c: string, on: boolean) => {
            const cs = (this.getAttribute("class") ?? "").split(" ").filter((x) => x && x !== c);
            this.setAttribute("class", (on ? [...cs, c] : cs).join(" "));
          },
        };
      },
    });
  });
  afterAll(() => void delete (FakeElement.prototype as unknown as Record<string, unknown>)["classList"]);

  test("a read of a store's member is reactive: a text hole, an attribute, a class toggle, <Show>", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<App> }>(
      `
      import { Show, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ count: 1, ui: { dark: false }, user: null });
      render(() => (
        <main class={s.ui.dark ? "dark" : "light"}>
          <b>{s.count.toString()}</b><i class={{ on: s.ui.dark }}>{s.count}</i>
          <Show when={s.user} fallback={<u>out</u>}>{(u) => <u>{u().name}</u>}</Show>
          <Show when={s.user}><em>in</em></Show>
        </main>
      ), root);
      return { set };
      `,
      root,
    );
    const main = root.firstChild as FakeElement,
      i = main.childNodes[1] as FakeElement;
    expect([root.textContent, main.getAttribute("class"), i.getAttribute("class")]).toEqual(["11out", "light", null]);
    api.set((d) => {
      d.count = 2;
      d.ui.dark = true;
    });
    expect([root.textContent, main.getAttribute("class"), i.getAttribute("class")]).toEqual(["22out", "dark", "on"]);
    api.set((d) => {
      d.user = { name: "a" };
    });
    expect(root.textContent).toBe("22ain");
    api.set((d) => {
      d.user!.name = "b";
    });
    expect(root.textContent).toBe("22bin");
    api.set((d) => {
      d.user = null;
    });
    expect(root.textContent).toBe("22out");
  });

  test("a store is a root under any local name, through a namespace import, and as a projection", () => {
    const root = box();
    const api = run<{
      setA: store.StoreSetter<{ n: number }>;
      setB: store.StoreSetter<{ n: number }>;
      select(k: number): void;
    }>(
      `
      import { render, signal } from "@reactre/core";
      import { createStore as make, createProjection } from "@reactre/core/features/store";
      import * as S from "@reactre/core/features/store";
      const [a, setA] = make({ n: 1 });
      const [b, setB] = S.createStore({ n: 1 });
      const [sel, select] = signal(1);
      const flags = createProjection((d) => { for (const k of Object.keys(d)) delete d[k]; d[sel()] = true; }, {});
      const other = S.createProjection((d) => { d.n = a.n * 10; }, { n: 0 });
      render(() => <p>{a.n}:{b.n}:{flags[1] ? "y" : "n"}:{other.n}</p>, root);
      return { setA, setB, select };
      `,
      root,
    );
    expect(root.textContent).toBe("1:1:y:10");
    api.setA((d) => {
      d.n = 2;
    });
    api.setB((d) => {
      d.n = 3;
    });
    api.select(2);
    expect(root.textContent).toBe("2:3:n:20");
  });

  test("a prop passed a store's member, or the store, is reactive in the component", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<{ title: string }> }>(
      `
      import { render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ title: "a" });
      function Label(props) { return <b>{props.text}</b>; }
      function Card(props) { return <i>{props.s.title}</i>; }
      render(() => <p><Label text={s.title} /><Card s={s} /></p>, root);
      return { set };
      `,
      root,
    );
    expect(root.textContent).toBe("aa");
    api.set((d) => {
      d.title = "b";
    });
    expect(root.textContent).toBe("bb");
  });

  test("<For each={store.todos}>: rows follow pushes, removals and moves, and holes follow their item", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<{ todos: (Todo & { tags: string[] })[] }> }>(
      `
      import { For, Show, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ todos: [{ id: 1, title: "a", done: false, tags: ["x"] }, { id: 2, title: "b", done: false, tags: [] }] });
      function Done(props) { return <i>{props.todo.done ? "!" : ""}</i>; }
      render(() => (
        <ul>
          <For each={s.todos} key={(t) => t.id} fallback={<li>none</li>}>
            {(t) => (
              <li class={t.done ? "done" : "open"}>
                {t.title}
                <b><Show when={t.done}>+</Show></b>
                <q><Done todo={t} /></q>
                <span><For each={t.tags} key={(g) => g}>{(g) => <em>{g}</em>}</For></span>
              </li>
            )}
          </For>
        </ul>
      ), root);
      return { set };
      `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    const lis = () => ul.childNodes as FakeElement[];
    const first = lis()[0]!;
    expect(root.textContent).toBe("axb");
    api.set((d) => {
      d.todos.push({ id: 3, title: "c", done: false, tags: [] });
    });
    expect(root.textContent).toBe("axbc");
    expect(lis()[0]).toBe(first);
    // In-place writes to an item: every hole that reads it follows, a nested list too.
    api.set((d) => {
      d.todos[0]!.title = "A";
      d.todos[0]!.done = true;
      d.todos[0]!.tags.push("y");
    });
    expect(root.textContent).toBe("A+!xybc");
    expect(first.getAttribute("class")).toBe("done");
    api.set((d) => {
      d.todos.splice(1, 1);
    });
    expect(root.textContent).toBe("A+!xyc");
    api.set((d) => {
      d.todos.reverse();
    });
    expect(root.textContent).toBe("cA+!xy");
    expect(lis()[1]).toBe(first);
    api.set((d) => {
      d.todos.length = 0;
    });
    expect(root.textContent).toBe("none");
  });

  test("<For each={[...store.todos]}>: rows follow the array, and holes follow their item", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<{ todos: Todo[] }> }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ todos: [{ id: 1, title: "a", done: false }, { id: 2, title: "b", done: false }] });
      render(() => (
        <ul>
          <For each={[...s.todos]} key={(t) => t.id}>
            {(t) => <li class={t.done ? "done" : "open"} title={String(t.done)}>{t.title.trim()}</li>}
          </For>
        </ul>
      ), root);
      return { set };
      `,
      root,
    );
    const ul = root.firstChild as FakeElement;
    const lis = () => ul.childNodes as FakeElement[];
    const first = lis()[0];
    expect(root.textContent).toBe("ab");
    api.set((d) => {
      d.todos.push({ id: 3, title: "c", done: false });
    });
    expect(root.textContent).toBe("abc");
    expect(lis()[0]).toBe(first!);
    // An item's property: the holes that call follow it, and so does the one that reads only the item.
    api.set((d) => {
      d.todos[0]!.title = "A";
      d.todos[0]!.done = true;
    });
    expect(root.textContent).toBe("Abc");
    expect([first!.getAttribute("title"), first!.getAttribute("class")]).toEqual(["true", "done"]);
    // A removal takes out the removed item's row.
    api.set((d) => {
      d.todos.splice(1, 1);
    });
    expect(root.textContent).toBe("Ac");
    expect(lis()[0]).toBe(first!);
    batch(() =>
      api.set((d) => {
        d.todos.reverse();
      }),
    );
    expect(root.textContent).toBe("cA");
  });

  test("a store read through a local of its member, an object, a function's result or a prop follows it", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<{ n: number; todos: Todo[] }> }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ n: 1, todos: [{ id: 1, title: "a", done: false }] });
      const todos = s.todos, holder = { s }, get = () => s.todos;
      function List(props) {
        return (
          <section>
            <ul><For each={props.todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>
            <ol><For each={[...props.todos]} key={(t) => t.id}>{(t) => <li>{String(t.title)}</li>}</For></ol>
          </section>
        );
      }
      render(() => (
        <div>
          <p>{holder.s.n}</p><p>{holder.s.n.toString()}</p><p>{get()[0].title}</p>
          <ul><For each={todos} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ul>
          <ol><For each={get()} key={(t) => t.id}>{(t) => <li>{t.title}</li>}</For></ol>
          <menu><For each={[...get()]} key={(t) => t.id}>{(t) => <li>{t.title.toString()}</li>}</For></menu>
          <List todos={s.todos} />
        </div>
      ), root);
      return { set };
      `,
      root,
    );
    const div = root.firstChild as FakeElement;
    const texts = () => (div.childNodes as FakeElement[]).filter((n) => n.tagName).map((n) => n.textContent);
    const section = () => (div.childNodes as FakeElement[]).find((n) => n.tagName === "SECTION")!;
    const list = () => (section().childNodes as FakeElement[]).map((n) => n.textContent);
    expect([texts(), list()]).toEqual([
      ["1", "1", "a", "a", "a", "a", "aa"],
      ["a", "a"],
    ]);
    api.set((d) => {
      d.n = 2;
      d.todos[0]!.title = "A";
      d.todos.push({ id: 2, title: "b", done: false });
    });
    // Each is a store root: its holes are bound, and a <For> over it reads a copy and binds the
    // holes that read its item. List's one caller passes it the store's array.
    expect(texts().slice(0, 6)).toEqual(["2", "2", "A", "Ab", "Ab", "Ab"]);
    expect(list()).toEqual(["Ab", "Ab"]);
  });

  test("a list that is a component's whole view, or whose rows are not one element, follows a store passed as a prop or read through a local", () => {
    // Each list here is features/for's `__each`: List's is its whole view, its rows fragments;
    // Tag is used as a value, so its callers cannot all be seen and its props may be stores.
    const root = box();
    const api = run<{ set: store.StoreSetter<{ todos: Todo[] }> }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ todos: [{ id: 1, title: "a", done: false }] });
      const todos = s.todos;
      function List(props) { return <For each={props.todos} key={(t) => t.id}>{(t) => <>{t.title}<b /></>}</For>; }
      function Tag(props) { return <For each={props.items} key={(t) => t.id}>{(t) => t.title}</For>; }
      const tags = [Tag];
      render(() => (
        <div>
          <p><List todos={s.todos} /></p>
          <p><Tag items={s.todos} /></p>
          <p>{1}<For each={todos} key={(t) => t.id}>{(t) => [t.title, "!"]}</For></p>
        </div>
      ), root);
      return { set };
      `,
      root,
    );
    const div = root.firstChild as FakeElement;
    const texts = () => (div.childNodes as FakeElement[]).map((n) => n.textContent);
    expect(texts()).toEqual(["a", "a", "1a!"]);
    api.set((d) => {
      d.todos[0]!.title = "A";
      d.todos.push({ id: 2, title: "b", done: false });
    });
    expect(texts()).toEqual(["Ab", "Ab", "1A!b!"]);
  });
});
