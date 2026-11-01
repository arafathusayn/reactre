// Ports of Solid 2.0's timing tests that meet async data: onSettled, `from`, and createEffect
// reading an async memo through `latest`. They run on `onSettled` and `flush`
// (features/timing), `reaction` (features/reaction), and `memo`, `latest` and `isPending` from
// features/async, so this file turns the async runtime on before its tests and off after them,
// as ../async.test.ts does.
//
// Ported from packages/signals/tests/onSettled.test.ts, from.test.ts and createEffect.test.ts of
// solid-js 2.0.0-rc.20 (solidjs/solid@5e68925). Ported from Solid: MIT License, Copyright (c)
// 2016-2025 Ryan Carniato; the license is in ./harness.ts.
//
// Solid runs an onSettled callback at the flush. reactre runs it at the end of the batch it was
// queued in, or else in a microtask; `flush(fn)` is a batch, so it runs the callbacks `fn` queued
// before it returns (README, "Timing"). The ports queue them in `flush(() => ...)` where Solid
// queues them and then calls `flush()`, and assert what Solid asserts before its flush inside
// `fn`, after the queueing.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

import { __hooks, from, isPending, latest, memo } from "../../src/features/async.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { flush, onSettled } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { onCleanup, signal } from "../../src/index.ts";
import { gap, tick } from "./harness.ts";

beforeAll(() => core.__installAsync(__hooks));
afterAll(() => core.__installAsync(false));
afterEach(() => flush());

