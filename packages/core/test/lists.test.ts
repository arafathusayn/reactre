// map and repeat (@reactre/core/features/lists), on the unbundled runtime: which rows each update
// keeps, makes and disposes, what their accessors follow, when the array is new, and that an
// update whose map function throws changes nothing.

import { describe, expect, test } from "bun:test";

import { createContext, useContext } from "../src/features/context.ts";
import { map, repeat } from "../src/features/lists.ts";
import { createRoot } from "../src/features/owner.ts";
import { createStore } from "../src/features/store.ts";
import { effect, onCleanup, signal } from "../src/index.ts";

describe("map, keyed by the item", () => {
  test("each item is mapped once; a move keeps its row and updates its index", () => {
    const a = { id: "a" },
      b = { id: "b" },
      c = { id: "c" };
    const [list, setList] = signal([a, b, c]);
    let calls = 0;
    const rows = createRoot(() =>
      map(list, (item, index) => {
        calls++;
        return { item, index };
      }),
    );
    const [ra, rb, rc] = rows();
    expect([ra!.index(), rb!.index(), rc!.index()]).toEqual([0, 1, 2]);
    setList([b, a, c]);
    expect(rows()).toEqual([rb!, ra!, rc!]);
    expect([ra!.index(), rb!.index()]).toEqual([1, 0]);
    setList([b, a, c, { id: "d" }]);
    expect([calls, rows()[3]!.index()]).toEqual([4, 3]);
  });

  test("the array is the same when the items are; rows that leave are disposed", () => {
    const a = { id: "a" },
      b = { id: "b" };
    const [list, setList] = signal([a, b]);
    const gone: string[] = [];
    let arrays = 0;
    const rows = createRoot(() => {
      const m = map(list, (item) => {
        onCleanup(() => gone.push(item.id));
        return item.id;
      });
      effect(() => void (m(), arrays++));
      return m;
    });
    const first = rows();
    setList([a, b]);
    expect([rows() === first, arrays]).toEqual([true, 1]);
    setList([b]);
    expect([rows(), gone, arrays]).toEqual([["b"], ["a"], 2]);
  });

  test("a map function that takes one argument gets no index; it runs untracked", () => {
    const [list, setList] = signal([1, 2]);
    const [other, setOther] = signal(0);
    const args: number[] = [];
    let updates = 0;
    const rows = createRoot(() =>
      map(
        () => (updates++, list()),
        (...a: unknown[]) => {
          args.push(a.length, a[1] === undefined ? 0 : 1);
          return (other(), a[0]) as number;
        },
      ),
    );
    setOther(1);
    expect([rows(), updates, args]).toEqual([[1, 2], 1, [2, 0, 2, 0]]);
    setList([2, 3]);
    expect([rows(), updates]).toEqual([[2, 3], 2]);
  });

  test("equal items pair with their rows in order", () => {
    const [list, setList] = signal(["x", "y", "x"]);
    let n = 0;
    const rows = createRoot(() => map(list, (item) => `${item}${n++}`));
    expect(rows()).toEqual(["x0", "y1", "x2"]);
    setList(["x", "x", "y", "x"]);
    expect(rows()).toEqual(["x0", "x2", "y1", "x3"]);
  });

  test("a list of nothing is empty", () => {
    const [list, setList] = signal<number[] | null | false>(null);
    const rows = createRoot(() => map(list, (x) => x * 2));
    expect(rows()).toEqual([]);
    setList([1]);
    expect(rows()).toEqual([2]);
    setList(false);
    expect(rows()).toEqual([]);
  });

  test("a store's array: its writes reach the list, its items' writes do not", () => {
    const [s, set] = createStore({ todos: [{ id: 1, done: false }] });
    let calls = 0,
      arrays = 0;
    createRoot(() => {
      const m = map(
        () => s.todos,
        (t) => (calls++, t),
      );
      effect(() => void (m(), arrays++));
    });
    set((d) => {
      d.todos[0]!.done = true;
    });
    expect([calls, arrays]).toEqual([1, 1]);
    set((d) => {
      d.todos.push({ id: 2, done: false });
    });
    expect([calls, arrays]).toEqual([2, 2]);
  });
});

