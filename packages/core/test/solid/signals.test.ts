// Solid 2.0's tests of signals, untrack and the shape of the update graph, ported to reactre's
// signal (@reactre/core, and features/memo's for options and derived signals), memo, untrack and
// reaction: packages/signals/tests/createSignal.test.ts, untrack.test.ts and graph.test.ts, from
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). ./harness.ts says how a port is translated.
//
// Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato; the license is in
// ./harness.ts.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import * as asyncApi from "../../src/features/async.ts";
import { memo as optionsMemo, signal as derivedSignal } from "../../src/features/memo.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { memo, onCleanup, signal, untrack } from "../../src/index.ts";
import { folded, gap, tick } from "./harness.ts";

describe("createSignal.test.ts", () => {
  test("should store and return value on read", () => {
    const [$x] = signal(1);
    expect($x).toBeInstanceOf(Function);
    expect($x()).toBe(1);
  });

  test("should update signal via setter", () => {
    const [$x, setX] = signal(1);
    setX(2);
    flush();
    expect($x()).toBe(2);
  });

  test("should update signal via update function", () => {
    const [$x, setX] = signal(1);
    setX((n) => n + 1);
    flush();
    expect($x()).toBe(2);
  });

  test("should accept equals option", () => {
    const [$x, setX] = derivedSignal(1, {
      // Skip even numbers.
      equals: (prev, next) => prev + 1 === next,
    });

    setX(11);
    flush();
    expect($x()).toBe(11);

    setX(12);
    flush();
    expect($x()).toBe(11);

    setX(13);
    flush();
    expect($x()).toBe(13);

    setX(14);
    flush();
    expect($x()).toBe(13);
  });

  test("should update signal with functional value", () => {
    const [$x, setX] = derivedSignal<() => number>(() => () => 10);
    expect($x()()).toBe(10);
    setX(() => () => 20);
    flush();
    expect($x()()).toBe(20);
  });

  test("should create signal derived from another signal", () => {
    const [$x, setX] = signal(1);
    const [$y, setY] = derivedSignal(() => $x() + 1);
    expect($y()).toBe(2);
    setY(1);
    flush();
    expect($y()).toBe(1);
    setX(2);
    flush();
    expect($y()).toBe(3);
  });

  gap(
    "unobserved-timing",
    "unobserved runs in a microtask after the last reader left, not as it leaves",
    "should call unobserved callback when subscriber is disposed",
    () => {
      const unobserved = mock();
      const [$x, setX] = folded.signal(1, { unobserved });

      const disposer = createRoot((dispose) => {
        memo(() => $x());
        return dispose;
      });

      expect(unobserved).not.toHaveBeenCalled();
      disposer();
      expect(unobserved).toHaveBeenCalledTimes(1);

      setX(2);
      flush();
      expect(unobserved).toHaveBeenCalledTimes(1);
    },
  );

  gap(
    "unobserved-timing",
    "unobserved runs in a microtask after the last reader left, not as it leaves",
    "should call unobserved callback when signal is unobserved",
    () => {
      const unobserved = mock();
      const [$x, setX] = signal(true);
      const [$y] = folded.signal(1, { unobserved });

      createRoot(() => {
        memo(() => ($x() ? $y() : null));
      });

      expect(unobserved).not.toHaveBeenCalled();

      setX(false);
      flush();
      expect(unobserved).toHaveBeenCalledTimes(1);
    },
  );

  gap(
    "held-writes",
    "a read after a write sees it before flush()",
    "a write is held until flush (should update signal via setter, via update function, accept equals option)",
    () => {
      const [$x, setX] = signal(1);
      setX(2);
      expect($x()).toBe(1);
      flush();
      setX((n) => n + 1);
      expect($x()).toBe(2);
      flush();
      const [$y, setY] = derivedSignal(1, { equals: (prev, next) => prev + 1 === next });
      setY(11);
      expect($y()).toBe(1);
    },
  );

  describe("async computed transition entanglement", () => {
    beforeAll(() => core.__installAsync(asyncApi.__hooks));
    afterAll(() => core.__installAsync(false));

    test("async computed's first settle does not permanently entangle unrelated effects", async () => {
      const values: number[] = [];
      let setCounter!: core.Setter<number>;

      const dispose = createRoot((dispose) => {
        const [counter, _setCounter] = signal(0);
        setCounter = _setCounter;

        // A never-resolving async signal read by an effect.
        const os = asyncApi.memo(async () => new Promise<string>(() => {}));
        reaction(
          () => os(),
          () => {},
        );

        // An async computed that reads counter.
        asyncApi.memo(async () => counter());

        reaction(
          () => counter(),
          (v) => {
            values.push(v);
          },
        );

        return dispose;
      });

      flush();
      await tick(50);
      expect(values).toContain(0);

      setCounter(1);
      flush();
      await tick(50);
      expect(values).toContain(1);

      setCounter(2);
      flush();
      await tick(50);
      expect(values).toContain(2);

      dispose();
    });

    test("without the async computed, the sync effect is not entangled", async () => {
      const values: number[] = [];
      let setCounter!: core.Setter<number>;

      const dispose = createRoot((dispose) => {
        const [counter, _setCounter] = signal(0);
        setCounter = _setCounter;

        const os = asyncApi.memo(async () => new Promise<string>(() => {}));
        reaction(
          () => os(),
          () => {},
        );

        reaction(
          () => counter(),
          (v) => {
            values.push(v);
          },
        );

        return dispose;
      });

      flush();
      await tick(50);
      expect(values).toContain(0);

      setCounter(1);
      flush();
      await tick(50);
      expect(values).toContain(1);

      setCounter(2);
      flush();
      await tick(50);
      expect(values).toContain(2);

      dispose();
    });
  });
});

