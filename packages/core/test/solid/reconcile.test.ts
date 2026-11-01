// Ports of Solid 2.0's reconcile tests to @reactre/core/features/store's `reconcile`: keyed and
// positional merges, what they notify, shape changes, store proxies as values, symbol keys, and a
// reconcile in the same flush as a draft write (packages/signals/tests/store/reconcile.test.ts).
//
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's createEffect(compute, fn) and createRenderEffect are `reaction(compute, apply)`,
// createMemo is core's `memo`. Solid's key "" (no key) is passed as it is: reactre reads the
// key "" of an item, which no item has, so it matches by position, as null does. Writes Solid
// makes before one flush(), whose order matters, go in one `flush(fn)`.

import { describe, expect, test } from "bun:test";

import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { createStore, reconcile, snapshot, type StoreSetter } from "../../src/features/store.ts";
import { flush } from "../../src/features/timing.ts";
import { memo } from "../../src/index.ts";
import { gap } from "./harness.ts";

/** What `fn` last returned, as an effect that reads it records it. */
function follow<T>(fn: () => T): { readonly v: T | undefined; readonly runs: number } {
  const out = { v: undefined as T | undefined, runs: 0 };
  createRoot(() =>
    reaction(fn, (v) => {
      out.v = v;
      out.runs++;
    }),
  );
  return out;
}

