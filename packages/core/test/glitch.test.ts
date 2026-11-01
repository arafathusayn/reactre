// Glitch-free propagation, on the unbundled runtime, without and with the async runtime: a write
// recomputes each memo it changes once, after the memos it reads, and no memo or effect ever
// reads part of a write. features.test.ts runs a diamond on the default build, with the async
// code stripped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import * as asyncApi from "../src/features/async.ts";
import { createRoot } from "../src/features/owner.ts";
import { batch, effect, memo, signal, untrack } from "../src/index.ts";
import * as core from "../src/index.ts";

/** The cases, run once on the plain runtime and once with the async runtime on. */
function cases(): void {
  test("a diamond's join recomputes once per write, and its effect runs once, with both branches new", () => {
    const [a, setA] = signal(1);
    const b = memo(() => a() * 2);
    const c = memo(() => a() * 3);
    let joins = 0;
    const d = memo(() => (joins++, `${b()}+${c()}`));
    const seen: string[] = [];
    effect(() => void seen.push(`${a()}:${d()}`));
    expect([joins, seen]).toEqual([1, ["1:2+3"]]);
    setA(2);
    expect([joins, seen]).toEqual([2, ["1:2+3", "2:4+6"]]);
    batch(() => {
      setA(3);
      setA(4);
    });
    expect([joins, seen]).toEqual([3, ["1:2+3", "2:4+6", "4:8+12"]]);
  });

  test("a chain recomputes in order, each link once, and a reader of its head and its tail sees both new", () => {
    const [x, setX] = signal(1);
    const order: string[] = [];
    const m1 = memo(() => (order.push("m1"), x() + 1));
    const m2 = memo(() => (order.push("m2"), m1() + 1));
    const m3 = memo(() => (order.push("m3"), m2() + 1));
    const seen: string[] = [];
    // Subscribed to x before the chain's tail: it is queued first, and pulls the chain.
    effect(() => void seen.push(`${x()}/${m3()}`));
    order.length = 0;
    setX(10);
    expect(order).toEqual(["m1", "m2", "m3"]);
    expect(seen).toEqual(["1/4", "10/13"]);
  });

  test("a jagged graph: a join that reads the source and a longer branch never sees them apart", () => {
    const [x, setX] = signal(1);
    const a = memo(() => x() * 2);
    const b = memo(() => a() + 1);
    const seen: string[] = [];
    const c = memo(() => {
      const v = `${x()}:${b()}`;
      seen.push(v);
      return v;
    });
    effect(() => void c());
    setX(2);
    setX(3);
    expect(seen).toEqual(["1:3", "2:5", "3:7"]);
  });

  test("a wide fan-in joins a hundred memos of one signal in one run", () => {
    const [x, setX] = signal(0);
    const fan = Array.from({ length: 100 }, (_, i) => memo(() => x() + i));
    let runs = 0;
    const sum = memo(() => (runs++, fan.reduce((s, m) => s + m(), 0)));
    let effects = 0;
    effect(() => void (sum(), effects++));
    setX(1);
    expect([sum(), runs, effects]).toEqual([4950 + 100, 2, 2]);
  });

  test("a wide fan-out: a hundred effects of one memo each run once, reading the memo current", () => {
    const [x, setX] = signal(1);
    const double = memo(() => x() * 2);
    const seen: number[][] = Array.from({ length: 100 }, () => []);
    for (let i = 0; i < 100; i++) effect(() => void seen[i]!.push(x() + double()));
    setX(2);
    for (const s of seen) expect(s).toEqual([3, 6]);
  });

  test("a memo whose value stays the same re-runs none of its readers", () => {
    const [x, setX] = signal(1);
    const parity = memo(() => x() % 2);
    let joins = 0;
    const label = memo(() => (joins++, parity() ? "odd" : "even"));
    let effects = 0;
    effect(() => void (label(), effects++));
    setX(3);
    expect([joins, effects]).toEqual([1, 1]);
    setX(4);
    expect([label(), joins, effects]).toEqual(["even", 2, 2]);
  });

  test("a memo read between a batch's writes, or in a handler after one, has the whole write", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(1);
    const sum = memo(() => a() + b());
    const reads: number[] = [];
    batch(() => {
      setA(2);
      reads.push(sum());
      setB(5);
      reads.push(sum());
    });
    setA(10);
    reads.push(sum());
    expect(reads).toEqual([3, 7, 15]);
  });

  test("a write in an effect's run re-runs what it notifies after that run, once", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const log: string[] = [];
    effect(() => {
      setB(a() * 10);
      log.push(`writer ${a()}`);
    });
    effect(() => void log.push(`reader ${a()} ${b()}`));
    log.length = 0;
    setA(1);
    expect(log).toEqual(["writer 1", "reader 1 10"]);
  });

  test("a batch in an effect's run, its first or a later one, leaves what it queued to the run's end", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const log: string[] = [];
    effect(() => void log.push(`reader ${b()}`));
    effect(() => {
      const v = a() + 1;
      batch(() => setB(v));
      log.push(`writer ${v}`);
    });
    expect(log).toEqual(["reader 0", "writer 1", "reader 1"]);
    log.length = 0;
    setA(1);
    expect(log).toEqual(["writer 2", "reader 2"]);
  });

  test("a memo stores what its function returns, a function too", () => {
    const f = (): string => "called";
    expect(memo(() => f)()).toBe(f);
    const g = memo(() => () => 5)();
    expect(typeof g).toBe("function");
    expect(g()).toBe(5);
  });

  test("a memo made in a memo's run is disposed by its owner's new run before it can run again", () => {
    const [x, setX] = signal(0);
    let inner = 0;
    let outer!: () => () => number;
    createRoot(() => {
      outer = memo(() => {
        const m = memo(() => (inner++, x()));
        // Read after the inner memo read it: x's write queues the inner memo first.
        x();
        return m;
      });
    });
    expect(inner).toBe(1);
    // Both read x: the owner runs first, and the inner memo it made before is disposed unrun.
    setX(1);
    expect(inner).toBe(2);
    expect(outer()()).toBe(1);
  });

  test("a memo read through its owner while it is brought up to date gets its last value", () => {
    const [x, setX] = signal(1);
    let inner!: () => number;
    const seen: number[] = [];
    createRoot(() => {
      const outer = memo(() => {
        // The owner reads the memo it made last time: brought up to date from the queue (it read
        // x first), that memo brings its owner up to date first, which reads it back.
        if (inner !== undefined) seen.push(untrack(inner));
        inner = memo(() => x() * 2);
        return x();
      });
      effect(() => void outer());
    });
    setX(2);
    expect(inner()).toBe(4);
    expect(seen).toEqual([2]);
  });

  test("two effects that write what each other reads throw, and the next write runs again", () => {
    const [c, setC] = signal(0);
    const [d, setD] = signal(0);
    const [on, setOn] = signal(false);
    effect(() => void (on() && setD(c() + 1)));
    effect(() => void (on() && setC(d() + 1)));
    expect(() => setOn(true)).toThrow("never settles");
    setOn(false);
    expect(on()).toBe(false);
  });
}

describe("glitch-free", () => cases());

describe("glitch-free, with the async runtime on", () => {
  beforeAll(() => core.__installAsync(asyncApi.__hooks));
  afterAll(() => core.__installAsync(false));
  cases();

  test("a pending async memo in a diamond holds the join's effect until it resolves, then runs it once", async () => {
    const [x, setX] = signal(1);
    const slow = asyncApi.memo(async () => {
      const v = x();
      await Promise.resolve();
      return v * 10;
    });
    const fast = memo(() => x() + 1);
    const seen: string[] = [];
    effect(() => {
      try {
        seen.push(`${fast()}:${slow()}`);
      } catch {
        // Not ready the first time.
      }
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["2:10"]);
    setX(2);
    expect(seen).toEqual(["2:10"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["2:10", "3:20"]);
  });
});
