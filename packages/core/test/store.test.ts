// Stores (@reactre/core/features/store) on the unbundled runtime: what a read subscribes to, how
// the setter's draft writes, derived stores, reconcile, snapshot and deep, merge and omit, and
// how stores behave in compiled TSX, outside lists and in <For> rows. TSX sources here are
// compiled as the plugin compiles them.

import { beforeEach, describe, expect, test } from "bun:test";

import { compileSource } from "@reactre/compiler";
import { FakeElement, installFakeDocument } from "@reactre/testdom";

import { createRoot } from "../src/features/owner.ts";
import * as store from "../src/features/store.ts";
import { createProjection, createStore, deep, merge, omit, reconcile, snapshot } from "../src/features/store.ts";
import * as core from "../src/index.ts";
import { batch, effect, signal } from "../src/index.ts";

/** What a source's imports of @reactre/core and of its store feature bind to. */
const runtime = { ...core, ...store };

beforeEach(installFakeDocument);

/** Compile a TSX module body ending in `return { ... }` and run it, `root` in scope. */
function run<T>(src: string, root: FakeElement): T {
  const js = compileSource(src).replace(
    /^import \{([^}]*)\} from "@reactre\/core(?:\/features\/store)?";$/gm,
    (_, names: string) =>
      names
        .split(",")
        .map((n) => {
          const [a, b] = n.trim().split(" as ");
          return `const ${b ?? a} = rr.${a};`;
        })
        .join("\n"),
  );
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
  test("a hole that calls something follows the store; one that calls nothing is written once", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<{ count: number }> }>(
      `
      import { render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ count: 1 });
      render(() => <p><b>{s.count.toString()}</b><i>{s.count}</i></p>, root);
      return { set };
      `,
      root,
    );
    expect(root.textContent).toBe("11");
    api.set((d) => {
      d.count = 2;
    });
    expect(root.textContent).toBe("21");
  });

  test("<For each={[...store.todos]}>: rows follow the array, and holes that call follow their item", () => {
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
    // An item's property: the holes that call follow it; the one that reads only the item does not.
    api.set((d) => {
      d.todos[0]!.title = "A";
      d.todos[0]!.done = true;
    });
    expect(root.textContent).toBe("Abc");
    expect([first!.getAttribute("title"), first!.getAttribute("class")]).toEqual(["true", "open"]);
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

  test("<For each={store.todos}>: rows follow their items' properties, but not the array", () => {
    const root = box();
    const api = run<{ set: store.StoreSetter<{ todos: Todo[] }> }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [s, set] = createStore({ todos: [{ id: 1, title: "a", done: false }] });
      render(() => <ul><For each={s.todos} key={(t) => t.id}>{(t) => <li>{t.title.trim()}</li>}</For></ul>, root);
      return { set };
      `,
      root,
    );
    api.set((d) => {
      d.todos[0]!.title = "A";
    });
    expect(root.textContent).toBe("A");
    // `each` read the property, not the array's contents: a push is not seen.
    api.set((d) => {
      d.todos.push({ id: 2, title: "b", done: false });
    });
    expect(root.textContent).toBe("A");
    // A new array for the property is.
    api.set((d) => {
      d.todos = [...d.todos];
    });
    expect(root.textContent).toBe("Ab");
  });
});
