// Ports of Solid 2.0's store tests to @reactre/core/features/store: createStore's reads, writes,
// tracking and wrapping (packages/signals/tests/store/createStore.test.ts), platform objects
// (store/native-collections.test.ts), shallow stores (store/shallow.test.ts), storePath
// (store/storePath.test.ts), merge, omit, deep and snapshot (store/utilities.test.ts), and a
// store read in compiled TSX (packages/web/test/for.nonkeyed.store.spec.tsx), with the reads the
// compiler follows to a store and the ones it does not (the store-alias target).
//
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's createEffect(compute, fn) is `reaction(compute, apply)`, createMemo is core's `memo`,
// createSignal core's `signal`, storePath features/store's `path`. Where Solid writes twice before
// one flush() and the order of those writes matters, the port makes them in one `flush(fn)`,
// which applies them together as Solid's flush does.

import { describe, expect, mock, test } from "bun:test";
import { types } from "node:util";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import { map } from "../../src/features/lists.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { createStore, deep, merge, omit, path, reconcile, snapshot } from "../../src/features/store.ts";
import { flush } from "../../src/features/timing.ts";
import { effect, memo, signal, untrack } from "../../src/index.ts";
import { base, compile, gap } from "./harness.ts";

/**
 * Solid's createEffect(compute, fn) for a compute that returns nothing: `fn` runs, untracked,
 * after each run of `compute`, as Solid runs it. `reaction` runs its `apply` only for a new value,
 * and each of these computes returns undefined.
 */
function createEffect(compute: () => void, fn: () => void): void {
  effect(() => {
    compute();
    untrack(fn);
  });
}