describe("reconcile.test.ts", () => {
  describe("setState with reconcile", () => {
    test("Reconcile a simple object", () => {
      const [state, setState] = createStore<{ data: number; missing?: string }>({ data: 2, missing: "soon" });
      expect(state.data).toBe(2);
      expect(state.missing).toBe("soon");
      setState(reconcile({ data: 5 }, "id"));
      expect(state.data).toBe(5);
      expect(state.missing).toBeUndefined();
    });

    test("Reconcile array with nulls", () => {
      const [state, setState] = createStore<(string | null)[]>([null, "a"]);
      expect(state[0]).toBe(null);
      expect(state[1]).toBe("a");
      setState(reconcile(["b", null], "id"));
      expect(state[0]).toBe("b");
      expect(state[1]).toBe(null);
    });

    test("Reconcile a simple object on a nested path", () => {
      const [state, setState] = createStore<{
        data: { user: { firstName: string; middleName: string; lastName?: string } };
      }>({ data: { user: { firstName: "John", middleName: "", lastName: "Snow" } } });
      setState((s) => {
        reconcile({ firstName: "Jake", middleName: "R" }, "id")(s.data.user);
      });
      expect(state.data.user.firstName).toBe("Jake");
      expect(state.data.user.middleName).toBe("R");
      expect(state.data.user.lastName).toBeUndefined();
    });

    test("Reconcile reorder a keyed array", () => {
      const JOHN = { id: 1, firstName: "John", lastName: "Snow" },
        NED = { id: 2, firstName: "Ned", lastName: "Stark" },
        BRANDON = { id: 3, firstName: "Brandon", lastName: "Start" },
        ARYA = { id: 4, firstName: "Arya", lastName: "Start" };
      const [state, setState] = createStore({ users: [JOHN, NED, BRANDON] });
      const ids = (): number[] => state.users.map((u) => u.id);
      expect(ids()).toEqual([1, 2, 3]);
      setState((s) => {
        reconcile([NED, JOHN, BRANDON], "id")(s.users);
      });
      expect(ids()).toEqual([2, 1, 3]);
      setState((s) => {
        reconcile([NED, BRANDON, JOHN], "id")(s.users);
      });
      expect(ids()).toEqual([2, 3, 1]);
      setState((s) => {
        reconcile([NED, BRANDON, JOHN, ARYA], "id")(s.users);
      });
      expect(ids()).toEqual([2, 3, 1, 4]);
      setState((s) => {
        reconcile([BRANDON, JOHN, ARYA], "id")(s.users);
      });
      expect(ids()).toEqual([3, 1, 4]);
    });

    gap(
      "store-in-place",
      "a store writes into the objects it was given, so a snapshot is a copy of them, not them",
      "Reconcile reorder a keyed array, by snapshot identity",
      () => {
        const JOHN = { id: 1, firstName: "John", lastName: "Snow" },
          NED = { id: 2, firstName: "Ned", lastName: "Stark" };
        const [state, setState] = createStore({ users: [JOHN, NED] });
        expect(Object.is(snapshot(state.users[0]), JOHN)).toBe(true);
        setState((s) => {
          reconcile([NED, JOHN], "id")(s.users);
        });
        expect(Object.is(snapshot(state.users[0]), NED)).toBe(true);
      },
    );

    test("Reconcile overwrite in non-keyed merge mode", () => {
      const JOHN = { id: 1, firstName: "John", lastName: "Snow" },
        NED = { id: 2, firstName: "Ned", lastName: "Stark" },
        BRANDON = { id: 3, firstName: "Brandon", lastName: "Start" };
      const [state, setState] = createStore({ users: [{ ...JOHN }, { ...NED }, { ...BRANDON }] });
      expect(state.users[0]!.firstName).toBe("John");
      setState((s) => {
        reconcile([{ ...NED }, { ...JOHN }, { ...BRANDON }], "")(s.users);
      });
      expect(state.users[0]!.id).toBe(2);
      expect(state.users[0]!.firstName).toBe("Ned");
      expect(state.users[1]!.id).toBe(1);
      expect(state.users[1]!.firstName).toBe("John");
      expect(state.users[2]!.id).toBe(3);
      expect(state.users[2]!.firstName).toBe("Brandon");
    });

    const identityWhy = "reconcile merges into the root whatever its key";

    gap("reconcile-identity", identityWhy, "Reconcile top level key mismatch", () => {
      const JOHN = { id: 1, firstName: "John", lastName: "Snow" },
        NED = { id: 2, firstName: "Ned", lastName: "Stark" };
      const [user, setUser] = createStore(JOHN);
      expect(user.id).toBe(1);
      expect(() => setUser(reconcile(NED, "id"))).toThrow();
    });

    gap("reconcile-identity", identityWhy, "Reconcile nested top level key mismatch", () => {
      const JOHN = { id: 1, firstName: "John", lastName: "Snow" },
        NED = { id: 2, firstName: "Ned", lastName: "Stark" };
      const [, setUser] = createStore({ user: JOHN });
      expect(() =>
        setUser((s) => {
          reconcile(NED, "id")(s.user);
        }),
      ).toThrow();
    });

    gap("reconcile-identity", identityWhy, "Reconcile top level key missing", () => {
      const [, setStore] = createStore<{ id?: number; value?: string }>({ id: 0, value: "value" });
      expect(() => setStore(reconcile({}, "id"))).toThrow();
    });

    test("Reconcile overwrite an object with an array", () => {
      const [store, setStore] = createStore<{ value: object }>({ value: { a: { b: 1 } } });
      setStore(reconcile<{ value: object }>({ value: { c: [1, 2, 3] } }, "id"));
      expect(store.value).toEqual({ c: [1, 2, 3] });
    });

    test("Reconcile overwrite an array with an object", () => {
      const [store, setStore] = createStore<{ value: object }>({ value: [1, 2, 3] });
      setStore(reconcile<{ value: object }>({ value: { name: "John" } }, "id"));
      expect(Array.isArray(store.value)).toBeFalsy();
      expect(store.value).toEqual({ name: "John" });
      setStore(reconcile<{ value: object }>({ value: [1, 2, 3] }, "id"));
      expect(store.value).toEqual([1, 2, 3]);
      setStore(reconcile<{ value: object }>({ value: { q: "aa" } }, "id"));
      expect(store.value).toEqual({ q: "aa" });
    });

    test("Reconcile keyed trailing removal notifies $TRACK subscribers", () => {
      // Solid's $TRACK subscribes to an array's keys; the keys are what Object.keys reads here.
      let effectRunCount = 0;
      const [state, setState] = createStore({ arr: [{ id: 1 }, { id: 2 }, { id: 3 }] });
      createRoot(() =>
        reaction(
          () => {
            effectRunCount++;
            return Object.keys(state.arr).length;
          },
          () => {},
        ),
      );
      flush();
      const runsBefore = effectRunCount;
      setState((s) => {
        reconcile([{ id: 1 }, { id: 2 }], "id")(s.arr);
      });
      flush();
      expect(effectRunCount).toBeGreaterThan(runsBefore);
    });

    test("Reconcile overwrite tracked array with object updates the signal node", () => {
      const [store, setStore] = createStore<{ value: unknown }>({ value: [1, 2] });
      const derived = createRoot(() => memo(() => store.value));
      expect(Array.isArray(derived())).toBe(true);
      setStore(reconcile<{ value: unknown }>({ value: { a: 1 } }, "id"));
      flush();
      expect(Array.isArray(derived())).toBe(false);
      expect((derived() as { a: number }).a).toBe(1);
    });

    test("Keyed reconcile preserves null entries between keyed objects (#2772)", () => {
      const [state, setState] = createStore<({ id: number; value?: string } | null)[]>([{ id: 1 }, null, { id: 2 }]);
      setState(reconcile([{ id: 1 }, null, { id: 2, value: "updated" }], "id"));
      expect(snapshot(state)).toEqual([{ id: 1 }, null, { id: 2, value: "updated" }]);
    });

    test("Keyed reconcile replaces a keyed object with a primitive (#2772)", () => {
      const [state, setState] = createStore<({ id: number; value: string } | number)[]>([{ id: 1, value: "object" }]);
      setState(reconcile<({ id: number; value: string } | number)[]>([5], "id"));
      expect(snapshot(state)).toEqual([5]);
    });

    test("Reconcile keyed array shrink notifies tracked index reads and clears stale values", () => {
      const [state, setState] = createStore<{ id: number }[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
      const last = follow(() => state[2]);
      flush();
      expect(last.v).toEqual({ id: 3 });
      setState(reconcile([{ id: 1 }], "id"));
      flush();
      expect(state.length).toBe(1);
      expect(last.v).toBe(undefined);
      expect(state[2]).toBe(undefined);
    });

    test("Reconcile non-keyed array shrink notifies tracked index reads", () => {
      const [state, setState] = createStore<string[]>(["a", "b", "c"]);
      const last = follow(() => state[1]);
      flush();
      expect(last.v).toBe("b");
      setState(reconcile(["a"], "id"));
      flush();
      expect(state.length).toBe(1);
      expect(last.v).toBe(undefined);
      expect(state[1]).toBe(undefined);
    });

    test("Reconcile to empty array clears tracked index reads", () => {
      const [state, setState] = createStore<{ id: number }[]>([{ id: 1 }, { id: 2 }]);
      const last = follow(() => state[0]);
      flush();
      expect(last.v).toEqual({ id: 1 });
      setState(reconcile([] as { id: number }[], "id"));
      flush();
      expect(state.length).toBe(0);
      expect(last.v).toBe(undefined);
      expect(state[0]).toBe(undefined);
    });

    test("Reconcile array resize updates tracked `in` checks in both directions", () => {
      const [state, setState] = createStore<{ id: number }[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
      const has2 = follow(() => 2 in state);
      const has5 = follow(() => 5 in state);
      flush();
      expect(has2.v).toBe(true);
      expect(has5.v).toBe(false);
      setState(reconcile([{ id: 1 }], "id"));
      flush();
      expect(has2.v).toBe(false);
      expect(2 in state).toBe(false);
      setState(reconcile([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }], "id"));
      flush();
      expect(has2.v).toBe(true);
      expect(has5.v).toBe(true);
      expect(5 in state).toBe(true);
    });

    test("Reconcile array growth notifies tracked reads of previously missing indices", () => {
      const [state, setState] = createStore<{ id: number }[]>([{ id: 1 }]);
      const last = follow(() => state[2]);
      flush();
      expect(last.v).toBe(undefined);
      setState(reconcile([{ id: 1 }, { id: 2 }, { id: 3 }], "id"));
      flush();
      expect(last.v).toEqual({ id: 3 });
    });

    test("Reconcile array shrink preserves tracked named array props that remain present", () => {
      type RowsWithProps = { id: number }[] & { "1e3"?: string; "1.5"?: string };
      const prev: RowsWithProps = Object.assign([{ id: 1 }, { id: 2 }, { id: 3 }], { "1e3": "kept", "1.5": "decimal" });
      const [state, setState] = createStore(prev);
      const exponential = follow(() => state["1e3"]);
      const decimal = follow(() => state["1.5"]);
      flush();
      expect(exponential.v).toBe("kept");
      expect(decimal.v).toBe("decimal");
      const next: RowsWithProps = Object.assign([{ id: 1 }], { "1e3": "kept", "1.5": "decimal" });
      setState(reconcile(next, "id"));
      flush();
      expect(state["1e3"]).toBe("kept");
      expect(state["1.5"]).toBe("decimal");
      expect(exponential.v).toBe("kept");
      expect(decimal.v).toBe("decimal");
      expect(state.length).toBe(1);
    });

    test("Reconcile array shrink clears tracked indices on the override path", () => {
      const [state, setState] = createStore<{ id: number }[]>([{ id: 1 }, { id: 2 }, { id: 3 }]);
      setState((s) => {
        s[3] = { id: 4 };
      });
      flush();
      const last = follow(() => state[3]);
      flush();
      expect(last.v).toEqual({ id: 4 });
      setState(reconcile([{ id: 1 }], "id"));
      flush();
      expect(state.length).toBe(1);
      expect(last.v).toBe(undefined);
      expect(state[3]).toBe(undefined);
    });

    test("Reconcile swaps a property whose value is another store's proxy", () => {
      type Row = { id: number; name: string };
      const [rowA] = createStore<Row>({ id: 1, name: "a" });
      const [rowB] = createStore<Row>({ id: 2, name: "b" });
      const effA = follow(() => ({ id: rowA.id, name: rowA.name }));
      const effB = follow(() => ({ id: rowB.id, name: rowB.name }));
      flush();
      expect(effA.v).toEqual({ id: 1, name: "a" });
      expect(effB.v).toEqual({ id: 2, name: "b" });
      const [state, setState] = createStore<{ selected: Row }>({ selected: rowA });
      const selectedName = follow(() => state.selected.name);
      flush();
      expect(selectedName.v).toBe("a");
      setState(reconcile({ selected: rowB }, "id"));
      flush();
      expect(state.selected.id).toBe(2);
      expect(state.selected.name).toBe("b");
      expect(selectedName.v).toBe("b");
    });

    test("Reconcile reorders an array whose items are store proxies", () => {
      type Row = { id: number; name: string };
      const [rowA] = createStore<Row>({ id: 1, name: "a" });
      const [rowB] = createStore<Row>({ id: 2, name: "b" });
      follow(() => rowA.name + rowB.name);
      flush();
      const [list, setList] = createStore<Row[]>([rowA, rowB]);
      const names = follow(() => list.map((r) => r?.name).join(","));
      flush();
      expect(names.v).toBe("a,b");
      setList(reconcile([rowB, rowA], "id"));
      flush();
      expect(names.v).toBe("b,a");
      expect(list[0]!.id).toBe(2);
      expect(list[1]!.id).toBe(1);
      expect(snapshot(list)).toEqual([
        { id: 2, name: "b" },
        { id: 1, name: "a" },
      ]);
    });

    gap(
      "store-in-place",
      "a keyless swap merges the new object's values into the old one, which another store owns",
      "Reconcile swaps keyless store-proxy property values",
      () => {
        type Row = { name: string };
        const [rowA] = createStore<Row>({ name: "a" });
        const [rowB] = createStore<Row>({ name: "b" });
        follow(() => rowA.name + rowB.name);
        flush();
        const [state, setState] = createStore<{ selected: Row }>({ selected: rowA });
        const selectedName = follow(() => state.selected.name);
        flush();
        expect(selectedName.v).toBe("a");
        setState(reconcile({ selected: rowB }, "id"));
        flush();
        expect(state.selected.name).toBe("b");
        expect(selectedName.v).toBe("b");
        // Solid keeps rowA as it was; reactre wrote "b" into it.
        expect(rowA.name).toBe("a");
      },
    );
  });

  describe("reconcile with symbol-keyed properties", () => {
    const META = Symbol("meta");
    const why = "reconcile compares and copies string keys only";

    gap("symbol-keys", why, "notifies an effect tracking a symbol-keyed property", () => {
      const [state, setState] = createStore<Record<PropertyKey, unknown>>({ id: 1, [META]: "old" });
      const seen = follow(() => state[META]);
      flush();
      expect(seen.v).toBe("old");
      setState(reconcile<Record<PropertyKey, unknown>>({ id: 1, [META]: "new" }, "id"));
      flush();
      expect(state[META]).toBe("new");
      expect(seen.v).toBe("new");
    });

    test("string control updates through the identical path", () => {
      const [state, setState] = createStore<Record<PropertyKey, unknown>>({ id: 1, meta: "old" });
      const seen = follow(() => state["meta"]);
      flush();
      setState(reconcile<Record<PropertyKey, unknown>>({ id: 1, meta: "new" }, "id"));
      flush();
      expect(state["meta"]).toBe("new");
      expect(seen.v).toBe("new");
    });

    gap("symbol-keys", why, "a symbol `in` check updates when reconcile adds the key", () => {
      const [state, setState] = createStore<Record<PropertyKey, unknown>>({ id: 1 });
      const has = follow(() => META in state);
      flush();
      expect(has.v).toBe(false);
      setState(reconcile<Record<PropertyKey, unknown>>({ id: 1, [META]: "added" }, "id"));
      flush();
      expect(has.v).toBe(true);
    });
  });

  describe("reconcile without a key (positional merge)", () => {
    test("merges arrays positionally, preserving slot proxy identity", () => {
      const [state, setState] = createStore({
        rows: [
          { id: 1, count: 10, queries: [{ elapsed: 1 }] },
          { id: 2, count: 20, queries: [{ elapsed: 2 }] },
        ],
      });
      const row0 = state.rows[0];
      const row1 = state.rows[1];
      setState((s) => {
        reconcile(
          [
            { id: 7, count: 11, queries: [{ elapsed: 3 }] },
            { id: 8, count: 21, queries: [{ elapsed: 4 }] },
          ],
          null,
        )(s.rows);
      });
      expect(state.rows[0]).toBe(row0!);
      expect(state.rows[1]).toBe(row1!);
      expect(state.rows[0]!.id).toBe(7);
      expect(state.rows[0]!.count).toBe(11);
      expect(state.rows[0]!.queries[0]!.elapsed).toBe(3);
      expect(state.rows[1]!.count).toBe(21);
    });

    test("only changed leaves notify", () => {
      const [state, setState] = createStore({ rows: [{ a: 1, b: 2 }] });
      const a = follow(() => state.rows[0]!.a);
      const b = follow(() => state.rows[0]!.b);
      flush();
      const [aRuns, bRuns] = [a.runs, b.runs];
      setState(reconcile({ rows: [{ a: 5, b: 2 }] }, null));
      flush();
      expect(state.rows[0]!.a).toBe(5);
      expect(a.runs - aRuns).toBe(1);
      expect(b.runs - bRuns).toBe(0);
    });

    test("handles growth and shrink positionally", () => {
      const [state, setState] = createStore<{ items: { v: number }[] }>({ items: [{ v: 1 }, { v: 2 }] });
      setState(reconcile({ items: [{ v: 1 }, { v: 2 }, { v: 3 }] }, null));
      expect(state.items.length).toBe(3);
      expect(state.items[2]!.v).toBe(3);
      setState(reconcile({ items: [{ v: 9 }] }, null));
      expect(state.items.length).toBe(1);
      expect(state.items[0]!.v).toBe(9);
    });

    describe("array/object shape changes at an array slot", () => {
      test("object -> array at an unkeyed position", () => {
        const [state, setState] = createStore<{ list: unknown[] }>({ list: [{ x: 1 }] });
        follow(() => (state.list[0] as { x: number }).x);
        flush();
        setState(reconcile<{ list: unknown[] }>({ list: [[10, 20]] }, "id"));
        flush();
        expect(Array.isArray(state.list[0])).toBe(true);
        expect(snapshot(state.list[0])).toEqual([10, 20]);
      });

      test("array -> object at an unkeyed position", () => {
        const [state, setState] = createStore<{ list: unknown[] }>({ list: [[10, 20]] });
        follow(() => (state.list[0] as number[])[0]);
        flush();
        setState(reconcile<{ list: unknown[] }>({ list: [{ x: 1 }] }, "id"));
        flush();
        expect(Array.isArray(state.list[0])).toBe(false);
        expect(snapshot(state.list[0])).toEqual({ x: 1 });
      });

      test("positional (key: null) merge keeps the incoming kind", () => {
        const [state, setState] = createStore<{ list: unknown[] }>({ list: [{ x: 1 }, [1]] });
        follow(() => [(state.list[0] as { x: number }).x, (state.list[1] as number[])[0]]);
        flush();
        setState(reconcile<{ list: unknown[] }>({ list: [[7], { y: 2 }] }, null));
        flush();
        expect(Array.isArray(state.list[0])).toBe(true);
        expect(Array.isArray(state.list[1])).toBe(false);
        expect(snapshot(state.list)).toEqual([[7], { y: 2 }]);
      });
    });

    test("does not enforce root identity", () => {
      const [state, setState] = createStore({ id: 1, v: 2 });
      setState(reconcile({ id: 9, v: 3 }, null));
      expect(state.id).toBe(9);
      expect(state.v).toBe(3);
    });

    const memoWhy = "core memo stores what a function it returns returns, as a setter's updater";

    gap("bug", memoWhy, "replaces a TRACKED function-valued object leaf without invoking it", () => {
      const before = (): unknown => "before";
      const calls: string[] = [];
      const after = (): unknown => calls.push("after");
      const [state, setState] = createStore<{ fn: () => unknown }>({ fn: before });
      const seen = follow(() => state.fn);
      flush();
      expect(seen.v).toBe(before);
      setState(reconcile({ fn: after }, null));
      flush();
      expect(seen.v).toBe(after);
      expect(state.fn).toBe(after);
      expect(calls).toEqual([]);
      state.fn();
      expect(calls).toEqual(["after"]);
    });

    gap("bug", memoWhy, "replaces a TRACKED function-valued array item without invoking it", () => {
      const calls: string[] = [];
      const before = [() => calls.push("a"), () => calls.push("b")];
      const after = [() => calls.push("c"), () => calls.push("d")];
      const [state, setState] = createStore<(() => unknown)[]>(before);
      const seen = follow(() => state[0]);
      flush();
      expect(seen.v).toBe(before[0]!);
      setState(reconcile<(() => unknown)[]>(after, null));
      flush();
      expect(seen.v).toBe(after[0]!);
      expect(state[0]).toBe(after[0]!);
      expect(state[1]).toBe(after[1]!);
      expect(calls).toEqual([]);
    });
  });

  describe("adoption after a draft write in the same batch (#3296)", () => {
    type Tagged = { count: number; tag?: string | undefined };
    function setup(): {
      store: Tagged;
      setStore: StoreSetter<Tagged>;
      count: () => number;
      hasTag: () => boolean;
      seen: number[];
    } {
      const [store, setStore] = createStore<Tagged>({ count: 0, tag: "a" });
      const seen: number[] = [];
      const [count, hasTag] = createRoot(() => {
        reaction(
          () => store.count,
          (v) => void seen.push(v),
        );
        return [memo(() => store.count), memo(() => "tag" in store)] as const;
      });
      flush();
      expect(count()).toBe(0);
      seen.length = 0;
      return { store, setStore, count, hasTag, seen };
    }

    test("reconcile back to the committed value cancels the draft write", () => {
      const { store, setStore, count, seen } = setup();
      flush(() => {
        setStore((s) => {
          s.count = 1;
        });
        setStore(reconcile<Tagged>({ count: 0, tag: "a" }));
      });
      expect(store.count).toBe(0);
      expect(count()).toBe(0);
      expect(seen.every((v) => v === 0)).toBe(true);
    });

    test("a returned replacement back to the committed value cancels the draft write", () => {
      const { store, setStore, count, seen } = setup();
      flush(() => {
        setStore((s) => {
          s.count = 1;
        });
        setStore(() => ({ count: 0, tag: "a" }));
      });
      expect(store.count).toBe(0);
      expect(count()).toBe(0);
      expect(seen.every((v) => v === 0)).toBe(true);
    });

    test("an adoption that changes the key still wins over the draft", () => {
      const { store, setStore, count } = setup();
      flush(() => {
        setStore((s) => {
          s.count = 1;
        });
        setStore(reconcile<Tagged>({ count: 5, tag: "a" }));
      });
      expect(store.count).toBe(5);
      expect(count()).toBe(5);
    });

    test("a draft delete cancelled by an adoption restores membership", () => {
      const { store, setStore, hasTag } = setup();
      expect(hasTag()).toBe(true);
      flush(() => {
        setStore((s) => {
          delete s.tag;
        });
        setStore(reconcile<Tagged>({ count: 0, tag: "a" }));
      });
      expect("tag" in store).toBe(true);
      expect(hasTag()).toBe(true);
    });

    gap(
      "store-in-place",
      "the draft writes into the object given, so returning that object adopts the write",
      "a returned replacement that is the SAME raw as committed still cancels the draft",
      () => {
        const raw = { count: 0, tag: "a" as string | undefined };
        const [store, setStore] = createStore(raw);
        const count = createRoot(() => memo(() => store.count));
        flush(() => {
          setStore((s) => {
            s.count = 1;
          });
          setStore(() => raw);
        });
        expect(store.count).toBe(0);
        expect(count()).toBe(0);
      },
    );

    test("a draft write after a deferred adoption composes: adoption keys and draft keys both land", () => {
      const { store, setStore, count } = setup();
      const tag = createRoot(() => memo(() => store.tag));
      flush(() => {
        setStore(() => ({ count: 7, tag: "b" }));
        setStore((s) => {
          s.count = 9;
        });
      });
      expect(store.count).toBe(9);
      expect(store.tag).toBe("b");
      expect(count()).toBe(9);
      expect(tag()).toBe("b");
    });

    test("the direct-draft control: writing back in a draft already agrees", () => {
      const { store, setStore, count } = setup();
      flush(() => {
        setStore((s) => {
          s.count = 1;
        });
        setStore((s) => {
          s.count = 0;
        });
      });
      expect(store.count).toBe(0);
      expect(count()).toBe(0);
    });
  });
});
