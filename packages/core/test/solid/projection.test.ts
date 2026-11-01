// Ports of Solid 2.0's synchronous projection tests to @reactre/core/features/store's
// `createProjection` and derived `createStore(fn, seed)`: key changes, selection, chains, entity
// swaps and positional merges, and a projection whose function returns another store
// (packages/signals/tests/store/createProjection.test.ts). Its async tests are ported with the
// async runtime's, in another file.
//
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid's createRenderEffect and createEffect are `reaction(compute, apply)`, createMemo is core's
// `memo`, createSignal core's `signal`. A projection Solid makes without a seed gets `{}` here, as
// reactre's needs one.

import { describe, expect, mock, test } from "bun:test";

import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { createProjection, createStore, reconcile, snapshot } from "../../src/features/store.ts";
import { flush } from "../../src/features/timing.ts";
import { memo, signal } from "../../src/index.ts";
import { gap } from "./harness.ts";

describe("createProjection.test.ts", () => {
  describe("Projection basics", () => {
    test("should observe key changes", () => {
      let setSource!: (v: number) => void;
      const effect0 = mock(),
        effect1 = mock(),
        effect2 = mock();
      let $effect0!: () => unknown, $effect1!: () => unknown, $effect2!: () => unknown;
      const dispose = createRoot((dispose) => {
        let previous: number | undefined;
        const [$source, set] = signal(0),
          selected = createProjection<Record<string, boolean>>(
            (draft) => {
              const s = $source();
              if (s !== previous) draft[String(previous)] = false;
              draft[s] = true;
              previous = s;
            },
            [false, false, false] as unknown as Record<string, boolean>,
          );
        effect0.mockImplementation(() => selected[0]);
        effect1.mockImplementation(() => selected[1]);
        effect2.mockImplementation(() => selected[2]);
        setSource = set;
        $effect0 = memo(effect0);
        $effect1 = memo(effect1);
        $effect2 = memo(effect2);
        return dispose;
      });
      expect([$effect0(), $effect1(), $effect2()]).toEqual([true, false, false]);
      expect([effect0.mock.calls.length, effect1.mock.calls.length, effect2.mock.calls.length]).toEqual([1, 1, 1]);
      setSource(1);
      flush();
      expect([$effect0(), $effect1(), $effect2()]).toEqual([false, true, false]);
      expect([effect0.mock.calls.length, effect1.mock.calls.length, effect2.mock.calls.length]).toEqual([2, 2, 1]);
      setSource(2);
      flush();
      expect([$effect0(), $effect1(), $effect2()]).toEqual([false, false, true]);
      expect([effect0.mock.calls.length, effect1.mock.calls.length, effect2.mock.calls.length]).toEqual([2, 3, 2]);
      setSource(-1);
      flush();
      expect([$effect0(), $effect1(), $effect2()]).toEqual([false, false, false]);
      expect([effect0.mock.calls.length, effect1.mock.calls.length, effect2.mock.calls.length]).toEqual([2, 3, 3]);
      dispose();
      setSource(0);
      setSource(1);
      setSource(2);
      expect([effect0.mock.calls.length, effect1.mock.calls.length, effect2.mock.calls.length]).toEqual([2, 3, 3]);
    });

    test("should not self track", () => {
      const spy = mock();
      const [bar, setBar] = signal("foo");
      const projection = createRoot(() =>
        createProjection(
          (draft) => {
            draft.foo = draft.bar;
            draft.bar = bar();
            spy();
          },
          { foo: "foo", bar: "bar" },
        ),
      );
      expect(projection.foo).toBe("bar");
      expect(projection.bar).toBe("foo");
      expect(spy).toHaveBeenCalledTimes(1);
      setBar("baz");
      flush();
      expect(projection.foo).toBe("foo");
      expect(projection.bar).toBe("baz");
      expect(spy).toHaveBeenCalledTimes(2);
    });

    test("should work for chained projections", () => {
      const [$x, setX] = signal(1);
      const tmp = mock();
      createRoot(() => {
        const a = createProjection(
          (state) => {
            state.v = $x();
          },
          { v: 0 },
        );
        const b = createProjection(
          (state) => {
            state.v = a.v;
          },
          { v: 0 },
        );
        reaction(
          () => b.v,
          (v, p) => tmp(v, p),
        );
      });
      expect(tmp).toHaveBeenCalledTimes(1);
      expect(tmp).toHaveBeenCalledWith(1, undefined);
      tmp.mockReset();
      setX(2);
      flush();
      expect(tmp).toHaveBeenCalledTimes(1);
      expect(tmp).toHaveBeenCalledWith(2, 1);
    });

    test("should fork a signals values", () => {
      const [$x, setX] = signal<{ v: number; y?: number }>({ v: 1 });
      const tmp = mock();
      createRoot(() => {
        const a = createProjection<{ v: number; y?: number }>($x, { v: 0 });
        reaction(
          () => a.v,
          (v, p) => tmp(v, p),
        );
        reaction(
          () => a.y,
          (v, p) => tmp(v, p),
        );
      });
      expect(tmp).toHaveBeenCalledTimes(2);
      expect(tmp).toHaveBeenNthCalledWith(1, 1, undefined);
      expect(tmp).toHaveBeenNthCalledWith(2, undefined, undefined);
      tmp.mockReset();
      setX({ v: 2 });
      flush();
      expect(tmp).toHaveBeenCalledTimes(1);
      expect(tmp).toHaveBeenNthCalledWith(1, 2, 1);
      tmp.mockReset();
      setX({ v: 2, y: 3 });
      flush();
      expect(tmp).toHaveBeenCalledTimes(1);
      expect(tmp).toHaveBeenNthCalledWith(1, 3, undefined);
    });

    test("preserves inline object property writes when splicing draft arrays", () => {
      type Todo = { id: string; title: string; status: string };
      const [$todos, setTodos] = signal<Todo[]>([
        { id: "1", title: "T1", status: "todo" },
        { id: "2", title: "T2", status: "todo" },
        { id: "3", title: "T3", status: "todo" },
      ]);
      const projection = createRoot(() =>
        createProjection<Todo[]>((draft) => {
          const todos = $todos();
          for (const todo of todos) {
            const index = draft.findIndex((existing) => existing.id === todo.id);
            const target = index === -1 ? draft.length : index;
            draft[target] = { id: todo.id } as Todo;
            draft[target].title = todo.title;
            draft[target].status = todo.status;
          }
          for (let i = draft.length - 1; i >= 0; i--)
            if (todos.findIndex((todo) => todo.id === draft[i]!.id) === -1) draft.splice(i, 1);
        }, []),
      );
      expect(projection.map((todo) => ({ ...todo }))).toEqual([
        { id: "1", title: "T1", status: "todo" },
        { id: "2", title: "T2", status: "todo" },
        { id: "3", title: "T3", status: "todo" },
      ]);
      setTodos((todos) => todos.filter((todo) => todo.id !== "2"));
      flush();
      expect(projection.map((todo) => ({ ...todo }))).toEqual([
        { id: "1", title: "T1", status: "todo" },
        { id: "3", title: "T3", status: "todo" },
      ]);
    });
  });

  describe("selection with projections", () => {
    test("simple selection", () => {
      let prev: number | undefined;
      const [s, set] = signal<number | undefined>(undefined);
      let count = 0;
      const list: string[] = [];
      createRoot(() => {
        const isSelected = createProjection<Record<number, boolean>>((state) => {
          const selected = s();
          if (prev !== undefined && prev !== selected) delete state[prev];
          if (selected) state[selected] = true;
          prev = selected;
        }, {});
        for (let i = 0; i < 100; i++)
          reaction(
            () => isSelected[i],
            (v) => {
              count++;
              list[i] = v ? "selected" : "no";
            },
          );
      });
      expect(count).toBe(100);
      expect(list[3]).toBe("no");
      count = 0;
      set(3);
      flush();
      expect(count).toBe(1);
      expect(list[3]).toBe("selected");
      count = 0;
      set(6);
      flush();
      expect(count).toBe(2);
      expect(list[3]).toBe("no");
      expect(list[6]).toBe("selected");
      set(undefined);
      flush();
      expect(count).toBe(3);
      expect(list[6]).toBe("no");
      set(5);
      flush();
      expect(count).toBe(4);
      expect(list[5]).toBe("selected");
    });

    test("double selection", () => {
      let prev: number | undefined;
      const [s, set] = signal<number | undefined>(undefined);
      let count = 0;
      const list: string[][] = [];
      createRoot(() => {
        const isSelected = createProjection<Record<number, boolean>>((state) => {
          const selected = s();
          if (prev !== undefined && prev !== selected) delete state[prev];
          if (selected) state[selected] = true;
          prev = selected;
        }, {});
        for (let i = 0; i < 100; i++) {
          const row: string[] = (list[i] = []);
          reaction(
            () => isSelected[i],
            (v) => {
              count++;
              row[0] = v ? "selected" : "no";
            },
          );
          reaction(
            () => isSelected[i],
            (v) => {
              count++;
              row[1] = v ? "oui" : "non";
            },
          );
        }
      });
      expect(count).toBe(200);
      expect(list[3]).toEqual(["no", "non"]);
      count = 0;
      set(3);
      flush();
      expect(count).toBe(2);
      expect(list[3]).toEqual(["selected", "oui"]);
      count = 0;
      set(6);
      flush();
      expect(count).toBe(4);
      expect(list[3]).toEqual(["no", "non"]);
      expect(list[6]).toEqual(["selected", "oui"]);
    });
  });

  describe("Projection root entity swap", () => {
    test("swaps in place when the derive returns a different entity", () => {
      const seen: string[] = [];
      let setId!: (v: number) => void;
      let user!: { id: number; name: string };
      createRoot(() => {
        const [id, set] = signal(1);
        setId = set;
        user = createProjection<{ id: number; name: string }>(
          () => ({ id: id(), name: `user ${id()}` }),
          {} as { id: number; name: string },
        );
        reaction(
          () => user.name,
          (v) => void seen.push(v),
        );
      });
      flush();
      expect(seen).toEqual(["user 1"]);
      setId(2);
      flush();
      expect(seen).toEqual(["user 1", "user 2"]);
      expect(user.id).toBe(2);
    });

    gap(
      "reconcile-identity",
      "a projection merges into its old children when the root's key changes",
      "does not merge children across an entity change",
      () => {
        type Post = { id: number; title: string };
        const users: Record<number, { id: number; posts: Post[] }> = {
          1: { id: 1, posts: [{ id: 1, title: "one/a" }] },
          2: { id: 2, posts: [{ id: 1, title: "two/a" }] },
        };
        let setId!: (v: number) => void;
        let firstPost!: Post;
        createRoot(() => {
          const [id, set] = signal(1);
          setId = set;
          const user = createProjection<{ id: number; posts: Post[] }>(
            () => structuredClone(users[id()]!),
            {} as { id: number; posts: Post[] },
          );
          reaction(
            () => user.posts[0]!,
            (p) => {
              firstPost = p;
            },
          );
        });
        flush();
        const beforeSwap = firstPost;
        expect(beforeSwap.title).toBe("one/a");
        setId(2);
        flush();
        expect(firstPost.title).toBe("two/a");
        expect(firstPost).not.toBe(beforeSwap);
        expect(beforeSwap.title).toBe("one/a");
      },
    );

    test("keeps merging when identity is unchanged", () => {
      type User = { id: number; name: string; posts: { id: number; title: string }[] };
      let setName!: (v: string) => void;
      let user!: User;
      let firstPost!: { id: number; title: string };
      let postRuns = 0;
      createRoot(() => {
        const [name, set] = signal("Ada");
        setName = set;
        user = createProjection<User>(() => ({ id: 1, name: name(), posts: [{ id: 1, title: "a" }] }), {} as User);
        reaction(
          () => user.posts[0]!,
          (p) => {
            postRuns++;
            firstPost = p;
          },
        );
        reaction(
          () => user.name,
          () => {},
        );
      });
      flush();
      const before = firstPost;
      expect(postRuns).toBe(1);
      setName("Grace");
      flush();
      expect(user.name).toBe("Grace");
      expect(firstPost).toBe(before);
      expect(postRuns).toBe(1);
    });

    test("the outgoing raw stops resolving to the projection root", () => {
      type Entity = { id: number; name: string; self: Entity | null };
      const ONE: Entity = { id: 1, name: "one", self: null };
      const TWO: Entity = { id: 2, name: "two", self: null };
      TWO.self = ONE;
      let setId!: (v: number) => void;
      let user!: Entity;
      createRoot(() => {
        const [id, set] = signal(1);
        setId = set;
        user = createProjection<Entity>(() => (id() === 1 ? ONE : TWO), {} as Entity);
        reaction(
          () => user.name,
          () => {},
        );
      });
      flush();
      setId(2);
      flush();
      expect(user.name).toBe("two");
      expect(user.self!.name).toBe("one");
      expect(user.self).not.toBe(user);
    });

    test("key: null merges positionally", () => {
      type User = { id: number; posts: { id: number; title: string }[] };
      let setId!: (v: number) => void;
      let user!: User;
      let firstPost!: { id: number; title: string };
      createRoot(() => {
        const [id, set] = signal(1);
        setId = set;
        user = createProjection<User>(() => ({ id: id(), posts: [{ id: id() * 10, title: `t${id()}` }] }), {} as User, {
          key: null,
        });
        reaction(
          () => user.posts[0]!,
          (p) => {
            firstPost = p;
          },
        );
      });
      flush();
      const before = firstPost;
      expect(before.title).toBe("t1");
      setId(2);
      flush();
      expect(user.id).toBe(2);
      expect(firstPost).toBe(before);
      expect(firstPost.title).toBe("t2");
    });

    gap(
      "reconcile-identity",
      "reconcile merges into the root whatever its key",
      "reconcile() itself still rejects a root identity mismatch",
      () => {
        const [, setStore] = createStore({ id: 1, name: "one" });
        expect(() => setStore(reconcile({ id: 2, name: "two" }))).toThrow(/different identity/);
      },
    );
  });

  describe("projection over a store — chained backing (#2941)", () => {
    const why = "a projection copies what its fn returns once; a store it returns is not followed";

    gap("projection-chain", why, "derive returning a store adopts it live: updates flow with no re-derive", () => {
      const seen: unknown[] = [];
      const derive = mock();
      let setStore!: (fn: (s: { a: number }) => void) => void;
      let proj!: { a: number };
      const dispose = createRoot((dispose) => {
        const [store, set] = createStore({ a: 1 });
        setStore = set;
        proj = createProjection<{ a: number }>(
          () => {
            derive();
            return store;
          },
          {} as { a: number },
        );
        reaction(
          () => proj.a,
          (v) => void seen.push(v),
        );
        return dispose;
      });
      flush();
      setStore((s) => {
        s.a = 5555;
      });
      flush();
      expect(seen).toEqual([1, 5555]);
      expect(derive).toHaveBeenCalledTimes(1);
      expect(proj.a).toBe(5555);
      dispose();
    });

    // Passes because the projection takes the store's nested objects as they are, so it shares them.
    test("nested updates stay fine-grained through the chain", () => {
      const outer: unknown[] = [];
      const inner: unknown[] = [];
      type S = { top: string; nest: { deep: string } };
      let setStore!: (fn: (s: S) => void) => void;
      const dispose = createRoot((dispose) => {
        const [store, set] = createStore<S>({ top: "t1", nest: { deep: "d1" } });
        setStore = set;
        const proj = createProjection<S>(() => store, {} as S);
        reaction(
          () => proj.top,
          (v) => void outer.push(v),
        );
        reaction(
          () => proj.nest.deep,
          (v) => void inner.push(v),
        );
        return dispose;
      });
      flush();
      setStore((s) => {
        s.nest.deep = "d2";
      });
      flush();
      expect(outer).toEqual(["t1"]);
      expect(inner).toEqual(["d1", "d2"]);
      dispose();
    });

    gap("projection-chain", why, "array store at the root: structural and row updates flow", () => {
      const seen: unknown[] = [];
      type Row = { id: number; n: string };
      let setList!: (fn: (l: Row[]) => void) => void;
      const dispose = createRoot((dispose) => {
        const [list, set] = createStore<Row[]>([{ id: 1, n: "x" }]);
        setList = set;
        const proj = createProjection<Row[]>(() => list, []);
        reaction(
          () => proj.map((r) => r.n).join(","),
          (v) => void seen.push(v),
        );
        return dispose;
      });
      flush();
      setList((l) => {
        l.push({ id: 2, n: "y" });
      });
      flush();
      setList((l) => {
        l[0]!.n = "X";
      });
      flush();
      expect(seen).toEqual(["x", "x,y", "X,y"]);
      dispose();
    });

    gap("projection-chain", why, "derived createStore(fn, seed) chains the same way", () => {
      const seen: unknown[] = [];
      let setSrc!: (fn: (s: { v: number }) => void) => void;
      const dispose = createRoot((dispose) => {
        const [src, set] = createStore({ v: 1 });
        setSrc = set;
        const [proj] = createStore(() => src, { v: 0 });
        reaction(
          () => proj.v,
          (v) => void seen.push(v),
        );
        return dispose;
      });
      flush();
      setSrc((s) => {
        s.v = 2;
      });
      flush();
      expect(seen).toEqual([1, 2]);
      dispose();
    });

    test("snapshot() of a chained projection returns plain detached data", () => {
      type S = { a: number; nest: { b: number } };
      let proj!: S;
      let setStore!: (fn: (s: S) => void) => void;
      const dispose = createRoot((dispose) => {
        const [store, set] = createStore<S>({ a: 1, nest: { b: 2 } });
        setStore = set;
        proj = createProjection<S>(() => store, {} as S);
        return dispose;
      });
      flush();
      void proj.a;
      const snap = snapshot(proj);
      expect(snap).toEqual({ a: 1, nest: { b: 2 } });
      setStore((s) => {
        s.a = 99;
      });
      flush();
      expect(snap.a).toBe(1);
      dispose();
    });

    gap("projection-chain", why, "enumeration tracks through the chain", () => {
      const seen: unknown[] = [];
      let setStore!: (fn: (s: Record<string, number>) => void) => void;
      const dispose = createRoot((dispose) => {
        const [store, set] = createStore<Record<string, number>>({ a: 1 });
        setStore = set;
        const proj = createProjection<Record<string, number>>(() => store, {});
        reaction(
          () => Object.keys(proj).join(","),
          (v) => void seen.push(v),
        );
        return dispose;
      });
      flush();
      setStore((s) => {
        s["b"] = 2;
      });
      flush();
      expect(seen).toEqual(["a", "a,b"]);
      dispose();
    });
  });
});
