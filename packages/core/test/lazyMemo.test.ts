// `memo` and `signal` (@reactre/core/features/memo) with Solid 2.0's `lazy` and `unobserved`, on
// the unbundled runtime. @reactre/compiler sends a call that passes either option to the module's
// reader-counting entries, `__observedMemo` and `__observedSignal` (its observed.ts), so these
// tests call them as compiled code does: `memo(fn, { lazy: true })` in a .tsx file is
// `__observedMemo(fn, { lazy: true })`. A signal's readers are counted only for those options:
// `unobserved` runs in a microtask after the last reader stopped reading, if none came back. A
// call the compiler did not see reaches `memo` and `signal` themselves, whose development build
// (the sources, as `bun test` runs them) throws for either option.

import { describe, expect, test } from "bun:test";

import {
  __observedMemo as observedMemo,
  __observedSignal as observedSignal,
  memo,
  signal,
} from "../src/features/memo.ts";
import { createRoot } from "../src/features/owner.ts";
import { effect, signal as coreSignal, untrack } from "../src/index.ts";

/** A microtask's turn: what waits for the next one has run. */
const tick = (): Promise<void> => Promise.resolve();

/** An effect that reads `fn`, in a root of its own: its `dispose`, and how many times it ran. */
function reader(fn: () => unknown): { dispose: () => void; runs: () => number } {
  let n = 0;
  const dispose = createRoot((d) => {
    effect(() => {
      fn();
      n++;
    });
    return d;
  });
  return { dispose, runs: () => n };
}

describe("memo with lazy and unobserved", () => {
  test("without them, the reader-counting entries are memo and signal", () => {
    const [a, setA] = coreSignal(1);
    const m = observedMemo(() => a() * 2, { equals: (x, y) => x === y });
    const [s, setS] = observedSignal(() => a() + 1);
    const [plain] = observedSignal(5);
    const off = observedMemo(() => a(), { lazy: false });
    setA(2);
    expect([m(), s(), plain(), off()]).toEqual([4, 3, 5, 2]);
    setS(10);
    expect(s()).toBe(10);
    // The same as memo's and signal's, with no reader count behind them.
    const viaMemo = memo(() => a() * 2, { equals: (x, y) => x === y }),
      [viaSignal] = signal(5);
    expect([viaMemo(), viaSignal()]).toEqual([m(), plain()]);
  });

  test("lazy: fn runs first when the memo is first read, then follows its sources while read", async () => {
    const [a, setA] = coreSignal(1);
    let runs = 0;
    const m = observedMemo(() => (runs++, a() * 10), { lazy: true });
    expect(runs).toBe(0);
    const r = reader(m);
    expect([m(), runs, r.runs()]).toEqual([10, 1, 1]);
    setA(2);
    expect([m(), runs, r.runs()]).toEqual([20, 2, 2]);
    // A reader that runs again keeps the memo running: it reads it again before the microtask.
    await tick();
    setA(3);
    expect([runs, r.runs()]).toEqual([3, 3]);
  });

  test("lazy: with no reader left it stops following its sources, keeping its value, until it is read", async () => {
    const [a, setA] = coreSignal(1);
    let runs = 0;
    const m = observedMemo(() => (runs++, a()), { lazy: true });
    const r = reader(m);
    r.dispose();
    // Still running until the microtask.
    setA(2);
    expect(runs).toBe(2);
    await tick();
    setA(3);
    expect(runs).toBe(2);
    // A read starts it again: fn runs with the current sources.
    expect(m()).toBe(3);
    expect(runs).toBe(3);
  });

  test("lazy: a read outside any reader computes it, and it stops again at the next microtask", async () => {
    const [a, setA] = coreSignal(1);
    let runs = 0;
    const m = observedMemo(() => (runs++, a()), { lazy: true });
    expect(untrack(m)).toBe(1);
    expect(m()).toBe(1);
    expect(runs).toBe(1);
    await tick();
    setA(2);
    expect(runs).toBe(1);
    expect(m()).toBe(2);
  });

  test("lazy: readers re-run when the value differs, as equals says", () => {
    const [a, setA] = coreSignal(1);
    const parity = observedMemo(() => a() % 2, { lazy: true, equals: (x, y) => x === y });
    const r = reader(parity);
    setA(3);
    expect(r.runs()).toBe(1);
    setA(4);
    expect([parity(), r.runs()]).toEqual([0, 2]);
  });

  test("lazy: made in an owner, it goes with it, keeping its last value", async () => {
    const [a, setA] = coreSignal(1);
    let runs = 0,
      m!: () => number;
    const dispose = createRoot((d) => {
      m = observedMemo(() => (runs++, a()), { lazy: true });
      return d;
    });
    expect(m()).toBe(1);
    dispose();
    setA(2);
    expect([m(), runs]).toEqual([1, 1]);
    // Disposed before it was ever read: it never runs.
    const later = createRoot((d) => {
      const n = observedMemo(() => (runs++, a()), { lazy: true });
      d();
      return n;
    });
    expect(later()).toBeUndefined();
    expect(runs).toBe(1);
    await tick();
  });

  test("unobserved: called once the last reader has left, not while one runs again", async () => {
    const [a, setA] = coreSignal(1);
    let gone = 0;
    const m = observedMemo(() => a() + 1, { unobserved: () => gone++ });
    // Not lazy: it ran when made.
    expect(m()).toBe(2);
    const r1 = reader(m),
      r2 = reader(m);
    setA(2);
    await tick();
    expect(gone).toBe(0);
    r1.dispose();
    await tick();
    expect(gone).toBe(0);
    r2.dispose();
    expect(gone).toBe(0);
    await tick();
    expect(gone).toBe(1);
    // It goes on computing: it is not lazy.
    setA(5);
    expect(m()).toBe(6);
    // A reader that comes back and leaves again: called again.
    reader(m).dispose();
    await tick();
    expect(gone).toBe(2);
  });

  test("unobserved and lazy: it stops, then the callback runs", async () => {
    const [a, setA] = coreSignal(1);
    const log: string[] = [];
    const m = observedMemo(() => (log.push("run " + a()), a()), { lazy: true, unobserved: () => log.push("gone") });
    reader(m).dispose();
    await tick();
    setA(2);
    expect(log).toEqual(["run 1", "gone"]);
  });
});