describe("untrack.test.ts", () => {
  test("should not create dependency", () => {
    const fx = mock();
    const memoSpy = mock();

    const [$x, setX] = signal(10);

    const $a = memo(() => $x() + 10);
    const $b = memo(() => {
      memoSpy();
      return untrack($a) + 10;
    });

    createRoot(() =>
      reaction(
        () => {
          fx();
          expect(untrack($x)).toBe(10);
          expect(untrack($a)).toBe(20);
          expect(untrack($b)).toBe(30);
        },
        () => {},
      ),
    );
    flush();

    expect(fx).toHaveBeenCalledTimes(1);
    expect(memoSpy).toHaveBeenCalledTimes(1);

    setX(20);
    flush();
    expect(fx).toHaveBeenCalledTimes(1);
    expect(memoSpy).toHaveBeenCalledTimes(1);
  });

  gap(
    "pull-memos",
    "the memo keeps its value after an untracked source changes",
    "should not affect deep dependency being created",
    () => {
      const fx = mock();
      const memoSpy = mock();

      const [$x, setX] = signal(10);
      const [$y, setY] = signal(10);
      const [$z, setZ] = signal(10);

      const $a = memo(() => {
        memoSpy();
        return $x() + untrack($y) + untrack($z) + 10;
      });

      createRoot(() =>
        reaction(
          () => {
            fx();
            expect(untrack($x)).toBe(10);
            expect(untrack($a)).toBe(40);
          },
          () => {},
        ),
      );
      flush();

      expect(fx).toHaveBeenCalledTimes(1);
      expect($a()).toBe(40);
      expect(memoSpy).toHaveBeenCalledTimes(1);

      setX(20);
      flush();
      expect(fx).toHaveBeenCalledTimes(1);
      expect($a()).toBe(50);
      expect(memoSpy).toHaveBeenCalledTimes(2);

      setY(20);
      flush();
      expect(fx).toHaveBeenCalledTimes(1);
      expect($a()).toBe(60);
      expect(memoSpy).toHaveBeenCalledTimes(3);

      setZ(20);
      flush();
      expect(fx).toHaveBeenCalledTimes(1);
      expect($a()).toBe(70);
      expect(memoSpy).toHaveBeenCalledTimes(4);
    },
  );

  test("should track owner across peeks", () => {
    const [$x, setX] = signal(0);

    const childCompute = mock();
    const childDispose = mock();

    function createChild(): void {
      const $a = memo(() => $x() * 2);
      createRoot(() =>
        reaction(
          () => {
            childCompute($a());
            onCleanup(childDispose);
          },
          () => {},
        ),
      );
    }

    const dispose = createRoot((dispose) => {
      untrack(() => createChild());
      return dispose;
    });
    flush();

    setX(1);
    flush();
    expect(childCompute).toHaveBeenCalledWith(2);
    expect(childDispose).toHaveBeenCalledTimes(1);

    dispose();
    expect(childDispose).toHaveBeenCalledTimes(2);

    setX(2);
    flush();
    expect(childCompute).not.toHaveBeenCalledWith(4);
    expect(childDispose).toHaveBeenCalledTimes(2);
  });
});

