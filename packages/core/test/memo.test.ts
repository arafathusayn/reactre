// memo and signal with Solid 2.0's options (@reactre/core/features/memo), on the unbundled
// runtime: `equals`, `equals: false`, a memo's `prev`, and writable derived signals.

import { describe, expect, test } from "bun:test";

import { memo, signal } from "../src/features/memo.ts";
import { createRoot } from "../src/features/owner.ts";
import { batch, effect, signal as coreSignal } from "../src/index.ts";

/** How many times `fn` has run, as an effect: it runs once now. */
function runs(fn: () => unknown): () => number {
  let n = 0;
  effect(() => {
    fn();
    n++;
  });
  return () => n;
}

describe("memo", () => {
  test("without options, as core's: readers re-run when the value differs (!==)", () => {
    const [a, setA] = coreSignal(1);
    const parity = memo(() => a() % 2);
    const r = runs(parity);
    setA(3);
    expect(r()).toBe(1);
    setA(4);
    expect([parity(), r()]).toEqual([0, 2]);
  });

  test("equals decides whether readers re-run, and is not asked about the first value", () => {
    const [user, setUser] = coreSignal({ id: 1, name: "a" });
    const asked: number[] = [];
    const current = memo(() => user(), {
      equals: (p, n) => {
        asked.push(p.id);
        return p.id === n.id;
      },
    });
    const r = runs(current);
    setUser({ id: 1, name: "b" });
    expect([r(), current().name]).toEqual([1, "a"]);
    setUser({ id: 2, name: "c" });
    expect([r(), current().name]).toEqual([2, "c"]);
    expect(asked).toEqual([1, 1]);
  });

  test("equals: false re-runs readers every time fn runs", () => {
    const [a, setA] = coreSignal(1);
    const m = memo(() => (a(), "same"), { equals: false });
    const r = runs(m);
    setA(2);
    setA(3);
    expect(r()).toBe(3);
  });

  test("fn is given its last value", () => {
    const [a, setA] = coreSignal(1);
    const total = memo<number>((prev) => (prev ?? 0) + a());
    setA(2);
    setA(3);
    expect(total()).toBe(6);
  });
});

describe("signal", () => {
  test("a value, as core's, with options", () => {
    const [n, setN] = signal(1);
    const r = runs(n);
    setN(1);
    setN((x) => x + 1);
    expect([n(), r()]).toEqual([2, 2]);
    const [o, setO] = signal({ v: 1 }, { equals: false });
    const ro = runs(o);
    setO((x) => x);
    expect(ro()).toBe(2);
    const [p, setP] = signal({ v: 1 }, { equals: (a, b) => a.v === b.v });
    const rp = runs(p);
    setP({ v: 1 });
    expect(rp()).toBe(1);
  });

  test("signal(fn) is a writable derived signal: a write holds until its sources change", () => {
    const [items, setItems] = coreSignal(["a", "b"]);
    const [selected, setSelected] = signal<string | undefined>((prev) => (items().includes(prev!) ? prev : items()[0]));
    const r = runs(selected);
    expect(selected()).toBe("a");
    setSelected("b");
    expect([selected(), r()]).toEqual(["b", 2]);
    // fn gets the written value as prev: still in the list, it is kept.
    setItems(["b", "c"]);
    expect([selected(), r()]).toEqual(["b", 2]);
    setItems(["c"]);
    expect([selected(), r()]).toEqual(["c", 3]);
    batch(() => setSelected((s) => s + "!"));
    expect(selected()).toBe("c!");
  });

  test("a derived signal stops with its owner", () => {
    const [a, setA] = coreSignal(1);
    let read!: () => number;
    const dispose = createRoot((dispose) => {
      [read] = signal(() => a() * 10);
      return dispose;
    });
    dispose();
    setA(2);
    expect(read()).toBe(10);
  });
});
