// Solid 2.0's tests of createMemo, ported to reactre's memo (@reactre/core; features/memo's for
// `equals` and writable derived signals; features/async's for async ones, with isPending,
// latest, refresh and resolve): packages/signals/tests/createMemo.test.ts, from solid-js
// 2.0.0-rc.20 (solidjs/solid@5e68925). ./harness.ts says how a port is translated. Where a Solid
// test is about writes made in one flush, the port makes them in one `batch`, reactre's way of
// applying writes together.
//
// Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato; the license is in
// ./harness.ts.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import * as asyncApi from "../../src/features/async.ts";
import { isPending, latest, refresh, resolve } from "../../src/features/async.ts";
import { memo as optionsMemo, signal as derivedSignal } from "../../src/features/memo.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { batch, memo, signal } from "../../src/index.ts";
import { folded, gap, tick } from "./harness.ts";

describe("createMemo.test.ts", () => {
  test("should store and return value on read", () => {
    const [$x] = signal(1);
    const [$y] = signal(1);

    const $a = memo(() => $x() + $y());

    expect($a()).toBe(2);
    flush();

    // Try again to ensure state is maintained.
    expect($a()).toBe(2);
  });

  test("should update when dependency is updated", () => {
    const [$x, setX] = signal(1);
    const [$y, setY] = signal(1);

    const $a = memo(() => $x() + $y());

    setX(2);
    flush();
    expect($a()).toBe(3);

    setY(2);
    flush();
    expect($a()).toBe(4);
  });

  test("should update when deep dependency is updated", () => {
    const [$x, setX] = signal(1);
    const [$y] = signal(1);

    const $a = memo(() => $x() + $y());
    const $b = memo(() => $a());

    setX(2);
    flush();
    expect($b()).toBe(3);
  });

  test("should update when deep computed dependency is updated", () => {
    const [$x, setX] = signal(10);
    const [$y] = signal(10);

    const $a = memo(() => $x() + $y());
    const $b = memo(() => $a());
    const $c = memo(() => $b());

    setX(20);
    flush();
    expect($c()).toBe(30);
  });

  gap("pull-memos", "a memo recomputes at the write, before it is read", "should only re-compute when needed", () => {
    const computed = mock((n: number) => n);

    const [$x, setX] = signal(10);
    const [$y, setY] = signal(10);

    const $a = memo(() => computed($x() + $y()));
    expect(computed).toHaveBeenCalledTimes(1);
    expect(computed).toHaveBeenCalledWith(20);

    $a();
    expect(computed).toHaveBeenCalledTimes(1);

    setX(20);
    expect(computed).toHaveBeenCalledTimes(1);
    flush();
    expect(computed).toHaveBeenCalledTimes(1);
    $a();
    expect(computed).toHaveBeenCalledTimes(2);

    setY(20);
    flush();
    expect(computed).toHaveBeenCalledTimes(2);
    $a();
    expect(computed).toHaveBeenCalledTimes(3);
  });

  gap(
    "pull-memos",
    "a memo nothing observes recomputes at the write",
    "should release untracked-read ownerless memos at flush, idempotently within a tick",
    () => {
      const computed = mock((v: number) => v);
      const [$x, setX] = signal(0);
      const $a = memo(() => computed($x()));

      expect($a()).toBe(0);
      expect(computed).toHaveBeenCalledTimes(1);
      expect($a()).toBe(0);
      expect(computed).toHaveBeenCalledTimes(1);

      setX(1);
      flush();
      expect(computed).toHaveBeenCalledTimes(1);

      expect($a()).toBe(1);
      expect(computed).toHaveBeenCalledTimes(2);
      expect($a()).toBe(1);
      expect(computed).toHaveBeenCalledTimes(2);
    },
  );

  gap(
    "pull-memos",
    "a chain nothing observes recomputes at the write",
    "should recompute ownerless chains on direct read after suspension",
    () => {
      const memoA = mock((n: number) => n);
      const memoB = mock((n: number) => n);

      const [$x, setX] = signal(10);
      const [$y, setY] = signal(10);

      const $a = memo(() => memoA($x()));
      const $b = memo(() => memoB($y()));
      const $c = memo(() => $a() + $b());

      expect(memoA).toHaveBeenCalledTimes(1);
      expect(memoB).toHaveBeenCalledTimes(1);
      expect($c()).toBe(20);

      setX(20);
      flush();

      expect(memoA).toHaveBeenCalledTimes(1);
      expect(memoB).toHaveBeenCalledTimes(1);
      expect($c()).toBe(30);
      expect(memoA).toHaveBeenCalledTimes(2);
      expect(memoB).toHaveBeenCalledTimes(2);

      setY(20);
      flush();

      expect(memoA).toHaveBeenCalledTimes(2);
      expect(memoB).toHaveBeenCalledTimes(2);
      expect($c()).toBe(40);
      expect(memoA).toHaveBeenCalledTimes(3);
      expect(memoB).toHaveBeenCalledTimes(3);
    },
  );

  test("should keep observed ownerless memos subscribed", () => {
    const memoA = mock((n: number) => n);
    const memoB = mock((n: number) => n);
    const [$x, setX] = signal(10);
    const [$y, setY] = signal(10);
    let value: number | undefined;

    createRoot(() => {
      const $a = memo(() => memoA($x()));
      const $b = memo(() => memoB($y()));
      const $c = memo(() => $a() + $b());
      reaction(
        () => (value = $c()),
        () => {},
      );
    });

    flush();
    expect(value).toBe(20);
    expect(memoA).toHaveBeenCalledTimes(1);
    expect(memoB).toHaveBeenCalledTimes(1);

    setX(20);
    flush();
    expect(value).toBe(30);
    expect(memoA).toHaveBeenCalledTimes(2);
    expect(memoB).toHaveBeenCalledTimes(1);

    setY(20);
    flush();
    expect(value).toBe(40);
    expect(memoA).toHaveBeenCalledTimes(2);
    expect(memoB).toHaveBeenCalledTimes(2);
  });

  test("should discover new dependencies", () => {
    const [$x, setX] = signal(1);
    const [$y, setY] = signal(0);

    const $c = memo(() => {
      if ($x()) return $x();
      return $y();
    });

    expect($c()).toBe(1);

    setX(0);
    flush();
    expect($c()).toBe(0);

    setY(10);
    flush();
    expect($c()).toBe(10);
  });

  test("should accept equals option", () => {
    const [$x, setX] = signal(0);

    const $a = optionsMemo(() => $x(), {
      // Skip even numbers.
      equals: (prev, next) => prev + 1 === next,
    });

    const effectA = mock();
    createRoot(() => reaction($a, effectA));
    flush();

    expect($a()).toBe(0);
    expect(effectA).toHaveBeenCalledTimes(1);

    setX(2);
    flush();
    expect($a()).toBe(2);
    expect(effectA).toHaveBeenCalledTimes(2);

    // no-change
    setX(3);
    flush();
    expect($a()).toBe(2);
    expect(effectA).toHaveBeenCalledTimes(2);
  });

  test("should ignore equals before memo initialization", () => {
    const [$x] = signal(1);

    const $a = optionsMemo(() => $x(), {
      equals: () => true,
    });

    expect($a()).toBe(1);
  });

  gap(
    "pull-memos",
    "memo() runs fn at once, so its error throws where the memo is made",
    "should route init errors through the boundary without a memo fallback",
    () => {
      createRoot(() => {
        const $a = memo(() => {
          if (1) throw Error();
          return "";
        });

        expect(() => $a()).toThrow();
      });
    },
  );

  test("should compute lazy memo when first read inside another computation", () => {
    const [$x, setX] = signal(0);
    let innerRuns = 0;
    let outer!: () => number;

    createRoot(() => {
      const lazy = folded.memo(
        () => {
          innerRuns++;
          return $x() + 1;
        },
        { lazy: true },
      );

      expect(innerRuns).toBe(0);

      outer = memo(() => lazy() * 2);

      expect(innerRuns).toBe(1);
      expect(outer()).toBe(2);
    });

    setX(5);
    flush();
    expect(innerRuns).toBe(2);
    expect(outer()).toBe(12);
  });

  test("should compute nested lazy memos when first read inside another computation", () => {
    const [$x, setX] = signal(0);
    let eager!: () => number;

    createRoot(() => {
      const lazyOuter = folded.memo(() => $x() + 1, { lazy: true });
      const lazyInner = folded.memo(() => lazyOuter() * 10, { lazy: true });

      eager = memo(() => lazyInner() + 100);

      expect(eager()).toBe(110);
    });

    setX(5);
    flush();
    expect(eager()).toBe(160);
  });

  describe("writable memos (createSignal of a function)", () => {
    test("a source change in the write's flush re-runs the memo; a prev-ignoring memo discards the write (core R31, #3733 rule B)", () => {
      const [original, setOriginal, derived, setDerived] = createRoot(() => {
        const [o, setO] = signal(0);
        const [d, setD] = derivedSignal(o);
        return [o, setO, d, setD] as const;
      });
      expect(derived()).toBe(0);
      batch(() => {
        setOriginal(1);
        setDerived(2);
      });
      flush();
      expect(original()).toBe(1);
      expect(derived()).toBe(1);
      // Subsequent change to upstream still recomputes the memo
      setOriginal(3);
      flush();
      expect(derived()).toBe(3);
    });

    test("a source change through an intermediate memo re-runs the written memo in the same flush (core R31, #3733 rule B)", () => {
      let observed: number | undefined;
      const [setA, setC] = createRoot(() => {
        const [a, sA] = signal(0);
        const b = memo(() => a() * 10);
        const [c, sC] = derivedSignal(b);
        reaction(c, (v) => {
          observed = v;
        });
        return [sA, sC] as const;
      });
      flush();
      expect(observed).toBe(0);
      batch(() => {
        setA(1);
        setC(99);
      });
      flush();
      expect(observed).toBe(10);
      setC(99);
      flush();
      expect(observed).toBe(99);
      setA(2);
      flush();
      expect(observed).toBe(20);
    });

    test("write then source change in one flush: the memo re-runs with the write as prev (core R31, #3733 rule B)", () => {
      const prevs: (number | undefined)[] = [];
      const [setOriginal, setDerived, derived] = createRoot(() => {
        const [original, setO] = signal(0);
        const [d, setD] = derivedSignal<number>((prev) => {
          prevs.push(prev);
          return original();
        });
        return [setO, setD, d] as const;
      });
      expect(derived()).toBe(0);
      batch(() => {
        setDerived(2);
        setOriginal(1);
      });
      flush();
      expect(derived()).toBe(1);
      expect(prevs.at(-1)).toBe(2);
    });

    test("latest manual write wins on a memo within a tick (#2692, A34 (1))", () => {
      const [, setDerived, derived] = createRoot(() => {
        const [original, setO] = signal(0);
        const [d, setD] = derivedSignal(original);
        return [setO, setD, d] as const;
      });
      setDerived(2);
      setDerived(3);
      flush();
      expect(derived()).toBe(3);
    });

    test("derived signal resumes tracking after repeated same manual writes (#2745)", () => {
      let observed: number | undefined;
      const [setOriginal, setDerived] = createRoot(() => {
        const [original, setO] = signal(0);
        const [derived, setD] = derivedSignal(() => original());
        reaction(derived, (value) => {
          observed = value;
        });
        return [setO, setD] as const;
      });

      flush();
      expect(observed).toBe(0);

      setDerived(42);
      flush();
      expect(observed).toBe(42);

      setDerived(42);
      flush();
      expect(observed).toBe(42);

      setOriginal(1);
      flush();
      expect(observed).toBe(1);
    });

    test("a same-value manual write does not hold against a same-flush source change (core R31, #3733 rule B)", () => {
      const [setOriginal, setDerived, derived] = createRoot(() => {
        const [original, setO] = signal(0);
        const [d, setD] = derivedSignal(original);
        return [setO, setD, d] as const;
      });
      batch(() => {
        setOriginal(1);
        setDerived(0);
      });
      flush();
      expect(derived()).toBe(1);
    });

    test("subscribers see the re-derived value when upstream changed in the write's flush (core R31, #3733 rule B)", () => {
      let observed: number | undefined;
      const [setOriginal, setDerived] = createRoot(() => {
        const [original, setO] = signal(0);
        const [derived, setD] = derivedSignal(original);
        reaction(derived, (v) => {
          observed = v;
        });
        return [setO, setD] as const;
      });
      flush();
      expect(observed).toBe(0);
      batch(() => {
        setOriginal(1);
        setDerived(2);
      });
      flush();
      expect(observed).toBe(1);
      setDerived(2);
      flush();
      expect(observed).toBe(2);
    });
  });

  describe("async compute", () => {
    beforeAll(() => core.__installAsync(asyncApi.__hooks));
    afterAll(() => core.__installAsync(false));

    test("should throw when reading uninitialized async computed outside reactive scope", async () => {
      const a = createRoot(() => {
        const a = asyncApi.memo(() => Promise.resolve(42));
        reaction(a, () => {});
        return a;
      });

      expect(() => a()).toThrow();

      await tick();
      expect(a()).toBe(42);
    });

    test("should return stale value when reading re-pending async computed outside reactive scope", async () => {
      const [s, set] = signal(1);
      const a = createRoot(() => {
        const a = asyncApi.memo(() => Promise.resolve(s()));
        reaction(a, () => {});
        return a;
      });

      await tick();
      expect(a()).toBe(1);

      set(2);
      flush();
      expect(a()).toBe(1);

      await tick();
      expect(a()).toBe(2);
    });

    test("diamond should not cause waterfalls on read", async () => {
      const [s, set] = signal(1);
      const fx = mock();
      const async1 = mock(() => Promise.resolve(s()));
      const async2 = mock(() => Promise.resolve(s()));

      createRoot(() => {
        const b = asyncApi.memo(async1);
        const c = asyncApi.memo(async2);
        reaction(
          () => [b(), c()] as const,
          (v) => fx(...v),
        );
      });

      expect(async1).toHaveBeenCalledTimes(1);
      expect(async2).toHaveBeenCalledTimes(1);
      expect(fx).toHaveBeenCalledTimes(0);
      await tick();
      expect(async1).toHaveBeenCalledTimes(1);
      expect(async2).toHaveBeenCalledTimes(1);
      expect(fx).toHaveBeenCalledTimes(1);
      expect(fx).toHaveBeenCalledWith(1, 1);
      set(2);
      flush();
      expect(async1).toHaveBeenCalledTimes(2);
      expect(async2).toHaveBeenCalledTimes(2);
      expect(fx).toHaveBeenCalledTimes(1);
      await tick();
      expect(async1).toHaveBeenCalledTimes(2);
      expect(async2).toHaveBeenCalledTimes(2);
      expect(fx).toHaveBeenCalledTimes(2);
      expect(fx).toHaveBeenCalledWith(2, 2);
    });

    test("should waterfall when dependent on another async with shared source", async () => {
      let a!: () => number;
      const [s, set] = signal(1);
      const fx = mock();
      const async1 = mock(() => Promise.resolve(s()));
      const async2 = mock(() => Promise.resolve(s() + a()));

      createRoot(() => {
        a = asyncApi.memo(async1);
        const b = asyncApi.memo(async2);
        reaction(
          () => b(),
          (v) => fx(v),
        );
      });

      expect(async1).toHaveBeenCalledTimes(1);
      expect(async2).toHaveBeenCalledTimes(1);
      expect(fx).toHaveBeenCalledTimes(0);
      await tick();
      expect(async1).toHaveBeenCalledTimes(1);
      expect(async2).toHaveBeenCalledTimes(2);
      expect(fx).toHaveBeenCalledTimes(1);
      expect(fx).toHaveBeenCalledWith(2);
      set(2);
      flush();
      expect(async1).toHaveBeenCalledTimes(2);
      expect(async2).toHaveBeenCalledTimes(3);
      expect(fx).toHaveBeenCalledTimes(1);
      await tick();
      expect(async1).toHaveBeenCalledTimes(2);
      expect(async2).toHaveBeenCalledTimes(4);
      expect(fx).toHaveBeenCalledTimes(2);
      expect(fx).toHaveBeenCalledWith(4);
    });

    test("should should show stale state with `isPending` in graph", async () => {
      const [s, set] = signal(1);
      const async1 = mock(() => Promise.resolve(s()));
      const a = createRoot(() => {
        const a = asyncApi.memo(async1);
        reaction(a, () => {}); // ensure re-compute
        return a;
      });
      await tick();
      const b = memo(() => (isPending(a) ? "stale" : "not stale"));
      expect(b()).toBe("not stale");
      set(2);
      flush();
      expect(b()).toBe("stale");
      await tick();
      expect(b()).toBe("not stale");
    });

    test("should should show stale state with `isPending` out of graph", async () => {
      const [s, set] = signal(1);
      const async1 = mock(() => Promise.resolve(s()));
      const a = createRoot(() => {
        const a = asyncApi.memo(async1);
        reaction(a, () => {}); // ensure re-compute
        return a;
      });

      expect(isPending(a)).toBe(false);
      await tick();
      expect(isPending(a)).toBe(false);
      set(2);
      flush();
      expect(isPending(a)).toBe(true);
      await tick();
      expect(isPending(a)).toBe(false);
    });

    test("should handle refreshes", async () => {
      let n = 1;
      let value: unknown;
      const a = createRoot(() => {
        const a = asyncApi.memo(() => Promise.resolve(n++));
        reaction(a, () => {}); // ensure re-compute
        reaction(
          () => (isPending(a) ? "stale" : a()),
          (v) => {
            value = v;
          },
        );
        return a;
      });
      expect(value).toBe(undefined);
      await tick();
      expect(value).toBe(1);
      void refresh(a);
      flush(); // a quiet re-ask, never "stale"
      expect(value).toBe(1);
      await tick();
      expect(value).toBe(2);
      void refresh(a);
      flush();
      expect(value).toBe(2);
      await tick();
      expect(value).toBe(3);
    });

    test("should only refresh the targeted memo, not its upstream memos (#2691)", () => {
      let upstreamRuns = 0;
      let downstreamRuns = 0;
      const downstream = createRoot(() => {
        const [, setX] = signal(0);
        const upstream = memo(() => {
          upstreamRuns++;
          return setX;
        });
        const downstream = memo(() => {
          downstreamRuns++;
          return upstream();
        });
        downstream(); // initial read
        flush();
        expect(upstreamRuns).toBe(1);
        expect(downstreamRuns).toBe(1);
        return downstream;
      });
      void refresh(downstream);
      flush();
      expect(upstreamRuns).toBe(1);
      expect(downstreamRuns).toBe(2);
    });

    test("should should show pending state in graph", async () => {
      const [s, set] = signal(1);
      let res = null as number | null;
      const async1 = mock(() => Promise.resolve(s()));
      createRoot(() => {
        const a = asyncApi.memo(async1);
        reaction(
          () => latest(s),
          (v) => {
            res = v;
          },
        );
        reaction(a, () => {}); // ensure re-compute
      });
      await tick();
      expect(res).toBe(1);
      set(2);
      flush();
      expect(res).toBe(2);
      await tick();
      expect(res).toBe(2);
    });

    test("should should show pending state outside of graph", async () => {
      const [s, set] = signal(1);
      const async1 = mock(() => Promise.resolve(s()));
      createRoot(() => {
        const a = asyncApi.memo(async1);
        reaction(a, () => {}); // ensure re-compute
      });
      expect(latest(s)).toBe(1);
      await tick();
      expect(latest(s)).toBe(1);
      set(2);
      flush();
      expect(latest(s)).toBe(2);
      await tick();
      expect(latest(s)).toBe(2);
    });

    test("should track pending value changes for loading indicator pattern", async () => {
      const [id, setId] = signal(0);
      const data = asyncApi.memo(() => Promise.resolve("D" + id()));
      const effectFn = mock();

      createRoot(() => {
        reaction(data, () => {}); // ensure re-compute
        reaction(
          () => latest(id),
          (pendingVal) => {
            effectFn(pendingVal);
          },
        );
      });

      await tick();
      expect(effectFn).toHaveBeenLastCalledWith(0);

      setId(1);
      flush();
      // During the transition, latest(id) is the new value.
      expect(effectFn).toHaveBeenLastCalledWith(1);

      await tick();
      expect(effectFn).toHaveBeenLastCalledWith(1);
    });

    test("should resolve to a value with resolveAsync", async () => {
      const [s, set] = signal(1);
      const async1 = mock(() => Promise.resolve(s()));
      let value: number | undefined;
      createRoot(() => {
        const a = asyncApi.memo(async1);
        void (async () => {
          value = await resolve(a);
        })();
      });
      expect(value).toBe(undefined);
      await tick();
      expect(value).toBe(1);
      set(2);
      expect(value).toBe(1);
      flush();
      expect(value).toBe(1);
      await tick();
      // doesn't update because not tracked
      expect(value).toBe(1);
    });

    test("should handle streams", async () => {
      const fx = mock();
      createRoot(() => {
        const v = asyncApi.memo(async function* () {
          yield await Promise.resolve(1);
          yield await Promise.resolve(2);
          yield await Promise.resolve(3);
        });
        reaction(v, (v) => fx(v));
      });
      flush();
      expect(fx).toHaveBeenCalledTimes(0);
      const turns = async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      };
      await turns();
      expect(fx).toHaveBeenCalledTimes(1);
      expect(fx).toHaveBeenCalledWith(1);
      await turns();
      expect(fx).toHaveBeenCalledTimes(2);
      expect(fx).toHaveBeenCalledWith(2);
      await turns();
      expect(fx).toHaveBeenCalledTimes(3);
      expect(fx).toHaveBeenCalledWith(3);
    });

    test("isPending full lifecycle - false to true to false", async () => {
      const [$x, setX] = signal(1);
      let a!: () => number;

      createRoot(() => {
        a = asyncApi.memo(async () => {
          const v = $x();
          await Promise.resolve();
          return v * 10;
        });

        reaction(a, () => {});
      });

      // Initial load: not pending (no stale data).
      flush();
      expect(isPending(a)).toBe(false);
      await tick();
      expect(isPending(a)).toBe(false);
      expect(a()).toBe(10);

      setX(2);
      flush();

      // Pending: it has stale data while it loads.
      expect(isPending(a)).toBe(true);
      expect(a()).toBe(10);

      await tick();

      expect(isPending(a)).toBe(false);
      expect(a()).toBe(20);
    });

    test("isPending returns true during revalidation", async () => {
      const [$x, setX] = signal(1);
      let a!: () => number;

      createRoot(() => {
        a = asyncApi.memo(() => Promise.resolve($x() * 10));
        reaction(a, () => {});
      });

      flush();
      await Promise.resolve();
      expect(a()).toBe(10);
      expect(isPending(a)).toBe(false);

      setX(2);
      flush();

      expect(isPending(a)).toBe(true);
      expect(a()).toBe(10);

      await Promise.resolve();
      expect(a()).toBe(20);
      expect(isPending(a)).toBe(false);
    });

    gap(
      "held-writes",
      "an async memo recomputes at the write, before flush()",
      "a write is held until flush (diamond should not cause waterfalls on read, should waterfall when dependent on another async)",
      async () => {
        const [s, set] = signal(1);
        const async1 = mock(() => Promise.resolve(s()));
        createRoot(() => {
          const b = asyncApi.memo(async1);
          reaction(b, () => {});
        });
        await tick();
        set(2);
        expect(async1).toHaveBeenCalledTimes(1);
        flush();
        expect(async1).toHaveBeenCalledTimes(2);
      },
    );
  });
});