describe("signal with unobserved", () => {
  test("unobserved: once its last reader leaves; writes and reads go on as a signal's", async () => {
    let gone = 0;
    const [n, setN] = observedSignal(1, { unobserved: () => gone++ });
    const r = reader(n);
    setN((x) => x + 1);
    setN(2);
    expect([n(), r.runs()]).toEqual([2, 2]);
    r.dispose();
    await tick();
    expect(gone).toBe(1);
    // Read with no reader: nothing to leave.
    expect(n()).toBe(2);
    await tick();
    expect(gone).toBe(1);
  });

  test("a derived signal with unobserved: computed at once, written until its sources change", async () => {
    const [a, setA] = coreSignal(1);
    let gone = 0;
    const [s, setS] = observedSignal(() => a() * 2, { unobserved: () => gone++, equals: false });
    const r = reader(s);
    setS(7);
    expect([s(), r.runs()]).toEqual([7, 2]);
    setA(2);
    expect([s(), r.runs()]).toEqual([4, 3]);
    r.dispose();
    await tick();
    expect(gone).toBe(1);
  });

  test("writes that re-run its readers, beside a core signal's, do not count as leaving", async () => {
    let gone = 0;
    const [n, setN] = observedSignal(1, { unobserved: () => gone++ });
    const [m, setM] = coreSignal(1);
    const r = reader(() => n() + m());
    for (let i = 2; i < 5; i++) {
      setN(i);
      setM(i);
    }
    await tick();
    expect([gone, r.runs()]).toEqual([0, 7]);
    r.dispose();
    await tick();
    expect(gone).toBe(1);
  });
});

describe("a call the compiler did not see", () => {
  test("the development build throws for lazy and unobserved, naming the plugin and the fix", () => {
    const [a] = coreSignal(1);
    const thrown = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(thrown(() => memo(() => a(), { lazy: true }))).toStartWith(
      "reactre: memo's `lazy` option needs @reactre/plugin to compile this call",
    );
    expect(thrown(() => memo(() => a(), { unobserved: () => {} }))).toStartWith(
      "reactre: memo's `unobserved` option needs @reactre/plugin",
    );
    expect(thrown(() => signal(1, { unobserved: () => {} }))).toStartWith(
      "reactre: signal's `unobserved` option needs @reactre/plugin",
    );
    expect(thrown(() => signal(() => a(), { unobserved: () => {} }))).toContain("the plugin's `include` option");
    // Neither option: nothing to throw for.
    expect(memo(() => a(), { lazy: false })()).toBe(1);
  });
});
