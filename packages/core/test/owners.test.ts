// createRoot, getOwner and runWithOwner (@reactre/core/features/owner), and reaction, the split
// effect (@reactre/core/features/reaction), on the unbundled runtime. Each test disposes the roots
// it makes, so no effect outlives it into another file.

import { describe, expect, test } from "bun:test";

import { createRoot, getOwner, type Owner, runWithOwner } from "../src/features/owner.ts";
import { reaction } from "../src/features/reaction.ts";
import * as core from "../src/index.ts";
import { batch, effect, onCleanup, signal } from "../src/index.ts";

test("@reactre/core leaves the owner and timing APIs to its feature modules", () => {
  for (const name of ["createRoot", "getOwner", "runWithOwner", "onSettled", "flush", "reaction"])
    expect(core).not.toHaveProperty(name);
});

test("@reactre/core leaves dynamic() to @reactre/core/features/dynamic, and keeps what is compiled away", () => {
  expect(core).not.toHaveProperty("dynamic");
  // <Dynamic> and the other control flow stubs stay, as does the helper compiled code calls.
  for (const name of ["Show", "Switch", "Match", "Repeat", "Portal", "Dynamic", "__class"])
    expect(core).toHaveProperty(name);
});

describe("createRoot", () => {
  test("its dispose stops what fn made, deepest first; fn is untracked and its result returned", () => {
    const [n, setN] = signal(0);
    const log: string[] = [];
    let runs = 0;
    const [dispose, out] = createRoot((dispose) => {
      n(); // untracked: nothing re-runs createRoot
      runs++;
      effect(() => {
        log.push("outer " + n());
        effect(() => onCleanup(() => log.push("inner cleanup")));
        onCleanup(() => log.push("outer cleanup"));
      });
      onCleanup(() => log.push("root cleanup"));
      return [dispose, 7] as const;
    });
    expect(out).toBe(7);
    setN(1);
    expect(runs).toBe(1);
    expect(log).toEqual(["outer 0", "inner cleanup", "outer cleanup", "outer 1"]);
    log.length = 0;
    dispose();
    expect(log).toEqual(["inner cleanup", "outer cleanup", "root cleanup"]);
    setN(2);
    dispose();
    expect(log).toEqual(["inner cleanup", "outer cleanup", "root cleanup"]);
  });

  test("a root made in an owner goes with it, or before it by dispose, which leaves its list", () => {
    const [n, setN] = signal(0);
    let cleaned = 0;
    const disposers: (() => void)[] = [];
    const stop = createRoot((stop) => {
      effect(() => {
        n();
        disposers.push(createRoot((d) => (onCleanup(() => cleaned++), d)));
      });
      return stop;
    });
    // The effect re-runs: the root its last run made is disposed with that run.
    setN(1);
    expect(cleaned).toBe(1);
    // That root is gone from a list the owner has since replaced: disposing it again does nothing.
    disposers[0]!();
    expect(cleaned).toBe(1);
    // The current root, disposed by hand, leaves the owner's list: the owner's next run does not
    // dispose it again.
    disposers[1]!();
    expect(cleaned).toBe(2);
    setN(2);
    expect(cleaned).toBe(2);
    stop();
    expect(cleaned).toBe(3);
    // The owner is disposed, its list gone: disposing the last root again does nothing.
    disposers[2]!();
    expect(cleaned).toBe(3);
  });

  test("under runWithOwner(null), a root outlives the owner it was made in", () => {
    const [n, setN] = signal(0);
    const seen: number[] = [];
    let detached!: () => void;
    const stop = createRoot((stop) => {
      runWithOwner(null, () =>
        createRoot((d) => {
          detached = d;
          effect(() => void seen.push(n()));
        }),
      );
      return stop;
    });
    stop();
    setN(1);
    expect(seen).toEqual([0, 1]);
    detached();
    setN(2);
    expect(seen).toEqual([0, 1]);
  });

  test("a cleanup that throws stops no other: every one runs, and the first error is thrown after", () => {
    const log: string[] = [];
    const [n, setN] = signal(0);
    const stop = createRoot((stop) => {
      createRoot(() => {
        onCleanup(() => {
          throw new Error("child");
        });
        onCleanup(() => log.push("child after"));
      });
      effect(() => {
        n();
        onCleanup(() => {
          throw new Error("effect");
        });
        onCleanup(() => log.push("effect after"));
      });
      onCleanup(() => {
        throw new Error("root");
      });
      onCleanup(() => log.push("root after"));
      return stop;
    });
    // An effect's re-run cleans what its last run made first: all of it, then the error, which
    // stops the run (so it has no cleanups left).
    expect(() => setN(1)).toThrow("effect");
    expect(log).toEqual(["effect after"]);
    log.length = 0;
    expect(stop).toThrow("child");
    expect(log).toEqual(["child after", "root after"]);
  });
});