describe("onSettled.test.ts", () => {
  test("should run callback after flush", () => {
    const log: string[] = [];
    flush(() => {
      createRoot(() => {
        log.push("sync");
        onSettled(() => {
          log.push("settled");
        });
        log.push("after onSettled call");
      });
      expect(log).toEqual(["sync", "after onSettled call"]);
    });
    expect(log).toEqual(["sync", "after onSettled call", "settled"]);
  });

  test("should run without owner", () => {
    const log: string[] = [];
    flush(() => {
      onSettled(() => {
        log.push("settled");
      });
      expect(log).toEqual([]);
    });
    expect(log).toEqual(["settled"]);
  });

  test("should run nested callbacks without owner", () => {
    const log: string[] = [];
    flush(() =>
      onSettled(() => {
        log.push("outer");
        onSettled(() => {
          log.push("inner");
        });
      }),
    );
    expect(log).toEqual(["outer", "inner"]);
  });

  test("should run nested callbacks inside an owner", () => {
    const log: string[] = [];
    flush(() =>
      createRoot(() => {
        onSettled(() => {
          log.push("outer");
          onSettled(() => {
            log.push("inner");
          });
        });
      }),
    );
    expect(log).toEqual(["outer", "inner"]);
  });

  test("should throw when owner-backed onSettled calls flush reentrantly", () => {
    const log: string[] = [];
    const values: number[] = [];
    expect(() =>
      flush(() =>
        createRoot(() => {
          const [count, setCount] = signal(0);
          reaction(
            () => count(),
            (v) => {
              values.push(v);
            },
          );
          onSettled(() => {
            log.push("outer");
            onSettled(() => {
              log.push("inner");
            });
            setCount((v) => v + 5);
            flush();
            setCount((v) => v + 5);
            setCount((v) => v + 5);
          });
        }),
      ),
    ).toThrow();
    expect(log).toEqual(["outer"]);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(0);
  });

  test("should forbid onCleanup inside owner-backed onSettled", () => {
    flush(() =>
      createRoot(() => {
        onSettled(() => {
          expect(() => onCleanup(() => {})).toThrow();
        });
      }),
    );
  });

  test("should call cleanup when disposed", () => {
    const cleanup = mock();
    const dispose = flush(() =>
      createRoot((d) => {
        onSettled(() => cleanup);
        return d;
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(0);
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("should reject a returned cleanup in an unowned scope (#2766)", () => {
    const cleanup = mock();
    expect(() => flush(() => onSettled(() => cleanup))).toThrow();
    expect(cleanup).toHaveBeenCalledTimes(0);
  });

  test("should throw on invalid cleanup values", () => {
    expect(() =>
      flush(() =>
        createRoot(() => {
          onSettled((async () => {}) as unknown as () => void);
        }),
      ),
    ).toThrow();
  });

  gap(
    "settled-async",
    "the callback runs while the read is pending",
    "should wait for async to settle before running",
    async () => {
      const log: string[] = [];
      let resolve!: (v: string) => void;
      const promise = new Promise<string>((r) => (resolve = r));
      flush(() =>
        createRoot(() => {
          const $async = memo(async () => await promise);
          onSettled(() => {
            log.push("settled: " + $async());
          });
        }),
      );
      expect(log).toEqual([]);
      resolve("resolved");
      await tick(10);
      flush();
      expect(log).toContain("settled: resolved");
    },
  );

  test("should not track normal signal reads", () => {
    const [$x, setX] = signal(0);
    const log: number[] = [];
    flush(() =>
      createRoot(() => {
        onSettled(() => {
          log.push($x());
        });
      }),
    );
    expect(log).toEqual([0]);
    setX(1);
    flush();
    expect(log).toEqual([0]);
  });

  gap(
    "settled-async",
    "the callback runs while the read is pending",
    "should call cleanup on re-run after async settles",
    async () => {
      const cleanup = mock();
      const fx = mock();
      let resolve!: (v: string) => void;
      const promise = new Promise<string>((r) => (resolve = r));
      flush(() =>
        createRoot(() => {
          const $async = memo(async () => await promise);
          onSettled(() => {
            fx($async());
            return cleanup;
          });
        }),
      );
      expect(fx).toHaveBeenCalledTimes(0);
      expect(cleanup).toHaveBeenCalledTimes(0);
      resolve("done");
      await tick(10);
      flush();
      expect(fx).toHaveBeenCalledWith("done");
    },
  );
});

describe("createEffect.test.ts (async)", () => {
  test("should see consistent values with latest() and direct read on async resolve", async () => {
    const logs: [string, unknown][] = [];
    createRoot(() => {
      const get = memo(async () => 1);
      reaction(
        () => {
          const latestVal = latest(get);
          const directVal = get();
          logs.push(["compute:latest", latestVal]);
          logs.push(["compute:direct", directVal]);
          return { latestVal, directVal };
        },
        ({ latestVal, directVal }) => {
          logs.push(["effect:latest", latestVal]);
          logs.push(["effect:direct", directVal]);
        },
      );
    });
    flush();
    await Promise.resolve();
    flush();
    await tick();
    const find = (k: string): unknown => logs.find(([key]) => key === k)![1];
    expect(find("compute:latest")).toBe(1);
    expect(find("compute:direct")).toBe(1);
    expect(find("compute:latest")).toBe(find("compute:direct"));
    expect(find("effect:latest")).toBe(1);
    expect(find("effect:direct")).toBe(1);
  });
});

describe("from.test.ts", () => {
  const microtasks = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    flush();
  };

  type Subscribe<T> = (next: (v: T) => void, error: (e: unknown) => void, complete: () => void) => () => void;

  /** A subscribe function that logs open and close, and exposes its observer's `next`. */
  function source<T>(label: string, log: string[], initial?: { value: T }): Subscribe<T> & { next: (v: T) => void } {
    let next: ((v: T) => void) | null = null;
    const subscribe: Subscribe<T> = (n) => {
      log.push(`open ${label}`);
      next = n;
      if (initial) n(initial.value);
      return () => {
        log.push(`close ${label}`);
        next = null;
      };
    };
    return Object.assign(subscribe, { next: (v: T) => next?.(v) });
  }

  /** Mounts `build`'s memo under a root with a reader effect; returns the values it saw. */
  function mount<T>(build: () => () => T): { seen: unknown[]; read: () => T; dispose: () => void } {
    const seen: unknown[] = [];
    let read!: () => T;
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      read = build();
      reaction(
        () => {
          try {
            return latest(read);
          } catch {
            return "<pending>";
          }
        },
        (v) => void seen.push(v),
      );
    });
    flush();
    return { seen, read: () => read(), dispose };
  }

  test("a value emitted during subscribe is readable right after flush (no tick)", () => {
    const log: string[] = [];
    const src = source("a", log, { value: 1 });
    const { seen, read, dispose } = mount(() => memo(() => from<number>(src)));
    expect(read()).toBe(1);
    expect(seen).toEqual([1]);
    expect(isPending(read)).toBe(false);
    dispose();
  });

  test("dispose unsubscribes, and later emissions are ignored", async () => {
    const log: string[] = [];
    const src = source("a", log, { value: 1 });
    const { seen, dispose } = mount(() => memo(() => from<number>(src)));
    expect(log).toEqual(["open a"]);
    dispose();
    expect(log).toEqual(["open a", "close a"]);
    src.next(2);
    await microtasks();
    expect(seen).toEqual([1]);
    expect(log).toEqual(["open a", "close a"]);
  });

  test("accepts an RxJS-shaped Observable returning { unsubscribe }", async () => {
    const log: string[] = [];
    let observer: { next(v: number): void } | null = null;
    const obs = {
      subscribe(o: { next(v: number): void }) {
        log.push("subscribe");
        observer = o;
        o.next(10);
        return { unsubscribe: () => void log.push("unsubscribe") };
      },
    };
    const { read, dispose } = mount(() => memo(() => from<number>(obs)));
    expect(read()).toBe(10);
    observer!.next(11);
    await microtasks();
    expect(read()).toBe(11);
    dispose();
    expect(log).toEqual(["subscribe", "unsubscribe"]);
  });
});