describe("graph.test.ts", () => {
  test("should drop X->B->X updates", () => {
    const [setX, $c, compute] = createRoot(() => {
      const [$x, setX] = signal(2);
      const $a = memo(() => $x() - 1);
      const $b = memo(() => $x() + $a());
      const compute = mock(() => "c: " + $b());
      const $c = memo(compute);
      return [setX, $c, compute] as const;
    });

    expect($c()).toBe("c: 3");
    expect(compute).toHaveBeenCalledTimes(1);
    compute.mockClear();

    setX(4);
    flush();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  gap(
    "glitch-free",
    "the join re-runs once per changed branch",
    "should only update every signal once (diamond graph)",
    () => {
      const [$x, setX] = signal("a");
      const $a = memo(() => $x());
      const $b = memo(() => $x());

      const spy = mock(() => $a() + " " + $b());
      const $c = memo(spy);

      expect($c()).toBe("a a");
      expect(spy).toHaveBeenCalledTimes(1);

      setX("aa");
      flush();
      expect($c()).toBe("aa aa");
      expect(spy).toHaveBeenCalledTimes(2);
    },
  );

  gap(
    "glitch-free",
    "the join re-runs once per changed branch",
    "should only update every signal once (diamond graph + tail)",
    () => {
      const [$x, setX] = signal("a");

      const $a = memo(() => $x());
      const $b = memo(() => $x());
      const $c = memo(() => $a() + " " + $b());

      const spy = mock(() => $c());
      const $d = memo(spy);

      expect($d()).toBe("a a");
      expect(spy).toHaveBeenCalledTimes(1);

      setX("aa");
      flush();
      expect($d()).toBe("aa aa");
      expect(spy).toHaveBeenCalledTimes(2);
    },
  );

  test("should bail out if result is the same", () => {
    const [setX, $b, spy] = createRoot(() => {
      const [$x, setX] = signal("a");
      const $a = memo(() => {
        $x();
        return "foo";
      });
      const spy = mock(() => $a());
      const $b = memo(spy);
      return [setX, $b, spy] as const;
    });

    expect($b()).toBe("foo");
    expect(spy).toHaveBeenCalledTimes(1);

    setX("aa");
    flush();
    expect($b()).toBe("foo");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  gap(
    "glitch-free",
    "the join re-runs once per changed branch",
    "should only update every signal once (jagged diamond graph + tails)",
    () => {
      const [setX, $d, dSpy, $e, eSpy, $f, fSpy] = createRoot(() => {
        const [$x, setX] = signal("a");
        const $a = memo(() => $x());
        const $b = memo(() => $x());
        const $c = memo(() => $b());
        const dSpy = mock(() => $a() + " " + $c());
        const $d = memo(dSpy);
        const eSpy = mock(() => $d());
        const $e = memo(eSpy);
        const fSpy = mock(() => $d());
        const $f = memo(fSpy);
        return [setX, $d, dSpy, $e, eSpy, $f, fSpy] as const;
      });

      expect($e()).toBe("a a");
      expect(eSpy).toHaveBeenCalledTimes(1);

      expect($f()).toBe("a a");
      expect(fSpy).toHaveBeenCalledTimes(1);

      setX("b");
      flush();

      expect($d()).toBe("b b");
      expect(dSpy).toHaveBeenCalledTimes(2);

      expect($e()).toBe("b b");
      expect(eSpy).toHaveBeenCalledTimes(2);

      expect($f()).toBe("b b");
      expect(fSpy).toHaveBeenCalledTimes(2);

      setX("c");
      flush();

      expect($d()).toBe("c c");
      expect(dSpy).toHaveBeenCalledTimes(3);

      expect($e()).toBe("c c");
      expect(eSpy).toHaveBeenCalledTimes(3);

      expect($f()).toBe("c c");
      expect(fSpy).toHaveBeenCalledTimes(3);
    },
  );

  test("should ensure subs update even if one dep is static", () => {
    const [$x, setX] = signal("a");

    const $a = memo(() => $x());
    const $b = memo(() => {
      $x();
      return "c";
    });

    const spy = mock(() => $a() + " " + $b());
    const $c = memo(spy);

    expect($c()).toBe("a c");

    setX("aa");
    flush();

    expect($c()).toBe("aa c");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("should ensure subs update even if two deps mark it clean", () => {
    const [$x, setX] = signal("a");

    const $b = memo(() => $x());
    const $c = memo(() => {
      $x();
      return "c";
    });
    const $d = memo(() => {
      $x();
      return "d";
    });

    const spy = mock(() => $b() + " " + $c() + " " + $d());
    const $e = memo(spy);

    expect($e()).toBe("a c d");

    setX("aa");
    flush();

    expect($e()).toBe("aa c d");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  gap("glitch-free", "memos re-run depth-first, as each source writes", "propagates in topological order", () => {
    let seq = "";
    const [a1, setA1] = signal(false);
    const b1 = optionsMemo(
      () => {
        a1();
        seq += "b1";
      },
      { equals: false },
    );
    const b2 = optionsMemo(
      () => {
        a1();
        seq += "b2";
      },
      { equals: false },
    );
    optionsMemo(
      () => {
        (b1(), b2());
        seq += "c1";
      },
      { equals: false },
    );
    seq = "";
    setA1(true);
    flush();
    expect(seq).toBe("b1b2c1");
  });

  gap(
    "glitch-free",
    "the join re-runs once per changed branch",
    "only propagates once with linear convergences",
    () => {
      const [d, setD] = signal(0);
      const f1 = memo(() => d()),
        f2 = memo(() => d()),
        f3 = memo(() => d()),
        f4 = memo(() => d()),
        f5 = memo(() => d());
      let gcount = 0;
      memo(() => {
        gcount++;
        return f1() + f2() + f3() + f4() + f5();
      });

      gcount = 0;
      setD(1);
      flush();
      expect(gcount).toBe(1);
    },
  );

  gap(
    "glitch-free",
    "the join re-runs once per changed branch",
    "only propagates once with exponential convergence",
    () => {
      const [d, setD] = signal(0);
      const f1 = memo(() => d()),
        f2 = memo(() => d()),
        f3 = memo(() => d()),
        g1 = memo(() => f1() + f2() + f3()),
        g2 = memo(() => f1() + f2() + f3()),
        g3 = memo(() => f1() + f2() + f3());
      let hcount = 0;
      memo(() => {
        hcount++;
        return g1() + g2() + g3();
      });
      hcount = 0;
      setD(1);
      flush();
      expect(hcount).toBe(1);
    },
  );

  test("does not trigger downstream computations unless changed", () => {
    const [s1, set] = derivedSignal(1, { equals: false });
    let order = "";
    const t1 = memo(() => {
      order += "t1";
      return s1();
    });
    memo(() => {
      order += "c1";
      t1();
    });
    expect(order).toBe("t1c1");
    order = "";
    set(1);
    flush();
    expect(order).toBe("t1");
    order = "";
    set(2);
    flush();
    expect(order).toBe("t1c1");
  });

  gap(
    "glitch-free",
    "memos re-run depth-first, as each source writes",
    "applies updates to changed dependees in same order as createMemo",
    () => {
      const [s1, set] = signal(0);
      let order = "";
      const t1 = memo(() => {
        order += "t1";
        return s1() === 0;
      });
      memo(() => {
        order += "c1";
        return s1();
      });
      memo(() => {
        order += "c2";
        return t1();
      });
      expect(order).toBe("t1c1c2");
      order = "";
      set(1);
      flush();
      expect(order).toBe("t1c1c2");
    },
  );

  gap(
    "bug",
    "memo(fn) calls a function fn returns, as a setter's updater",
    "updates downstream pending computations",
    () => {
      const [set, t2, t3, readOrder] = createRoot(() => {
        const [s1, set] = signal(0);
        const [s2] = signal(0);
        let order = "";
        const t1 = memo(() => {
          order += "t1";
          return s1() === 0;
        });
        const t2 = memo(() => {
          order += "c1";
          return s1();
        });
        const t3 = memo(() => {
          order += "c2";
          t1();
          return memo(() => {
            order += "c2_1";
            return s2();
          });
        });
        order = "";
        return [set, t2, t3, () => order] as const;
      });
      set(1);
      flush();
      t2();
      t3()();
      expect(readOrder()).toBe("t1c1c2c2_1");
    },
  );

  describe("with changing dependencies", () => {
    let setI: core.Setter<boolean>;
    let setT: core.Setter<number>;
    let setE: core.Setter<number>;
    let fevals: number;
    let f: () => number;

    function init(): void {
      createRoot(() => {
        const [i, si] = signal<boolean>(true);
        const [t, st] = signal(1);
        const [e, se] = signal(2);
        [setI, setT, setE] = [si, st, se];
        fevals = 0;
        f = memo(() => {
          fevals++;
          return i() ? t() : e();
        });
        f();
        fevals = 0;
      });
    }

    test("updates on active dependencies", () => {
      init();
      setT(5);
      flush();
      expect(f()).toBe(5);
      expect(fevals).toBe(1);
    });

    test("does not update on inactive dependencies", () => {
      init();
      setE(5);
      flush();
      expect(f()).toBe(1);
      expect(fevals).toBe(0);
    });

    test("deactivates obsolete dependencies", () => {
      init();
      setI(false);
      flush();
      fevals = 0;
      setT(5);
      flush();
      expect(fevals).toBe(0);
    });

    test("activates new dependencies", () => {
      init();
      setI(false);
      flush();
      fevals = 0;
      setE(5);
      flush();
      expect(fevals).toBe(1);
    });

    gap(
      "glitch-free",
      "the join re-runs once per changed branch",
      "ensures that new dependencies are updated before dependee",
      () => {
        const [setA, c, readOrder, resetOrder] = createRoot(() => {
          let order = "";
          const [a, setA] = signal(0);
          const b = memo(() => {
            order += "b";
            return a() + 1;
          });
          const c = memo(() => {
            order += "c";
            const check = b();
            if (check) return check;
            return e();
          });
          const d = memo(() => a());
          const e = memo(() => {
            order += "d";
            return d() + 10;
          });

          expect(order).toBe("bcd");

          order = "";
          return [setA, c, () => order, () => (order = "")] as const;
        });
        setA(-1);
        flush();

        expect(readOrder()).toBe("bcd");
        expect(c()).toBe(9);

        resetOrder();
        setA(0);
        flush();
        expect(readOrder()).toBe("bdc");
        expect(c()).toBe(1);
      },
    );
  });

  test("does not update subsequent pending computations after stale invocations", () => {
    const [s1, set1] = signal(1);
    const [s2, set2] = signal(false);
    let count = 0;
    const t1 = memo(() => s1() > 0);
    const t2 = memo(() => s1() > 0);
    const c1 = memo(() => s1());
    const t3 = memo(() => {
      const a = s1();
      const b = s2();
      return a && b;
    });
    memo(() => {
      t1();
      t2();
      c1();
      t3();
      count++;
    });
    set2(true);
    flush();
    expect(count).toBe(2);
    set1(2);
    flush();
    expect(count).toBe(3);
  });

  gap(
    "glitch-free",
    "memos re-run depth-first, as each source writes",
    "evaluates stale computations before dependees when trackers stay unchanged",
    () => {
      const [s1, set] = derivedSignal(1, { equals: false });
      let order = "";
      const t1 = memo(() => {
        order += "t1";
        return s1() > 2;
      });
      const t2 = memo(() => {
        order += "t2";
        return s1() > 2;
      });
      const c1 = optionsMemo(
        () => {
          order += "c1";
          s1();
        },
        { equals: false },
      );
      memo(() => {
        order += "c2";
        t1();
        t2();
        c1();
      });
      order = "";
      set(1);
      flush();
      expect(order).toBe("t1t2c1c2");
      order = "";
      set(3);
      flush();
      expect(order).toBe("t1t2c1c2");
    },
  );

  test("correctly marks downstream computations as stale on change", () => {
    const [s1, set] = signal(1);
    let order = "";
    const t1 = memo(() => {
      order += "t1";
      return s1();
    });
    const c1 = memo(() => {
      order += "c1";
      return t1();
    });
    const c2 = memo(() => {
      order += "c2";
      return c1();
    });
    memo(() => {
      order += "c3";
      return c2();
    });
    order = "";
    set(2);
    flush();
    expect(order).toBe("t1c1c2c3");
  });
});