describe("map, keyed by a function", () => {
  test("an item of the same key keeps its row, whose item accessor gives the new item", () => {
    const [list, setList] = signal([
      { id: 1, title: "a" },
      { id: 2, title: "b" },
    ]);
    let calls = 0;
    const rows = createRoot(() =>
      map(
        list,
        (item, index) => {
          calls++;
          return { title: () => item().title, index };
        },
        { keyed: (t) => t.id },
      ),
    );
    const first = rows();
    setList([
      { id: 1, title: "A" },
      { id: 2, title: "b" },
    ]);
    expect([rows() === first, rows()[0]!.title(), calls]).toEqual([true, "A", 2]);
    setList([
      { id: 2, title: "B" },
      { id: 1, title: "A" },
    ]);
    expect([rows()[0] === first[1], rows()[0]!.title(), rows()[0]!.index(), calls]).toEqual([true, "B", 0, 2]);
  });

  test("an item that is a function is the accessor's value, not called", () => {
    const f = () => "f",
      g = () => "g";
    const [list, setList] = signal([f]);
    const rows = createRoot(() => map(list, (item) => item, { keyed: () => 0 }));
    setList([g]);
    expect(rows()[0]!()).toBe(g);
  });
});

describe("map, keyed by position", () => {
  test("a row per index: the item accessor follows its position; rows go from the end", () => {
    const [list, setList] = signal([1, 2, 3]);
    const gone: number[] = [];
    let calls = 0;
    const rows = createRoot(() =>
      map(
        list,
        (item, i) => {
          calls++;
          onCleanup(() => gone.push(i));
          return { i, double: () => item() * 2 };
        },
        { keyed: false },
      ),
    );
    const first = rows();
    setList([3, 2, 1]);
    expect([rows() === first, rows().map((r) => r.double()), calls]).toEqual([true, [6, 4, 2], 3]);
    setList([3, 2, 1, 4]);
    expect([rows()[3]!.i, rows()[3]!.double(), calls]).toEqual([3, 8, 4]);
    setList([5]);
    expect([rows().map((r) => r.double()), gone]).toEqual([[10], [1, 2, 3]]);
  });
});

describe("map's fallback and owners", () => {
  test("the fallback shows while the list is empty, under an owner of its own", () => {
    const [list, setList] = signal<string[]>([]);
    const log: string[] = [];
    const rows = createRoot(() =>
      map(list, (x) => x, {
        fallback: () => {
          onCleanup(() => log.push("fallback gone"));
          return "none";
        },
      }),
    );
    expect(rows()).toEqual(["none"]);
    setList([]);
    expect(log).toEqual([]);
    setList(["a"]);
    expect([rows(), log]).toEqual([["a"], ["fallback gone"]]);
    setList([]);
    expect(rows()).toEqual(["none"]);
  });

  test("the rows and the fallback go with the owner map was made in", () => {
    const [list, setList] = signal(["a"]);
    const log: string[] = [];
    const dispose = createRoot((d) => {
      map(
        list,
        (x) => {
          onCleanup(() => log.push(x));
          return x;
        },
        {
          fallback: () => {
            onCleanup(() => log.push("fallback"));
            return "none";
          },
        },
      );
      return d;
    });
    dispose();
    expect(log).toEqual(["a"]);
    setList(["b"]);
    expect(log).toEqual(["a"]);
    const [empty] = signal<string[]>([]);
    createRoot((d) => {
      map(empty, (x) => x, { fallback: () => (onCleanup(() => log.push("fallback")), "none") });
      d();
    });
    expect(log).toEqual(["a", "fallback"]);
  });

  test("rows find the context map was made in", () => {
    const Theme = createContext("light");
    let rows!: () => string[];
    createRoot(() =>
      Theme({
        value: "dark",
        get children() {
          rows = map(
            () => [1],
            () => useContext(Theme),
          );
          return null;
        },
      }),
    );
    expect(rows()).toEqual(["dark"]);
  });

  test("an update whose map function throws changes nothing, and disposes the rows it made", () => {
    const [list, setList] = signal(["a"]);
    const log: string[] = [];
    const rows = createRoot(() =>
      map(list, (x) => {
        onCleanup(() => log.push(`${x} gone`));
        if (x === "bad") throw new Error("bad row");
        return x;
      }),
    );
    expect(() => setList(["a", "b", "bad"])).toThrow("bad row");
    // The row that threw first, then the one made before it.
    expect([rows(), log]).toEqual([["a"], ["bad gone", "b gone"]]);
    const [none, setNone] = signal<string[]>(["a"]);
    const fb = createRoot(() =>
      map(none, (x) => x, {
        fallback: () => {
          throw new Error("bad fallback");
        },
      }),
    );
    expect(() => setNone([])).toThrow("bad fallback");
    expect(fb()).toEqual(["a"]);
  });
});