describe("getOwner and runWithOwner", () => {
  test("getOwner is null outside any owner, and the running effect or root inside one", () => {
    expect(getOwner()).toBeNull();
    let inRoot: Owner | null = null,
      inEffect: Owner | null = null;
    const stop = createRoot((stop) => {
      inRoot = getOwner();
      effect(() => void (inEffect = getOwner()));
      return stop;
    });
    expect(inRoot).not.toBeNull();
    expect(inEffect).not.toBeNull();
    expect(inEffect).not.toBe(inRoot);
    expect(getOwner()).toBeNull();
    stop();
  });

  test("what fn makes belongs to the owner given; fn is untracked; the owner comes back after a throw", () => {
    const [n, setN] = signal(0);
    let owner!: Owner | null;
    let cleaned = 0,
      reads = 0;
    const stop = createRoot((stop) => {
      owner = getOwner();
      return stop;
    });
    effect(() => {
      // Made later, from inside another effect, but owned by the root: tracked by neither.
      const v = runWithOwner(owner, () => {
        reads++;
        n();
        onCleanup(() => cleaned++);
        return "v";
      });
      expect(v).toBe("v");
    });
    setN(1);
    expect(reads).toBe(1);
    expect(() =>
      runWithOwner(owner, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getOwner()).toBeNull();
    stop();
    expect(cleaned).toBe(1);
  });
});

describe("reaction", () => {
  test("apply runs untracked on each change of compute's value, with the last as prev", () => {
    const [a, setA] = signal(1);
    const [other, setOther] = signal(0);
    const calls: [number, number | undefined][] = [];
    let computes = 0;
    const stop = createRoot((stop) => {
      reaction(
        () => (computes++, a() % 10),
        (v, prev) => {
          other(); // untracked
          calls.push([v, prev]);
        },
      );
      return stop;
    });
    expect(calls).toEqual([[1, undefined]]);
    setA(2);
    expect(calls).toEqual([
      [1, undefined],
      [2, 1],
    ]);
    // compute re-runs, but its value is the same: apply does not.
    setA(12);
    expect(computes).toBe(3);
    expect(calls).toHaveLength(2);
    setOther(1);
    expect(calls).toHaveLength(2);
    batch(() => {
      setA(3);
      setA(4);
    });
    expect(calls.at(-1)).toEqual([4, 2]);
    stop();
    setA(5);
    expect(calls).toHaveLength(3);
  });

  test("apply's cleanup, and what it made, go before the next apply and on dispose", () => {
    const [a, setA] = signal(0);
    const [tick, setTick] = signal(0);
    const log: string[] = [];
    const stop = createRoot((stop) => {
      reaction(a, (v) => {
        log.push("apply " + v);
        effect(() => void log.push(`tick ${v}:${tick()}`));
        return () => log.push("cleanup " + v);
      });
      return stop;
    });
    setTick(1);
    setA(1);
    expect(log).toEqual(["apply 0", "tick 0:0", "tick 0:1", "cleanup 0", "apply 1", "tick 1:1"]);
    log.length = 0;
    stop();
    setTick(2);
    expect(log).toEqual(["cleanup 1"]);
  });
});