describe("createStore.test.ts", () => {
  describe("State immutability", () => {
    gap("store-direct-write", "a direct write to a store throws; Solid ignores it", "Setting a property", () => {
      const [state] = createStore({ name: "John" });
      expect(state.name).toBe("John");
      state.name = "Jake";
      expect(state.name).toBe("John");
    });

    gap("store-direct-write", "a direct delete from a store throws; Solid ignores it", "Deleting a property", () => {
      const [state] = createStore<{ name?: string }>({ name: "John" });
      expect(state.name).toBe("John");
      delete state.name;
      expect(state.name as string | undefined).toBe("John");
    });
  });

  describe("State Getters", () => {
    test("Testing an update from state", () => {
      const [state] = createStore({
        name: "John",
        get greeting(): string {
          return `Hi, ${this.name}`;
        },
      });
      expect(state.greeting).toBe("Hi, John");
      // The read after the write is a held read: in this file's held-writes test.
    });

    test("Testing an update from state, through a memo", () => {
      let greeting!: () => string;
      const [state, setState] = createStore({
        name: "John",
        get greeting(): string {
          return greeting();
        },
      });
      createRoot(() => {
        greeting = memo(() => `Hi, ${state.name}`);
      });
      expect(state.greeting).toBe("Hi, John");
      setState((s) => {
        s.name = "Jake";
      });
      flush();
      expect(state.greeting).toBe("Hi, Jake");
    });
  });

  describe("Unwrapping Edge Cases", () => {
    test("Unwrap nested frozen state object", () => {
      const [state] = createStore({ data: Object.freeze({ user: { firstName: "John", lastName: "Snow" } }) }),
        s = snapshot(state);
      expect(s.data.user.firstName).toBe("John");
      expect(s.data.user.lastName).toBe("Snow");
      expect(types.isProxy(s.data.user)).toBe(false);
    });

    test("Unwrap nested frozen array", () => {
      const [state] = createStore({ data: [{ user: { firstName: "John", lastName: "Snow" } }] }),
        s = snapshot({ data: state.data });
      expect(s.data[0]!.user.firstName).toBe("John");
      expect(s.data[0]!.user.lastName).toBe("Snow");
      expect(types.isProxy(s.data[0]!.user)).toBe(false);
    });

    test("Unwrap nested frozen state array", () => {
      const [state] = createStore({ data: Object.freeze([{ user: { firstName: "John", lastName: "Snow" } }]) }),
        s = snapshot(state);
      expect(s.data[0]!.user.firstName).toBe("John");
      expect(s.data[0]!.user.lastName).toBe("Snow");
      expect(types.isProxy(s.data[0]!.user)).toBe(false);
    });
  });

  describe("Tracking State changes", () => {
    test("Track a state change", () => {
      const [state, setState] = createStore({ data: 2 });
      createRoot(() => {
        let executionCount = 0;
        expect.assertions(2);
        createEffect(
          () => {
            if (executionCount === 0) expect(state.data).toBe(2);
            else if (executionCount === 1) expect(state.data).toBe(5);
            else expect(executionCount).toBe(-1);
          },
          () => {
            executionCount++;
          },
        );
      });
      flush();
      setState((s) => {
        s.data = 5;
      });
      flush();
      // The same value again does not re-run it.
      setState((s) => {
        s.data = 5;
      });
      flush();
    });

    test("Track a nested state change", () => {
      const [state, setState] = createStore({ user: { firstName: "John", lastName: "Smith" } });
      createRoot(() => {
        let executionCount = 0;
        expect.assertions(2);
        createEffect(
          () => {
            if (executionCount === 0) expect(state.user.firstName).toBe("John");
            else if (executionCount === 1) expect(state.user.firstName).toBe("Jake");
            else expect(executionCount).toBe(-1);
          },
          () => {
            executionCount++;
          },
        );
      });
      flush();
      setState((s) => {
        s.user.firstName = "Jake";
      });
      flush();
    });

    test("Track array item on removal", () => {
      const [state, setState] = createStore([1]);
      createRoot(() => {
        let executionCount = 0;
        expect.assertions(2);
        createEffect(
          () => {
            if (executionCount === 0) expect(state[0]).toBe(1);
            else if (executionCount === 1) expect(state[0]).toBe(undefined);
            else expect(executionCount).toBe(-1);
          },
          () => {
            executionCount++;
          },
        );
      });
      flush();
      setState((s) => {
        s.pop();
      });
      flush();
    });

    test("Tracking Top-Level Array iteration", () => {
      const [state, setState] = createStore<string[]>(["hi"]);
      let executionCount = 0;
      let executionCount2 = 0;
      const check = (n: number): void => {
        if (n === 0) expect(state.length).toBe(1);
        else if (n === 1) {
          expect(state.length).toBe(2);
          expect(state[1]).toBe("item");
        } else if (n === 2) {
          expect(state.length).toBe(2);
          expect(state[1]).toBe("new");
        } else if (n === 3) expect(state.length).toBe(1);
        else expect(n).toBe(-1);
      };
      createRoot(() => {
        createEffect(
          () => {
            for (let i = 0; i < state.length; i++) void state[i];
            untrack(() => check(executionCount));
          },
          () => {
            executionCount++;
          },
        );
        createEffect(
          () => {
            for (const item of state) void item;
            untrack(() => check(executionCount2));
          },
          () => {
            executionCount2++;
          },
        );
      });
      flush();
      setState((s) => {
        s[1] = "item";
      });
      flush();
      setState((s) => {
        s[1] = "new";
      });
      flush();
      setState((s) => [s[0]!]);
      flush();
      expect.assertions(12);
    });

    test("Tracking Top-Level Array iteration, through mapArray", () => {
      const [state, setState] = createStore<string[]>(["hi"]);
      const lengths: number[] = [];
      createRoot(() => {
        const mapped = map(
          () => state,
          (item) => item,
        );
        reaction(
          () => mapped(),
          () => void lengths.push(state.length),
        );
      });
      setState((s) => {
        s[1] = "item";
      });
      setState((s) => [s[0]!]);
      expect(lengths).toEqual([1, 2, 1]);
    });

    test("Tracking iteration Object key addition/removal", () => {
      const [state, setState] = createStore<{ obj: { item?: number } }>({ obj: {} });
      let executionCount = 0;
      let executionCount2 = 0;
      createRoot(() => {
        createEffect(
          () => {
            const keys = Object.keys(state.obj);
            if (executionCount === 0) expect(keys.length).toBe(0);
            else if (executionCount === 1) {
              expect(keys.length).toBe(1);
              expect(keys[0]).toBe("item");
            } else if (executionCount === 2) expect(keys.length).toBe(0);
            else expect(executionCount).toBe(-1);
          },
          () => {
            executionCount++;
          },
        );
        createEffect(
          () => {
            for (const key in state.obj) void key;
            const u = snapshot(state.obj);
            if (executionCount2 === 0) expect(u.item).toBeUndefined();
            else if (executionCount2 === 1) expect(u.item).toBe(5);
            else if (executionCount2 === 2) expect(u.item).toBeUndefined();
            else expect(executionCount2).toBe(-1);
          },
          () => {
            executionCount2++;
          },
        );
      });
      flush();
      setState((s) => {
        s.obj.item = 5;
      });
      flush();
      setState((s) => {
        delete s.obj.item;
      });
      flush();
      expect.assertions(7);
    });

    test("Doesn't trigger object on addition/removal", () => {
      const [state, setState] = createStore<{ obj: { item?: number } }>({ obj: {} });
      let executionCount = 0;
      createRoot(() => {
        reaction(
          () => snapshot(state.obj),
          (v) => {
            if (executionCount === 0) expect(v.item).toBeUndefined();
            else expect(executionCount).toBe(-1);
            executionCount++;
          },
        );
      });
      flush();
      setState((s) => {
        s.obj.item = 5;
      });
      flush();
      setState((s) => {
        delete s.obj.item;
      });
      flush();
      expect.assertions(1);
    });

    test("Tracking Top level iteration Object key addition/removal", () => {
      const [state, setState] = createStore<{ item?: number }>({});
      let executionCount = 0;
      let executionCount2 = 0;
      createRoot(() => {
        createEffect(
          () => {
            const keys = Object.keys(state);
            if (executionCount === 0) expect(keys.length).toBe(0);
            else if (executionCount === 1) {
              expect(keys.length).toBe(1);
              expect(keys[0]).toBe("item");
            } else if (executionCount === 2) expect(keys.length).toBe(0);
            else expect(executionCount).toBe(-1);
          },
          () => {
            executionCount++;
          },
        );
        createEffect(
          () => {
            for (const key in state) void key;
            const u = snapshot(state);
            if (executionCount2 === 0) expect(u.item).toBeUndefined();
            else if (executionCount2 === 1) expect(u.item).toBe(5);
            else if (executionCount2 === 2) expect(u.item).toBeUndefined();
            else expect(executionCount2).toBe(-1);
          },
          () => {
            executionCount2++;
          },
        );
      });
      flush();
      setState((s) => {
        s.item = 5;
      });
      flush();
      setState((s) => {
        delete s.item;
      });
      flush();
      expect.assertions(7);
    });

    test("Not Tracking Top level key addition/removal", () => {
      const [state, setState] = createStore<{ item?: number; item2?: number }>({});
      let executionCount = 0;
      createRoot(() => {
        createEffect(
          () => {
            if (executionCount === 0) expect(state.item2).toBeUndefined();
            else expect(executionCount).toBe(-1);
          },
          () => {
            executionCount++;
          },
        );
      });
      flush();
      setState((s) => {
        s.item = 5;
      });
      flush();
      setState((s) => {
        delete s.item;
      });
      flush();
      expect.assertions(1);
    });
  });

  describe("Handling functions in state", () => {
    test("Array Native Methods: Array.Filter", () => {
      createRoot(() => {
        const [state] = createStore({ list: [0, 1, 2] }),
          getFiltered = memo(() => state.list.filter((i) => i % 2));
        expect(getFiltered()).toStrictEqual([1]);
      });
    });

    test("Track function change", () => {
      const [state, setState] = createStore<{ fn: () => number }>({ fn: () => 1 }),
        getValue = memo(() => state.fn());
      setState((s) => {
        s.fn = () => 2;
      });
      flush();
      expect(getValue()).toBe(2);
    });
  });

  describe("Setting state from Effects", () => {
    test("Setting state from signal", () => {
      const [getData, setData] = signal("init"),
        [state, setState] = createStore({ data: "" });
      createRoot(() => {
        reaction(getData, (v) =>
          setState((s) => {
            s.data = v;
          }),
        );
      });
      setData("signal");
      flush();
      expect(state.data).toBe("signal");
    });

    test("Select Promise", async () => {
      const p = new Promise<string>((resolve) => setTimeout(resolve, 20, "promised"));
      const [state, setState] = createStore({ data: "" });
      void p.then((v) =>
        setState((s) => {
          s.data = v;
        }),
      );
      await p;
      flush();
      expect(state.data).toBe("promised");
    });
  });

  describe("State wrapping", () => {
    test("Setting plain object", () => {
      const data = { withProperty: "y" },
        [state] = createStore({ data });
      expect(state.data).not.toBe(data);
    });

    test("Setting plain array", () => {
      const data = [1, 2, 3],
        [state] = createStore({ data });
      expect(state.data).not.toBe(data);
    });
  });

  describe("Array length", () => {
    test("Setting plain object", () => {
      const [state, setState] = createStore<{ list: number[] }>({ list: [] });
      let length: number | undefined;
      const list = state.list;
      createRoot(() => {
        reaction(
          () => list.length,
          (v) => {
            length = v;
          },
        );
      });
      flush();
      expect(length).toBe(0);
      setState((s) => {
        s.list[0] = 1;
      });
      flush();
      expect(length).toBe(1);
    });

    test("direct array index extension updates length immediately", () => {
      const [state, setState] = createStore<number[]>([10, 11, 12]);
      setState((s) => {
        expect(s.length).toBe(3);
        s[3] = 20;
        expect(s.length).toBe(4);
        expect(s[3]).toBe(20);
      });
      flush();
      expect(state.length).toBe(4);
      expect(state[3]).toBe(20);
    });

    test("direct array index extension to undefined still updates length", () => {
      const [state, setState] = createStore<(number | undefined)[]>([10, 11, 12]);
      setState((s) => {
        expect(s.length).toBe(3);
        s[s.length] = undefined;
        expect(s.length).toBe(4);
        expect("3" in s).toBe(true);
        expect(s[3]).toBeUndefined();
      });
      flush();
      expect(state.length).toBe(4);
      expect("3" in state).toBe(true);
      expect(state[3]).toBeUndefined();
    });
  });

  describe("State recursion", () => {
    test("there is no infinite loop", () => {
      const x: { a: number; b: unknown } = { a: 1, b: undefined };
      x.b = x;
      const [state] = createStore(x);
      expect(state.a).toBe((state.b as typeof x).a);
    });
  });

  describe("Nested Classes", () => {
    class CustomThing {
      a: number;
      b: number;
      constructor(value: number) {
        this.a = value;
        this.b = 10;
      }
    }
    const why = "a store wraps plain objects and arrays only; Solid wraps class instances";

    gap("class-instances", why, "wrapped nested class", () => {
      const [inner] = createStore(new CustomThing(1));
      const [store, setStore] = createStore<{ inner: CustomThing }>({ inner });
      expect(store.inner.a).toBe(1);
      expect(store.inner.b).toBe(10);
      let sum: number | undefined;
      createRoot(() => {
        reaction(
          () => store.inner.a + store.inner.b,
          (v) => {
            sum = v;
          },
        );
      });
      flush();
      expect(sum).toBe(11);
      setStore((s) => {
        s.inner.a = 10;
      });
      flush();
      expect(sum).toBe(20);
      setStore((s) => {
        s.inner.b = 5;
      });
      flush();
      expect(sum).toBe(15);
    });

    gap("class-instances", why, "not wrapped nested class", () => {
      const [store, setStore] = createStore({ inner: new CustomThing(1) });
      let sum: number | undefined;
      createRoot(() => {
        reaction(
          () => store.inner.a + store.inner.b,
          (v) => {
            sum = v;
          },
        );
      });
      flush();
      expect(sum).toBe(11);
      setStore((s) => {
        s.inner.a = 10;
      });
      flush();
      expect(sum).toBe(20);
      setStore((s) => {
        s.inner.b = 5;
      });
      flush();
      expect(sum).toBe(15);
    });

    gap("class-instances", why, "prototype getters track instance field updates", () => {
      class Thing {
        a = 1;
        b = 10;
        get sum(): number {
          return this.a + this.b;
        }
      }
      const [store, setStore] = createStore(new Thing());
      let sum: number | undefined;
      createRoot(() => {
        reaction(
          () => store.sum,
          (v) => {
            sum = v;
          },
        );
      });
      flush();
      expect(sum).toBe(11);
      setStore((s) => {
        s.a = 10;
      });
      flush();
      expect(sum).toBe(20);
    });

    test("does not wrap Node instances", () => {
      class NodeMock {}
      const g = globalThis as Record<string, unknown>;
      const prevNode = g["Node"];
      Object.defineProperty(globalThis, "Node", { value: NodeMock, configurable: true, writable: true });
      try {
        const node = new NodeMock();
        const [store, setStore] = createStore<{ inner?: NodeMock }>({});
        setStore((s) => {
          s.inner = node;
        });
        flush();
        expect(store.inner).toBe(node);
      } finally {
        if (prevNode === undefined) delete g["Node"];
        else Object.defineProperty(globalThis, "Node", { value: prevNode, configurable: true, writable: true });
      }
    });
  });

  describe("In Operator", () => {
    test("wrapped nested class", () => {
      let access = 0;
      const [store, setStore] = createStore<{ a?: number; b?: number; c?: number }>({
        a: 1,
        get b() {
          access++;
          return 2;
        },
      });
      expect("a" in store).toBe(true);
      expect("b" in store).toBe(true);
      expect("c" in store).toBe(false);
      expect(access).toBe(0);
      const [a, b, c] = createRoot(() => [
        memo(() => "a" in store),
        memo(() => "b" in store),
        memo(() => "c" in store),
      ]);
      expect([a(), b(), c(), access]).toEqual([true, true, false, 0]);
      setStore((s) => {
        s.c = 3;
      });
      flush();
      expect([a(), b(), c(), access]).toEqual([true, true, true, 0]);
      setStore((s) => {
        delete s.a;
      });
      flush();
      expect([a(), b(), c(), access]).toEqual([false, true, true, 0]);
      expect("a" in store).toBe(false);
      expect("b" in store).toBe(true);
      expect("c" in store).toBe(true);
      expect(access).toBe(0);
    });

    test("batches like signals on cold writes", () => {
      const [store, setStore] = createStore<{ a?: number; b?: number }>({ a: 1 });
      expect("a" in store).toBe(true);
      expect("b" in store).toBe(false);
      setStore((s) => {
        s.b = 2;
        delete s.a;
      });
      // The reads before the flush are held reads: in this file's held-writes test.
      flush();
      expect("a" in store).toBe(false);
      expect("b" in store).toBe(true);
      expect(store.a).toBeUndefined();
      expect(store.b).toBe(2);
    });
  });

  describe("getters", () => {
    test("supports getters that return frozen objects", () => {
      const [store] = createStore({
        get foo() {
          return Object.freeze({ foo: "foo" });
        },
      });
      expect(() => store.foo).not.toThrow();
    });

    gap(
      "draft-define",
      "Object.defineProperty on a draft notifies nothing",
      "supports Object.defineProperty inside a setter",
      () => {
        const [store, setStore] = createStore<{ value: number; existing: number; added?: number }>({
          value: 0,
          existing: 0,
        });
        let existing: number | undefined;
        let added: number | undefined;
        createRoot(() => {
          reaction(
            () => store.existing,
            (v) => {
              existing = v;
            },
          );
          reaction(
            () => store.added,
            (v) => {
              added = v;
            },
          );
        });
        flush();
        expect(existing).toBe(0);
        expect(added).toBeUndefined();
        setStore((s) => {
          Object.defineProperty(s, "existing", { configurable: true, enumerable: true, get: () => store.value });
          Object.defineProperty(s, "added", { configurable: true, enumerable: true, get: () => store.value });
        });
        flush();
        expect(store.existing).toBe(0);
        expect(store.added).toBe(0);
        expect(existing).toBe(0);
        expect(added).toBe(0);
        setStore((s) => {
          s.value = 1;
        });
        flush();
        expect(store.existing).toBe(1);
        expect(store.added).toBe(1);
        expect(existing).toBe(1);
        expect(added).toBe(1);
      },
    );
  });

  describe("objects", () => {
    test("updates", () => {
      const [store, setStore] = createStore({ foo: "foo" });
      const effect = mock();
      createRoot(() =>
        reaction(
          () => store.foo,
          (v) => effect(v),
        ),
      );
      flush();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledWith("foo");
      setStore((s) => {
        s.foo = "bar";
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      expect(store.foo).toBe("bar");
    });

    test("updates with nested object", () => {
      const [store, setStore] = createStore({ foo: { bar: "bar" } });
      const effect = mock();
      createRoot(() =>
        reaction(
          () => store.foo.bar,
          (v) => effect(v),
        ),
      );
      flush();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledWith("bar");
      setStore((s) => {
        s.foo.bar = "baz";
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      expect(effect).toHaveBeenCalledWith("baz");
    });

    test("ignores prototype pollution keys in draft setters", () => {
      const [store, setStore] = createStore<Record<string, unknown>>({ a: 1 });
      let inheritedConstructor: unknown;
      setStore((s) => {
        s["__proto__"] = { polluted_a: true };
        inheritedConstructor = s["constructor"];
        s["prototype"] = "value";
        s["constructor"] = "value";
      });
      flush();
      expect(store["a"]).toBe(1);
      expect(store["prototype"]).toBe("value");
      expect(store["constructor"]).toBe("value");
      expect(inheritedConstructor).toBeUndefined();
      expect(({} as Record<string, unknown>)["polluted_a"]).toBeUndefined();
    });

    gap(
      "store-direct-write",
      "a direct write to a store throws; Solid ignores it",
      "is immutable from the outside",
      () => {
        const [store] = createStore({ foo: "foo" });
        const effect = mock();
        createRoot(() =>
          reaction(
            () => store.foo,
            (v) => effect(v),
          ),
        );
        flush();
        expect(effect).toHaveBeenCalledTimes(1);
        store.foo = "bar";
        flush();
        expect(effect).toHaveBeenCalledTimes(1);
        expect(store.foo).toBe("foo");
      },
    );

    test("has properties", () => {
      const [store, setStore] = createStore<{ foo?: string | undefined }>({});
      const effect = mock();
      createRoot(() =>
        reaction(
          () => "foo" in store,
          (v) => effect(v),
        ),
      );
      flush();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledWith(false);
      setStore((s) => {
        s.foo = "bar";
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      expect(effect).toHaveBeenCalledWith(true);
      setStore((s) => {
        s.foo = undefined;
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      setStore((s) => {
        delete s.foo;
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(3);
      expect(effect).toHaveBeenCalledWith(false);
    });
  });

  describe("arrays", () => {
    test("supports arrays", () => {
      const [store, setStore] = createStore([{ i: 1 }, { i: 2 }, { i: 3 }]);
      const effectA = mock();
      const effectB = mock();
      const effectC = mock();
      createRoot(() => {
        reaction(
          () => store.reduce((m, n) => m + n.i, 0),
          (v) => effectA(v),
        );
        reaction(
          () => {
            const row = store[0]!;
            reaction(
              () => row.i,
              (v) => effectC(v),
            );
            return snapshot(row);
          },
          (v) => effectB(v.i),
        );
      });
      flush();
      expect(effectA).toHaveBeenCalledTimes(1);
      expect(effectA).toHaveBeenCalledWith(6);
      expect(effectB).toHaveBeenCalledTimes(1);
      expect(effectB).toHaveBeenCalledWith(1);
      expect(effectC).toHaveBeenCalledTimes(1);
      expect(effectC).toHaveBeenCalledWith(1);
      setStore((s) => {
        s[0]!.i = 2;
      });
      flush();
      expect(effectA).toHaveBeenCalledTimes(2);
      expect(effectA).toHaveBeenCalledWith(7);
      expect(effectB).toHaveBeenCalledTimes(1);
      expect(effectC).toHaveBeenCalledTimes(2);
      expect(effectC).toHaveBeenCalledWith(2);
      setStore((s) => {
        s.push({ i: 4 });
      });
      flush();
      expect(effectA).toHaveBeenCalledTimes(3);
      expect(effectA).toHaveBeenCalledWith(11);
      expect(effectB).toHaveBeenCalledTimes(1);
      expect(effectC).toHaveBeenCalledTimes(2);
    });
  });

  describe("derived store manual writes", () => {
    test("a source change in the setStore's flush re-runs the fold; a draft-ignoring fold discards the write (core R31, #3733 rule B)", () => {
      const [setSource, store, setStore] = createRoot(() => {
        const [source, sSource] = signal({ count: 0 });
        const [s, sStore] = createStore<{ count: number }>(() => ({ count: source().count }), { count: 0 });
        return [sSource, s, sStore] as const;
      });
      flush();
      expect(store.count).toBe(0);
      flush(() => {
        setSource({ count: 1 });
        setStore((s) => {
          s.count = 99;
        });
      });
      expect(store.count).toBe(1);
      setStore((s) => {
        s.count = 99;
      });
      flush();
      expect(store.count).toBe(99);
      setSource({ count: 2 });
      flush();
      expect(store.count).toBe(2);
    });

    test("a same-value setStore does not hold against a same-flush source change (core R31, #3733 rule B)", () => {
      const [setSource, store, setStore] = createRoot(() => {
        const [source, sSource] = signal({ count: 0 });
        const [s, sStore] = createStore<{ count: number }>(() => ({ count: source().count }), { count: 0 });
        return [sSource, s, sStore] as const;
      });
      flush();
      setStore((s) => {
        s.count = 99;
      });
      flush();
      expect(store.count).toBe(99);
      flush(() => {
        setSource({ count: 1 });
        setStore((s) => {
          s.count = 99;
        });
      });
      expect(store.count).toBe(1);
      setSource({ count: 2 });
      flush();
      expect(store.count).toBe(2);
    });
  });

  describe("Proxy invariant correctness", () => {
    test("Object.keys does not throw for stores wrapping objects with non-configurable own properties", () => {
      const source: Record<string, unknown> = {};
      Object.defineProperty(source, "id", { value: 1, enumerable: true, writable: true, configurable: false });
      const [store] = createStore(source);
      expect(() => Object.keys(store)).not.toThrow();
      expect(store["id"]).toBe(1);
    });

    test("Truncating array length clears stale indices from the store proxy", () => {
      const [list, setList] = createStore<number[]>([1, 2, 3]);
      setList((s) => {
        s.length = 2;
      });
      flush();
      expect(list.length).toBe(2);
      expect(list[2]).toBeUndefined();
      expect(2 in list).toBe(false);
      expect(Object.keys(list).filter((k) => k !== "length")).not.toContain("2");
    });

    test("getOwnPropertyDescriptor reports the written value, not the stale base value", () => {
      const [state, setState] = createStore({ count: 1 });
      setState((s) => {
        s.count++;
      });
      flush();
      expect(state.count).toBe(2);
      expect(Object.getOwnPropertyDescriptor(state, "count")?.value).toBe(2);
      setState((s) => {
        s.count++;
      });
      flush();
      expect(state.count).toBe(3);
      expect(Object.getOwnPropertyDescriptor(state, "count")?.value).toBe(3);
    });

    gap(
      "store-in-place",
      "a store writes into the object it was given, whose descriptors hold; Solid keeps writes beside it",
      "written non-configurable properties keep satisfying the proxy invariant",
      () => {
        const source = {} as { locked: number };
        Object.defineProperty(source, "locked", { value: 1, enumerable: true, writable: false, configurable: false });
        const [state, setState] = createStore(source);
        setState((s) => {
          s.locked = 2;
        });
        flush();
        expect(state.locked).toBe(2);
        expect(() => Object.keys(state)).not.toThrow();
        const desc = Object.getOwnPropertyDescriptor(state, "locked");
        expect(desc?.value).toBe(2);
        expect(desc?.configurable).toBe(true);
      },
    );

    test("writing over an inherited property yields an own data descriptor and a safe snapshot", () => {
      const proto = { label: "proto" };
      const [state, setState] = createStore<{ label: string }>(Object.create(proto) as { label: string });
      setState((s) => {
        s.label = "own";
      });
      flush();
      expect(state.label).toBe("own");
      expect(Object.getOwnPropertyDescriptor(state, "label")?.value).toBe("own");
      expect(snapshot(state).label).toBe("own");
    });
  });

  describe("Store key handling and tracked truncation", () => {
    test("Array truncation notifies tracked index reads (#2768)", () => {
      const [list, setList] = createStore<number[]>([1, 2, 3]);
      let tracked: number | undefined = -1;
      createRoot(() =>
        reaction(
          () => list[2],
          (v) => {
            tracked = v;
          },
        ),
      );
      flush();
      expect(tracked).toBe(3);
      setList((l) => {
        l.length = 2;
      });
      flush();
      expect(tracked).toBeUndefined();
    });

    test("Null-prototype store reads a function-valued property (#2771)", () => {
      const dictionary: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      dictionary["getValue"] = () => 42;
      const [store] = createStore(dictionary);
      expect(() => (store["getValue"] as () => number)()).not.toThrow();
      expect((store["getValue"] as () => number)()).toBe(42);
    });

    test("Non-index string properties on arrays do not change length", () => {
      const [list, setList] = createStore<Record<PropertyKey, unknown>>([] as unknown as Record<PropertyKey, unknown>);
      setList((current) => {
        current["01"] = "metadata";
      });
      flush();
      expect(list["01"]).toBe("metadata");
      expect((list as unknown as unknown[]).length).toBe(0);
    });

    describe("symbol-keyed properties (#2769)", () => {
      const meta = Symbol("meta");

      test("Array symbol write is metadata, not an index write", () => {
        const [list, setList] = createStore<Record<PropertyKey, unknown>>([1, 2, 3] as unknown as Record<
          PropertyKey,
          unknown
        >);
        expect(() => {
          setList((l) => {
            l[meta] = 42;
          });
          flush();
        }).not.toThrow();
        expect(list[meta]).toBe(42);
        expect((list as unknown as number[]).length).toBe(3);
      });

      gap(
        "symbol-keys",
        "a returned replacement copies string keys only",
        "Returned object replacement keeps symbol keys",
        () => {
          const [returned, setReturned] = createStore<Record<PropertyKey, unknown>>({});
          setReturned(() => ({ [meta]: 42 }) as Record<PropertyKey, unknown>);
          flush();
          expect(returned[meta]).toBe(42);
        },
      );

      test("storePath root merge keeps symbol keys", () => {
        const [pathStore, setPathStore] = createStore<Record<PropertyKey, unknown>>({});
        setPathStore(path({ [meta]: 42 }));
        flush();
        expect(pathStore[meta]).toBe(42);
      });

      gap("symbol-keys", "merge and omit enumerate string keys only", "merge/omit enumerate symbol keys", () => {
        const [source] = createStore<Record<PropertyKey, unknown>>({ visible: true, [meta]: 42 });
        const merged = merge({ fallback: true }, source);
        const omitted = omit(source as Record<string, unknown>, "visible");
        expect((merged as Record<PropertyKey, unknown>)[meta]).toBe(42);
        expect(Reflect.ownKeys(merged).includes(meta)).toBe(true);
        expect((omitted as Record<PropertyKey, unknown>)[meta]).toBe(42);
        expect(Reflect.ownKeys(omitted).includes(meta)).toBe(true);
      });
    });
  });

  gap("held-writes", "a write is read at once, before flush()", "reads see a store write only after flush()", () => {
    // "Testing an update from state": the getter reads the old name until the flush.
    const [a, setA] = createStore({
      name: "John",
      get greeting(): string {
        return `Hi, ${this.name}`;
      },
    });
    setA((s) => {
      s.name = "Jake";
    });
    expect(a.greeting).toBe("Hi, John");
    // "Simple Key Value".
    const [b, setB] = createStore({ key: "" });
    setB((s) => {
      s.key = "value";
    });
    expect(b.key).toBe("");
    // "Test Array".
    const [todos, setTodos] = createStore([
      { id: 1, title: "Go To Work", done: true },
      { id: 2, title: "Eat Lunch", done: false },
    ]);
    setTodos((t) => {
      t[1]!.done = true;
    });
    setTodos((t) => {
      t.push({ id: 3, title: "Go Home", done: false });
    });
    setTodos((t) => {
      t.shift();
    });
    expect(Array.isArray(todos)).toBe(true);
    expect(todos[0]!.done).toBe(true);
    expect(todos[1]!.title).toBe("Eat Lunch");
    // "Test Array Nested".
    const [c, setC] = createStore({
      todos: [
        { id: 1, title: "Go To Work", done: true },
        { id: 2, title: "Eat Lunch", done: false },
      ],
    });
    setC((s) => {
      s.todos[1]!.done = true;
    });
    setC((s) => {
      s.todos.push({ id: 3, title: "Go Home", done: false });
    });
    expect(c.todos[1]!.done).toBe(false);
    expect(c.todos[2]).toBeUndefined();
    // "direct array index extension updates length immediately".
    const [d, setD] = createStore<number[]>([10, 11, 12]);
    setD((s) => {
      s[3] = 20;
    });
    expect(d.length).toBe(3);
    expect(d[3]).toBeUndefined();
    // "batches like signals on cold writes".
    const [e, setE] = createStore<{ a?: number; b?: number }>({ a: 1 });
    setE((s) => {
      s.b = 2;
      delete s.a;
    });
    expect("a" in e).toBe(true);
    expect("b" in e).toBe(false);
    // utilities.test.ts, "Clone Store": a merge over the store reads the old values too.
    const [f, setF] = createStore<{ a: string; b: string; c?: string }>({ a: "Hi", b: "Jo" });
    const clone = merge(f, {});
    setF((v) => {
      v.a = "Greetings";
      v.c = "John";
    });
    expect(clone.a).toBe("Hi");
    expect(clone.c).toBeUndefined();
  });
});

describe("native-collections.test.ts", () => {
  test("Map: reads work — methods, internal-slot accessors, iteration", () => {
    const [store] = createStore({ map: new Map<string, number>([["k", 1]]) });
    expect(store.map.get("k")).toBe(1);
    expect(store.map.has("k")).toBe(true);
    expect(store.map.size).toBe(1);
    expect([...store.map.keys()]).toEqual(["k"]);
  });

  test("Set: reads work — methods, internal-slot accessors, iteration", () => {
    const [store] = createStore({ set: new Set<number>([1, 2]) });
    expect(store.set.has(2)).toBe(true);
    expect(store.set.size).toBe(2);
    expect([...store.set]).toEqual([1, 2]);
  });

  test("platform objects are served raw, not proxied", () => {
    const map = new Map([["k", 1]]);
    const date = new Date(2026, 0, 15);
    const [store] = createStore({ map, date });
    expect(store.map).toBe(map);
    expect(store.date).toBe(date);
  });

  test("Map/Set: draft methods mutate the raw collection without throwing", () => {
    const [store, setStore] = createStore({ map: new Map<string, number>([["k", 1]]), set: new Set<number>([1, 2]) });
    setStore((s) => {
      s.map.set("k2", 2);
      s.map.delete("k");
      s.set.add(3);
    });
    expect(store.map.get("k2")).toBe(2);
    expect(store.map.has("k")).toBe(false);
    expect(store.map.size).toBe(1);
    expect(store.set.has(3)).toBe(true);
    expect(store.set.size).toBe(3);
  });

  test("Date: internal-slot methods work on read and draft paths", () => {
    const [store, setStore] = createStore({ date: new Date(2026, 0, 15) });
    expect(store.date.getFullYear()).toBe(2026);
    setStore((s) => {
      s.date.setFullYear(2030);
    });
    expect(store.date.getFullYear()).toBe(2030);
  });

  test("the property holding a platform object tracks: reassignment notifies", () => {
    const [store, setStore] = createStore({ map: new Map([["k", 1]]) });
    let size: number | undefined;
    createRoot(() => {
      reaction(
        () => store.map.size,
        (v) => {
          size = v;
        },
      );
    });
    flush();
    expect(size).toBe(1);
    setStore((s) => {
      s.map = new Map([
        ["k", 1],
        ["k2", 2],
      ]);
    });
    flush();
    expect(size).toBe(2);
  });

  gap(
    "class-instances",
    "a store wraps plain objects and arrays only; Solid wraps class instances",
    "user-class methods on the draft keep the proxy `this` (reactive writes)",
    () => {
      class Counter {
        n = 1;
        increment(): void {
          this.n++;
        }
      }
      const [store, setStore] = createStore({ c: new Counter() });
      let seen: number | undefined;
      createRoot(() => {
        reaction(
          () => store.c.n,
          (v) => {
            seen = v;
          },
        );
      });
      flush();
      expect(seen).toBe(1);
      setStore((s) => {
        s.c.increment();
      });
      flush();
      expect(seen).toBe(2);
    },
  );

  test("null-prototype objects still wrap", () => {
    const bare = Object.create(null) as { n?: number };
    bare.n = 1;
    const [store, setStore] = createStore({ bare });
    let seen: number | undefined;
    createRoot(() => {
      reaction(
        () => store.bare.n,
        (v) => {
          seen = v;
        },
      );
    });
    flush();
    expect(seen).toBe(1);
    setStore((s) => {
      s.bare.n = 2;
    });
    flush();
    expect(seen).toBe(2);
  });
});

describe("shallow.test.ts", () => {
  const makeRows = (frame: number): { id: number; count: number; queries: { elapsed: number }[] }[] =>
    Array.from({ length: 4 }, (_, i) => ({ id: i, count: i * 10 + frame, queries: [{ elapsed: frame }] }));

  test("root keys are reactive, values are raw", () => {
    const rows = makeRows(0);
    const [state] = createStore(rows, { shallow: true });
    expect(state[0]).toBe(rows[0]!);
    expect(state[0]!.queries[0]).toBe(rows[0]!.queries[0]!);
  });

  test("reconcile replaces rows positionally and fires per-index", () => {
    const [state, setState] = createStore(makeRows(0), { shallow: true });
    let runs0 = 0;
    let runs2 = 0;
    createRoot(() => {
      reaction(
        () => state[0],
        () => {
          runs0++;
        },
      );
      reaction(
        () => state[2],
        () => {
          runs2++;
        },
      );
    });
    flush();
    runs0 = runs2 = 0;
    const fresh = makeRows(1);
    setState(reconcile(fresh, null));
    flush();
    expect(runs0).toBe(1);
    expect(runs2).toBe(1);
    expect(state[0]).toBe(fresh[0]!);
    expect(state[0]!.count).toBe(1);
  });

  test("setter reads serve raws; in-place mutation is reactively inert", () => {
    const [state, setState] = createStore(makeRows(0), { shallow: true });
    let runs = 0;
    createRoot(() => {
      reaction(
        () => state[0],
        () => {
          runs++;
        },
      );
    });
    flush();
    runs = 0;
    setState((s) => {
      s[0]!.count = 99;
    });
    flush();
    expect(runs).toBe(0);
  });

  test("canonical filter-removal idiom works on shallow stores", () => {
    const [state, setState] = createStore(makeRows(0), { shallow: true });
    setState((s) => s.filter((r) => r.id !== 1));
    flush();
    expect(state.length).toBe(3);
    expect(state.some((r) => r.id === 1)).toBe(false);
  });

  test("length changes propagate", () => {
    const [state, setState] = createStore(makeRows(0), { shallow: true });
    let len = 0;
    createRoot(() => {
      reaction(
        () => state.length,
        (v) => {
          len = v;
        },
      );
    });
    flush();
    setState(reconcile(makeRows(0).slice(0, 2), null));
    flush();
    expect(len).toBe(2);
    expect(state.length).toBe(2);
  });

  test("shallow OBJECT store: per-key nodes, membership, raw values", () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const [state, setState] = createStore<Record<string, { v?: number; z?: number }>>({ a }, { shallow: true });
    expect(state["a"]).toBe(a);
    let runs = 0;
    createRoot(() => {
      reaction(
        () => state["a"],
        () => {
          runs++;
        },
      );
    });
    flush();
    runs = 0;
    setState(reconcile<Record<string, { v?: number; z?: number }>>({ a: b, extra: { z: 1 } }, null));
    flush();
    expect(runs).toBe(1);
    expect(state["a"]).toBe(b);
    expect(state["extra"]!.z).toBe(1);
  });
});

describe("storePath.test.ts", () => {
  test("Functional setter no-op when returning same value", () => {
    const [store, setStore] = createStore({ count: 5 });
    let effectCount = 0;
    createRoot(() => {
      reaction(
        () => store.count,
        () => {
          effectCount++;
        },
      );
    });
    flush();
    expect(effectCount).toBe(1);
    setStore(path("count", (prev: number) => prev));
    flush();
    expect(effectCount).toBe(1);
  });

  test("Triggers reactive updates", () => {
    const [store, setStore] = createStore({ count: 0 });
    let observed: number | undefined;
    createRoot(() => {
      reaction(
        () => store.count,
        (v) => {
          observed = v;
        },
      );
    });
    flush();
    expect(observed).toBe(0);
    setStore(path("count", 42));
    flush();
    expect(observed).toBe(42);
  });

  test("Deeply nested reactive updates", () => {
    const [store, setStore] = createStore({ a: { b: { c: { d: 0 } } } });
    let observed: number | undefined;
    createRoot(() => {
      reaction(
        () => store.a.b.c.d,
        (v) => {
          observed = v;
        },
      );
    });
    flush();
    expect(observed).toBe(0);
    setStore(path("a", "b", "c", "d", 99));
    flush();
    expect(observed).toBe(99);
  });

  test("Delete triggers reactive updates", () => {
    const [store, setStore] = createStore<{ name: string; nickname?: string }>({ name: "John", nickname: "Johnny" });
    let observed: string | undefined = "unset";
    createRoot(() => {
      reaction(
        () => store.nickname,
        (v) => {
          observed = v;
        },
      );
    });
    flush();
    expect(observed).toBe("Johnny");
    setStore(path("nickname", path.DELETE));
    flush();
    expect(observed).toBeUndefined();
    expect("nickname" in store).toBe(false);
  });
});

describe("utilities.test.ts", () => {
  type SimplePropTypes = { a?: string | null; b?: string | null; c?: string | null; d?: string | null };
  const viewWhy = "merge and omit are copies of getters, not Solid's views";

  describe("merge", () => {
    gap("merge-views", "merge skips null and undefined sources, not false", "falsey values", () => {
      let props: SimplePropTypes = {
        get a() {
          return "ji";
        },
        b: null,
        c: "j",
      };
      props = merge(props, false, null, undefined);
      expect(props.a).toBe("ji");
      expect(props.b).toBe(null);
      expect(props.c).toBe("j");
    });

    test("overrides undefined values", () => {
      let bValue: number | undefined;
      const a = { value: 1 };
      const b = {
        get value() {
          return bValue;
        },
      };
      const c = {
        get value() {
          return undefined;
        },
      };
      const d = { value: undefined };
      const props = merge(a, b, c, d);
      expect(props.value).toBe(undefined);
      bValue = 2;
      expect(props.value).toBe(undefined);
    });

    test("includes undefined property", () => {
      const value = { a: undefined };
      const getter = {
        get a() {
          return undefined;
        },
      };
      expect("a" in merge(value)).toBeTruthy();
      expect("a" in merge(getter)).toBeTruthy();
      expect("a" in merge(value, getter)).toBeTruthy();
      expect("a" in merge(getter, value)).toBeTruthy();
    });

    test("is a live view: data properties read through to the sources", () => {
      const a = { value1: 1 };
      const b = {
        get value2() {
          return undefined;
        },
      };
      const props = merge(a, b);
      a.value1 = 3;
      expect(props.value1).toBe(3);
      expect(Object.keys(props).join()).toBe("value1,value2");
    });

    test("does not write the target", () => {
      const props = { value1: 1 };
      merge(props, {
        value2: 2,
        get value3() {
          return 3;
        },
      });
      expect(Object.keys(props).join("")).toBe("value1");
    });

    gap("merge-views", viewWhy, "returns same reference when only one argument", () => {
      const props = {};
      expect(merge(props) === props).toBeTruthy();
    });

    test("uses the source instances", () => {
      const source1 = {
        get a(): unknown {
          return this;
        },
      };
      const source2 = {
        get b(): unknown {
          return this;
        },
      };
      const props = merge(source1, source2);
      expect(props.a === source1).toBeTruthy();
      expect(props.b === source2).toBeTruthy();
    });

    test("does not clone nested objects", () => {
      const b = { value: 1 };
      const props = merge({ a: 1 }, { b });
      b.value = 2;
      expect(props.b.value).toBe(2);
    });

    test("handles undefined values", () => {
      expect(merge({ a: 1 }, { a: undefined }).a).toBe(undefined);
    });

    test("handles null values", () => {
      expect(merge({ a: 1 }, { a: null }).a).toBeNull();
    });

    test("ignores falsy sources", () => {
      const props = merge(undefined, null, { value: 1 }, null, undefined);
      expect(Object.keys(props).join()).toBe("value");
    });

    test("is safe", () => {
      merge({}, JSON.parse('{ "__proto__": { "evil": true } }'));
      expect(({} as Record<string, unknown>)["evil"]).toBeUndefined();
      merge({ value: 1 }, JSON.parse('{ "prototype": { "evil": true } }'));
      expect(({} as Record<string, unknown>)["evil"]).toBeUndefined();
    });
  });

  describe("Set Default Props", () => {
    test("simple set", () => {
      let props: SimplePropTypes = {
        get a() {
          return "ji";
        },
        b: null,
        c: "j",
      };
      const defaults: SimplePropTypes = { a: "yy", b: "ggg", d: "DD" };
      props = merge(defaults, props);
      expect(props.a).toBe("ji");
      expect(props.b).toBe(null);
      expect(props.c).toBe("j");
      expect(props.d).toBe("DD");
    });
  });

  describe("Clone Props", () => {
    test("simple set", () => {
      let reactive = false;
      const props: SimplePropTypes = {
        get a() {
          reactive = true;
          return "ji";
        },
        b: null,
        c: "j",
      };
      const newProps: SimplePropTypes = merge(props, {});
      expect(reactive).toBe(false);
      expect(newProps.a).toBe("ji");
      expect(reactive).toBe(true);
      expect(newProps.b).toBe(null);
      expect(newProps.c).toBe("j");
      expect(newProps.d).toBe(undefined);
    });
  });

  describe("Clone Store", () => {
    test("simple set", () => {
      const [state] = createStore<{ a: string; b: string; c?: string }>({ a: "Hi", b: "Jo" });
      const clone = merge(state, {});
      expect(state === clone).toBeFalsy();
      expect(clone.a).toBe("Hi");
      expect(clone.b).toBe("Jo");
      // The reads after the write are held reads: in createStore's held-writes test.
    });
  });

  describe("Merge Signal", () => {
    gap("merge-views", "merge takes no function source", "simple set", () => {
      const [s, set] = signal<SimplePropTypes>({
        get a() {
          return "ji";
        },
        b: null,
        c: "j",
      });
      const defaults: SimplePropTypes = { a: "yy", b: "ggg", d: "DD" };
      let props!: SimplePropTypes;
      const res: string[] = [];
      createRoot(() => {
        props = merge(defaults, s as unknown as SimplePropTypes);
        reaction(
          () => props.a as string,
          (v) => void res.push(v),
        );
      });
      flush();
      expect(props.a).toBe("ji");
      expect(props.d).toBe("DD");
      set({ a: "h" });
      flush();
      expect(props.a).toBe("h");
      expect(props.b).toBe("ggg");
      expect(res).toEqual(["ji", "h"]);
    });
  });

  describe("omit Props", () => {
    const Comp2 = (props: { greeting: string; name: string; optional?: string }): string => {
      const q = omit(props, "greeting", "optional");
      expect((q as Record<string, unknown>)["greeting"]).toBeUndefined();
      return `${props.greeting} ${q.name}`;
    };

    test("omit in two", () => {
      createRoot(() => {
        const out = Comp2({
          greeting: "Hi",
          get name() {
            return "dynamic";
          },
        });
        expect(out).toBe("Hi dynamic");
      });
    });

    test("omit in two with store", () => {
      createRoot(() => {
        const [state] = createStore({ greeting: "Yo", name: "Bob" });
        expect(Comp2(state)).toBe("Yo Bob");
      });
    });

    test("omit with store hides keys from proxy traps", () => {
      createRoot(() => {
        const [state] = createStore({ id: "input", color: "red", disabled: true });
        const otherProps = omit(state, "color", "disabled");
        expect(otherProps.id).toBe("input");
        expect((otherProps as Record<string, unknown>)["color"]).toBeUndefined();
        expect("id" in otherProps).toBeTruthy();
        expect("color" in otherProps).toBeFalsy();
        expect(Object.keys(otherProps)).toEqual(["id"]);
      });
    });

    test("omit result is a live view, not a copy", () => {
      let reads = 0;
      const props = {
        first: 1,
        second: 2,
        get third() {
          reads++;
          return 3;
        },
      };
      const otherProps = omit(props, "first");
      expect(reads).toBe(0);
      props.first = props.second = 3;
      expect(otherProps.second).toBe(3);
      expect(otherProps.third).toBe(3);
      expect(reads).toBe(1);
    });

    gap("merge-views", "omit takes keys, not a predicate", "omit with a predicate hides keys by rule", () => {
      const props = {
        $props: 1,
        $theme: 2,
        id: "x",
        get label() {
          return "L";
        },
      };
      const omitBy = omit as unknown as (o: object, rule: (k: PropertyKey) => boolean) => Record<string, unknown>;
      const rest = omitBy(props, (k) => typeof k === "string" && k[0] === "$");
      expect(Object.keys(rest)).toEqual(["id", "label"]);
      expect("$props" in rest).toBe(false);
      expect(rest["label"]).toBe("L");
    });

    test("Merge omit", () => {
      let value: string | undefined = "green";
      const splittedProps = omit(
        { color: "blue", component() {} } as { color: string; component: () => void; other?: string },
        "component",
      );
      const mergedProps = merge(splittedProps, {
        get color() {
          return value;
        },
        other: "value",
      });
      expect(mergedProps.color).toBe("green");
      value = "red";
      expect(mergedProps.color).toBe("red");
    });
  });

  describe("deep", () => {
    test("tests tracks deep updates", () => {
      const effect = mock();
      const [state, setState] = createStore<{ list: Record<string, number>[] }>({ list: [{ a: 1 }, { b: 2 }] });
      createRoot(() => {
        reaction(
          () => deep(state),
          (v) => effect(v),
        );
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(1);
      setState((s) => {
        s.list[0]!["a"] = 2;
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      expect(effect.mock.calls[1]![0]).toEqual({ list: [{ a: 2 }, { b: 2 }] });
      setState((s) => {
        s.list.push({ c: 3 });
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(3);
      expect(effect.mock.calls[2]![0]).toEqual({ list: [{ a: 2 }, { b: 2 }, { c: 3 }] });
      setState((s) => {
        s.list = [{ d: 4 }];
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(4);
      expect(effect.mock.calls[3]![0]).toEqual({ list: [{ d: 4 }] });
    });

    gap("symbol-keys", "deep and snapshot copy string keys only", "tracks updates in a symbol-keyed subtree", () => {
      const meta = Symbol("meta");
      const [state, setState] = createStore({ [meta]: { value: 1 } });
      const values: number[] = [];
      createRoot(() => {
        reaction(
          () => deep(state),
          (value) => void values.push(value[meta].value),
        );
      });
      flush();
      setState((s) => {
        s[meta].value = 2;
      });
      flush();
      expect(values).toEqual([1, 2]);
    });

    test("handles shared references", () => {
      const sharedReference = { a: 1, b: 2 };
      const sharedReference2 = { a: 1, b: 2 };
      const effect = mock();
      const [store, setStore] = createStore({
        first: { nested: { shared: sharedReference } },
        second: { nested: { shared: sharedReference } },
      });
      createRoot(() => {
        reaction(() => deep(store.first), effect);
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(1);
      setStore((s) => {
        s.second.nested.shared.b = 3;
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      setStore((s) => {
        s.first.nested.shared = sharedReference2;
        s.second.nested.shared = sharedReference2;
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(3);
      setStore((s) => {
        s.second.nested.shared.b = 4;
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(4);
    });

    test("returns plain (non-proxy) data", () => {
      const [state] = createStore({ a: { b: 1 }, c: [2, 3] });
      let result: { a: { b: number }; c: number[] } | undefined;
      createRoot(() => {
        reaction(
          () => deep(state),
          (v) => {
            result = v;
          },
        );
      });
      flush();
      expect(result).toEqual({ a: { b: 1 }, c: [2, 3] });
      expect(result).not.toBe(state);
      expect(types.isProxy(result!.a)).toBe(false);
      expect(Array.isArray(result!.c)).toBe(true);
    });

    test("works with reconcile", () => {
      const effect = mock();
      const [state, setState] = createStore<{ list: { id: number; v: number }[] }>({
        list: [
          { id: 1, v: 10 },
          { id: 2, v: 20 },
        ],
      });
      createRoot(() => {
        reaction(() => deep(state), effect);
      });
      flush();
      expect(effect).toHaveBeenCalledTimes(1);
      const next = [
        { id: 1, v: 99 },
        { id: 2, v: 20 },
        { id: 3, v: 30 },
      ];
      setState(reconcile({ list: next }, "id"));
      flush();
      expect(effect).toHaveBeenCalledTimes(2);
      expect(effect.mock.calls[1]![0]).toEqual({ list: next });
    });
  });

  describe("snapshot", () => {
    test("middle holes and length truncation keep working (controls)", () => {
      const [cut, setCut] = createStore<string[]>(["a", "b", "c"]);
      setCut((s) => {
        s.length = 2;
      });
      flush();
      expect(snapshot(cut).length).toBe(2);
      expect(JSON.stringify(snapshot(cut))).toBe('["a","b"]');
    });

    gap(
      "store-in-place",
      "a snapshot is always a copy, since the store's state is the object it was given",
      "returns same object if unchanged",
      () => {
        const ref = { a: 1, b: 2 };
        const [state] = createStore(ref);
        const immutable = snapshot(state);
        expect(immutable).not.toBe(state);
        expect(immutable).toEqual(state);
        expect(immutable).toBe(ref);
      },
    );

    test("returns new object if nested changed", () => {
      const ref = { a: 1, b: { c: 2 } };
      const [state, setState] = createStore(ref);
      const immutable = snapshot(state);
      expect(immutable).not.toBe(state);
      expect(immutable).toEqual(state);
      setState((s) => {
        s.b.c = 3;
      });
      const newImmutable = snapshot(state);
      expect(newImmutable).not.toBe(state);
      expect(newImmutable).toEqual({ a: 1, b: { c: 3 } });
      expect(newImmutable).not.toBe(immutable);
    });
  });
});

describe("for.nonkeyed.store.spec.tsx, and store reads in TSX", () => {
  const modules = { ...base };
  const texts = (root: FakeElement, cls: string): string[] =>
    root.childNodes
      .flatMap((n) => (n as FakeElement).childNodes)
      .flatMap((n) => (n as FakeElement).childNodes)
      .filter((n) => (n as FakeElement).getAttribute?.("class") === cls)
      .map((n) => n.textContent ?? "");

  test("item() and store[i()] both reflect per-index store writes", () => {
    installFakeDocument();
    const root = new FakeElement("DIV");
    const api = compile<{ set: (fn: (x: string[]) => void) => void }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store, setStore] = createStore(["a", "b", "c"]);
      render(() => (
        <div>
          <For each={store} keyed={false}>
            {(item, i) => (
              <div>
                <span class="item">{item()}</span>
                <span class="store">{store[i]}</span>
              </div>
            )}
          </For>
        </div>
      ), root);
      return { set: setStore };
      `,
      modules,
      { root },
    );
    const items = (): string[] => texts(root, "item");
    const stores = (): string[] => texts(root, "store");
    flush();
    expect({ items: items(), stores: stores() }).toEqual({ items: ["a", "b", "c"], stores: ["a", "b", "c"] });
    api.set((x) => {
      x[0] = "x";
    });
    flush();
    expect({ items: items(), stores: stores() }).toEqual({ items: ["x", "b", "c"], stores: ["x", "b", "c"] });
    api.set((x) => {
      x[0] = "xy";
    });
    flush();
    expect({ items: items(), stores: stores() }).toEqual({ items: ["xy", "b", "c"], stores: ["xy", "b", "c"] });
  });

  // Solid tracks a store read where it runs, so each of these updates in Solid. reactre's compiler
  // binds a hole for a read it can follow to a store (README, "Feature modules"): through a local,
  // an object, a function's result, and a prop of a component whose callers are all in its file.

  /** Render `jsx` (a view over `store`) and write `store.todos` and `store.count`: what it shows before and after. */
  function aliased(prelude: string, jsx: string): [string, string] {
    installFakeDocument();
    const root = new FakeElement("DIV");
    const api = compile<{ set: (fn: (s: { count: number; todos: { title: string }[] }) => void) => void }>(
      `
      import { For, render } from "@reactre/core";
      import { createStore } from "@reactre/core/features/store";
      const [store, setStore] = createStore({ count: 1, todos: [{ title: "a" }] });
      ${prelude}
      render(() => ${jsx}, root);
      return { set: setStore };
      `,
      modules,
      { root },
    );
    const before = root.textContent ?? "";
    api.set((s) => {
      s.count = 2;
      s.todos.push({ title: "b" });
    });
    return [before, root.textContent ?? ""];
  }

  test("a store read written in the hole follows the store", () => {
    expect(
      aliased("", `<p>{store.count}<For each={store.todos} key={(t) => t.title}>{(t) => <b>{t.title}</b>}</For></p>`),
    ).toEqual(["1a", "2ab"]);
  });

  test("a store's array read through a local alias", () => {
    expect(
      aliased(
        "const todos = store.todos;",
        `<p>{todos.length}<For each={todos} key={(t) => t.title}>{(t) => <b>{t.title}</b>}</For></p>`,
      ),
    ).toEqual(["1a", "2ab"]);
  });

  test("a store read through a box", () => {
    expect(aliased("const box = { store };", `<p>{box.store.count}</p>`)).toEqual(["1", "2"]);
  });

  test("a store's array returned by a function, and its rows' reads", () => {
    expect(
      aliased(
        "const getTodos = () => store.todos;",
        `<ul><For each={getTodos()} key={(t) => t.title}>{(t) => <li>{t.title}</li>}</For></ul>`,
      ),
    ).toEqual(["a", "ab"]);
  });

  test("a store's array passed as props.list", () => {
    expect(
      aliased(
        "function List(props) { return <ul><For each={props.list} key={(t) => t.title}>{(t) => <li>{t.title}</li>}</For></ul>; }",
        `<List list={store.todos} />`,
      ),
    ).toEqual(["a", "ab"]);
  });
});