describe("repeat", () => {
  test("a row per index from `from`; a change keeps the indexes both ranges have", () => {
    const [count, setCount] = signal(3);
    const [from, setFrom] = signal<number | undefined>(undefined);
    const gone: number[] = [];
    let calls = 0;
    const rows = createRoot(() =>
      repeat(
        count,
        (i) => {
          calls++;
          onCleanup(() => gone.push(i));
          return { i };
        },
        { from },
      ),
    );
    const first = rows();
    expect(first.map((r) => r.i)).toEqual([0, 1, 2]);
    setFrom(1);
    expect([rows().map((r) => r.i), rows()[0] === first[1], gone, calls]).toEqual([[1, 2, 3], true, [0], 4]);
    setCount(2);
    expect([rows().map((r) => r.i), gone]).toEqual([
      [1, 2],
      [0, 3],
    ]);
  });

  test("the array is the same when the count and the start are", () => {
    const [count, setCount] = signal(2);
    const rows = createRoot(() =>
      repeat(
        () => count() % 10,
        (i) => i,
      ),
    );
    const first = rows();
    setCount(12);
    expect(rows()).toBe(first);
  });

  test("a count of 0 holds the fallback; the rows and the fallback go with the owner", () => {
    const [count, setCount] = signal(1);
    const log: string[] = [];
    const dispose = createRoot((d) => {
      const rows = repeat(count, (i) => (onCleanup(() => log.push(`row ${i}`)), `row ${i}`), {
        fallback: () => (onCleanup(() => log.push("fallback")), "empty"),
      });
      return [d, rows] as const;
    });
    const rows = dispose[1];
    setCount(0);
    expect([rows(), log]).toEqual([["empty"], ["row 0"]]);
    setCount(0);
    setCount(2);
    expect([rows(), log]).toEqual([
      ["row 0", "row 1"],
      ["row 0", "fallback"],
    ]);
    dispose[0]();
    expect(log).toEqual(["row 0", "fallback", "row 0", "row 1"]);
    const [none] = signal(0);
    createRoot((d) => {
      repeat(none, (i) => i, { fallback: () => (onCleanup(() => log.push("fallback 2")), -1) });
      d();
    });
    expect(log.at(-1)).toBe("fallback 2");
  });

  test("a count of 0 without a fallback is empty; an update whose function throws changes nothing", () => {
    const [count, setCount] = signal(1);
    const log: number[] = [];
    const rows = createRoot(() =>
      repeat(count, (i) => {
        onCleanup(() => log.push(i));
        if (i === 2) throw new Error("bad index");
        return i;
      }),
    );
    setCount(0);
    expect(rows()).toEqual([]);
    setCount(0);
    expect(() => setCount(3)).toThrow("bad index");
    expect([rows(), log]).toEqual([[], [0, 2, 0, 1]]);
  });
});
