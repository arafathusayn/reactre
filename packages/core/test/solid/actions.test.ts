// Ports of Solid 2.0's tests of actions and optimistic values: action (generators, async
// generators, yield*, errors, the Promise it returns, the transition it runs in),
// createOptimistic, createOptimisticStore and its first flight under <Loading>, on reactre's
// features/actions. Solid's createRenderEffect(compute, apply) is reactre's reaction.
//
// Ported from packages/signals/tests/action.test.ts, packages/signals/tests/createOptimistic.test.ts,
// packages/signals/tests/store/createOptimisticStore.test.ts and packages/web/test/loading.spec.tsx
// (its optimistic store's first flight), of solid-js 2.0.0-rc.20 (solidjs/solid@5e68925).
//
// Ported from Solid: MIT License, Copyright (c) 2016-2025 Ryan Carniato; the license is in
// ./harness.ts.
//
// The async runtime is turned on before these tests and off after them, as in ../actions.test.ts.
// Solid's `await Promise.resolve()` steps are kept as they are: each is one microtask.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { FakeElement, installFakeDocument } from "@reactre/testdom";

import { action, createOptimistic, createOptimisticStore } from "../../src/features/actions.ts";
import * as actionsApi from "../../src/features/actions.ts";
import * as asyncApi from "../../src/features/async.ts";
import { __hooks, latest } from "../../src/features/async.ts";
import * as context from "../../src/features/context.ts";
import { createRoot } from "../../src/features/owner.ts";
import { reaction } from "../../src/features/reaction.ts";
import { createStore } from "../../src/features/store.ts";
import { flush } from "../../src/features/timing.ts";
import * as core from "../../src/index.ts";
import { signal } from "../../src/index.ts";
import { base, compile, gap, tick } from "./harness.ts";

beforeAll(() => core.__installAsync(__hooks));
afterAll(() => core.__installAsync(false));
beforeEach(installFakeDocument);
// A test that ends with an action still running leaves its transition open: the next starts clean.
afterEach(() => {
  core.__installAsync(false);
  core.__installAsync(__hooks);
});

/** One microtask, as Solid's `await Promise.resolve()`. */
const micro = (): Promise<void> => Promise.resolve();

/** `createRenderEffect(compute, apply)` in a root of its own. */
function watch<T>(compute: () => T, apply: (v: T) => void): void {
  createRoot(() => reaction(compute, (v) => void apply(v)));
}

describe("signals/tests/action.test.ts", () => {
  describe("basic behavior", () => {
    test("should create a callable function from a generator", () => {
      const myAction = action(function* () {
        // empty generator
      });
      expect(myAction).toBeInstanceOf(Function);
    });

    gap(
      "action-sync-yield",
      "every yield resumes in a microtask, a value that is not a Promise too",
      "should execute generator body synchronously for sync yields",
      () => {
        const calls: string[] = [];
        const myAction = action(function* () {
          calls.push("start");
          yield;
          calls.push("after yield");
        });
        void myAction();
        expect(calls).toEqual(["start", "after yield"]);
      },
    );

    test("should pass arguments through to the generator function", () => {
      const receivedArgs: unknown[] = [];
      const myAction = action(function* (a: number, b: string, c: boolean) {
        receivedArgs.push(a, b, c);
      });
      void myAction(42, "hello", true);
      expect(receivedArgs).toEqual([42, "hello", true]);
    });

    test("should return a Promise that resolves with the return value", async () => {
      const myAction = action(function* () {
        return 123;
      });
      const result = myAction();
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe(123);
    });
  });

  describe("generator control flow", () => {
    gap(
      "action-sync-yield",
      "every yield resumes in a microtask, a value that is not a Promise too",
      "should step through multiple yield statements in sequence",
      () => {
        const steps: number[] = [];
        const myAction = action(function* () {
          steps.push(1);
          yield;
          steps.push(2);
          yield;
          steps.push(3);
        });
        void myAction();
        expect(steps).toEqual([1, 2, 3]);
      },
    );

    test("should handle generators that complete immediately (no yields)", () => {
      const executed = mock(() => {});
      const myAction = action(function* () {
        executed();
      });
      void myAction();
      expect(executed).toHaveBeenCalledTimes(1);
    });

    gap(
      "action-sync-yield",
      "every yield resumes in a microtask, a value that is not a Promise too",
      "should handle generators with only sync yields",
      () => {
        const values: number[] = [];
        const myAction = action(function* () {
          values.push(1);
          yield "a";
          values.push(2);
          yield "b";
          values.push(3);
          yield "c";
          values.push(4);
        });
        void myAction();
        expect(values).toEqual([1, 2, 3, 4]);
      },
    );

    gap(
      "action-sync-yield",
      "every yield resumes in a microtask, a value that is not a Promise too",
      "should pass yielded values back into generator via yield expression result",
      () => {
        const results: unknown[] = [];
        const myAction = action(function* () {
          const a: unknown = yield "first";
          results.push(a);
          const b: unknown = yield "second";
          results.push(b);
        });
        void myAction();
        expect(results).toEqual(["first", "second"]);
      },
    );
  });

  describe("async handling", () => {
    test("should await yielded promises before continuing", async () => {
      const steps: string[] = [];
      const myAction = action(function* () {
        steps.push("before");
        yield Promise.resolve();
        steps.push("after");
      });
      void myAction();
      expect(steps).toEqual(["before"]);
      await micro();
      expect(steps).toEqual(["before", "after"]);
    });

    test("should pass resolved promise value back to generator", async () => {
      let receivedValue: unknown;
      const myAction = action(function* () {
        receivedValue = yield Promise.resolve(42);
      });
      void myAction();
      await micro();
      expect(receivedValue).toBe(42);
    });

    test("should await a yielded non-Promise thenable and resume with its value (#2765)", async () => {
      let receivedValue: unknown;
      const thenable = {
        then(onFulfilled: (v: number) => void) {
          queueMicrotask(() => onFulfilled(42));
        },
      };
      const myAction = action(function* () {
        receivedValue = yield thenable;
      });
      void myAction();
      expect(receivedValue).toBeUndefined();
      await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
      await micro();
      expect(receivedValue).toBe(42);
    });

    test("should handle multiple async yields in sequence", async () => {
      const values: number[] = [];
      const myAction = action(function* () {
        values.push(1);
        yield Promise.resolve();
        values.push(2);
        yield Promise.resolve();
        values.push(3);
      });
      void myAction();
      expect(values).toEqual([1]);
      await micro();
      expect(values).toEqual([1, 2]);
      await micro();
      expect(values).toEqual([1, 2, 3]);
    });

    test("should maintain transition context across async boundaries", async () => {
      const [$x, setX] = signal(0);
      const values: number[] = [];
      watch(
        () => $x(),
        (v) => values.push(v),
      );
      flush();
      expect(values).toEqual([0]);
      const myAction = action(function* () {
        setX(1);
        yield Promise.resolve();
        setX(2);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      expect(values).toEqual([0]);
      expect($x()).toBe(0);
      await micro();
      flush();
      expect(values).toEqual([0]);
      expect($x()).toBe(0);
      await micro();
      expect(values).toEqual([0, 2]);
      expect($x()).toBe(2);
    });
  });

  describe("transition management", () => {
    test("should initialize a transition when action starts", async () => {
      const [$x, setX] = signal(0);
      const myAction = action(function* () {
        setX(1);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(1);
    });

    test("should keep transition alive while action is running", async () => {
      const [$x, setX] = signal(0);
      const reads: number[] = [];
      const myAction = action(function* () {
        setX(1);
        yield Promise.resolve();
        reads.push($x());
        setX(2);
        yield Promise.resolve();
        reads.push($x());
      });
      void myAction();
      flush();
      await micro();
      expect(reads).toEqual([0]);
      await micro();
      expect(reads).toEqual([0, 0]);
      expect($x()).toBe(2);
    });

    test("should complete transition when action finishes", async () => {
      const [$x, setX] = signal(0);
      const values: number[] = [];
      watch(
        () => $x(),
        (v) => values.push(v),
      );
      flush();
      const myAction = action(function* () {
        setX(5);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      expect(values).toEqual([0]);
      await micro();
      expect(values).toEqual([0, 5]);
    });

    test("should complete transition and commit final values when action finishes", async () => {
      const [$a, setA] = signal(1);
      const [$b, setB] = signal(10);
      const myAction = action(function* () {
        setA(2);
        setB(20);
        yield Promise.resolve();
        setA(3);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      await micro();
      flush();
      await micro();
      flush();
      expect($a()).toBe(3);
      expect($b()).toBe(20);
    });
  });

  describe("multiple actions", () => {
    test("should allow multiple concurrent actions in same transition", async () => {
      const [$x, setX] = signal(0);
      const steps: string[] = [];
      const action1 = action(function* () {
        steps.push("a1-start");
        setX((v) => v + 1);
        yield Promise.resolve();
        steps.push("a1-end");
      });
      const action2 = action(function* () {
        steps.push("a2-start");
        setX((v) => v + 10);
        yield Promise.resolve();
        steps.push("a2-end");
      });
      void action1();
      void action2();
      flush();
      expect(steps).toEqual(["a1-start", "a2-start"]);
      expect($x()).toBe(0);
      await micro();
      expect(steps).toEqual(["a1-start", "a2-start", "a1-end", "a2-end"]);
      expect($x()).toBe(11);
    });

    test("should only complete transition when ALL actions finish", async () => {
      const [$x, setX] = signal(0);
      const shortAction = action(function* () {
        setX(1);
        yield Promise.resolve();
      });
      const longAction = action(function* () {
        setX(2);
        yield Promise.resolve();
        yield Promise.resolve();
        yield Promise.resolve();
        setX(3);
      });
      void shortAction();
      void longAction();
      flush();
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(3);
    });

    test("should merge actions when one action calls another", async () => {
      const [$x, setX] = signal(0);
      const steps: string[] = [];
      const innerAction = action(function* () {
        steps.push("inner-start");
        setX((v) => v + 100);
        yield Promise.resolve();
        steps.push("inner-end");
      });
      const outerAction = action(function* () {
        steps.push("outer-start");
        setX(1);
        void innerAction();
        yield Promise.resolve();
        steps.push("outer-end");
      });
      void outerAction();
      flush();
      expect(steps).toEqual(["outer-start", "inner-start"]);
      expect($x()).toBe(0);
      await micro();
      expect(steps).toEqual(["outer-start", "inner-start", "inner-end", "outer-end"]);
      expect($x()).toBe(101);
    });

    test("should isolate independent transitions that don't share signals", async () => {
      const [$a, setA] = signal(0);
      const [$b, setB] = signal(0);
      const aValues: number[] = [];
      const bValues: number[] = [];
      watch(
        () => $a(),
        (v) => aValues.push(v),
      );
      watch(
        () => $b(),
        (v) => bValues.push(v),
      );
      flush();
      expect(aValues).toEqual([0]);
      expect(bValues).toEqual([0]);
      const actionA = action(function* () {
        setA(1);
        yield Promise.resolve();
        yield Promise.resolve();
        yield Promise.resolve();
        setA(2);
      });
      const actionB = action(function* () {
        setB(10);
        yield Promise.resolve();
        setB(20);
      });
      void actionA();
      flush();
      await micro();
      void actionB();
      flush();
      await micro();
      await micro();
      expect($b()).toBe(20);
      expect(bValues).toContain(20);
      await micro();
      await micro();
      expect($a()).toBe(2);
      expect(aValues).toContain(2);
    });
  });

  describe("signal integration", () => {
    test("should hold regular signal updates during action", async () => {
      const [$x, setX] = signal(0);
      const myAction = action(function* () {
        setX(1);
        yield Promise.resolve();
        setX(2);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(2);
    });

    test("should flush held signals when action completes", async () => {
      const [$x, setX] = signal(0);
      const effectRuns = mock((_v: number) => {});
      watch(
        () => $x(),
        (v) => effectRuns(v),
      );
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      expect(effectRuns).toHaveBeenLastCalledWith(0);
      const myAction = action(function* () {
        setX(5);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      await micro();
      expect(effectRuns).toHaveBeenCalledTimes(2);
      expect(effectRuns).toHaveBeenLastCalledWith(5);
    });

    test("should commit final signal values when action completes", async () => {
      const [$a, setA] = signal(1);
      const [$b, setB] = signal(2);
      const [$c, setC] = signal(3);
      const myAction = action(function* () {
        setA(10);
        setB(20);
        yield Promise.resolve();
        setC(30);
        yield Promise.resolve();
      });
      void myAction();
      flush();
      await micro();
      flush();
      await micro();
      flush();
      expect($a()).toBe(10);
      expect($b()).toBe(20);
      expect($c()).toBe(30);
    });

    gap(
      "action-writes",
      "a write outside an action's code applies at once, even in the tick the action started in",
      "latest() shows an entangled write at once, and a later rewrite during the hold wins at settle",
      async () => {
        const committed: string[] = [];
        const shown: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const [text, setText] = signal("hello");
        const post = action(function* () {
          yield gate;
        });
        watch(
          () => text(),
          (v) => committed.push(v),
        );
        watch(
          () => latest(text),
          (v) => shown.push(v),
        );
        flush();
        void post();
        setText("");
        flush();
        expect(text()).toBe("hello");
        expect(latest(text)).toBe("");
        expect(shown).toEqual(["hello", ""]);
        setText("a");
        flush();
        expect(text()).toBe("hello");
        expect(latest(text)).toBe("a");
        expect(shown).toEqual(["hello", "", "a"]);
        release();
        await tick();
        flush();
        expect(text()).toBe("a");
        expect(committed).toEqual(["hello", "a"]);
        expect(shown).toEqual(["hello", "", "a"]);
      },
    );
  });

  describe("edge cases", () => {
    test("should handle empty generator (immediate return)", () => {
      const executed = mock(() => {});
      const myAction = action(function* () {
        executed();
        return;
      });
      void myAction();
      expect(executed).toHaveBeenCalledTimes(1);
    });

    gap(
      "action-sync-yield",
      "every yield resumes in a microtask, a value that is not a Promise too",
      "should handle generator that yields undefined",
      () => {
        const steps: string[] = [];
        const myAction = action(function* () {
          steps.push("before");
          yield undefined;
          steps.push("after");
        });
        void myAction();
        expect(steps).toEqual(["before", "after"]);
      },
    );

    test("should work with async generators", async () => {
      const steps: string[] = [];
      const myAction = action(async function* () {
        steps.push("start");
        yield await Promise.resolve("first");
        steps.push("middle");
        yield await Promise.resolve("second");
        steps.push("end");
      });
      void myAction();
      expect(steps).toContain("start");
      await tick();
      expect(steps).toContain("middle");
      await tick();
      expect(steps).toContain("end");
    });

    test("should handle action called multiple times", async () => {
      const [$x, setX] = signal(0);
      let callCount = 0;
      const myAction = action(function* (increment: number) {
        callCount++;
        setX((v) => v + increment);
        yield Promise.resolve();
      });
      void myAction(1);
      void myAction(10);
      void myAction(100);
      flush();
      expect(callCount).toBe(3);
      expect($x()).toBe(0);
      await micro();
      expect($x()).toBe(111);
    });
  });

  describe("yield* with helper generators", () => {
    gap(
      "action-sync-yield",
      "every yield resumes in a microtask, a value that is not a Promise too",
      "should support yield* with sync helper generator",
      () => {
        const steps: string[] = [];
        function* helper(): Generator<undefined, void, unknown> {
          steps.push("helper-1");
          yield;
          steps.push("helper-2");
          yield;
          steps.push("helper-3");
        }
        const myAction = action(function* () {
          steps.push("start");
          yield* helper();
          steps.push("end");
        });
        void myAction();
        expect(steps).toEqual(["start", "helper-1", "helper-2", "helper-3", "end"]);
      },
    );

    test("should support yield* with async helper generator", async () => {
      const [$x, setX] = signal(0);
      const steps: string[] = [];
      function* helper(): Generator<Promise<void>, void, unknown> {
        steps.push("helper-start");
        setX(1);
        yield Promise.resolve();
        steps.push("helper-middle");
        setX(2);
        yield Promise.resolve();
        steps.push("helper-end");
      }
      const myAction = action(function* () {
        steps.push("action-start");
        yield* helper();
        steps.push("action-end");
        setX(3);
      });
      void myAction();
      flush();
      expect(steps).toEqual(["action-start", "helper-start"]);
      expect($x()).toBe(0);
      await micro();
      flush();
      expect(steps).toEqual(["action-start", "helper-start", "helper-middle"]);
      expect($x()).toBe(0);
      await micro();
      expect(steps).toEqual(["action-start", "helper-start", "helper-middle", "helper-end", "action-end"]);
      expect($x()).toBe(3);
    });

    test("should support nested yield* (helper uses yield* on another helper)", async () => {
      const steps: string[] = [];
      function* innerHelper(): Generator<Promise<void>, void, unknown> {
        steps.push("inner-1");
        yield Promise.resolve();
        steps.push("inner-2");
      }
      function* outerHelper(): Generator<Promise<void>, void, unknown> {
        steps.push("outer-start");
        yield* innerHelper();
        steps.push("outer-end");
      }
      const myAction = action(function* () {
        steps.push("action-start");
        yield* outerHelper();
        steps.push("action-end");
      });
      void myAction();
      expect(steps).toEqual(["action-start", "outer-start", "inner-1"]);
      await micro();
      expect(steps).toEqual(["action-start", "outer-start", "inner-1", "inner-2", "outer-end", "action-end"]);
    });

    test("should maintain transition context across all delegated yields", async () => {
      const [$x, setX] = signal(0);
      const effectRuns = mock((_v: number) => {});
      watch(
        () => $x(),
        (v) => effectRuns(v),
      );
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      expect(effectRuns).toHaveBeenLastCalledWith(0);
      function* helper(): Generator<Promise<void>, void, unknown> {
        setX(1);
        yield Promise.resolve();
        setX(2);
        yield Promise.resolve();
      }
      const myAction = action(function* () {
        yield* helper();
        setX(3);
      });
      void myAction();
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      await micro();
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      await micro();
      expect(effectRuns).toHaveBeenCalledTimes(2);
      expect(effectRuns).toHaveBeenLastCalledWith(3);
      expect($x()).toBe(3);
    });

    test("should support multiple yield* in sequence", async () => {
      const steps: string[] = [];
      function* helperA(): Generator<Promise<void>, void, unknown> {
        steps.push("A-1");
        yield Promise.resolve();
        steps.push("A-2");
      }
      function* helperB(): Generator<Promise<void>, void, unknown> {
        steps.push("B-1");
        yield Promise.resolve();
        steps.push("B-2");
      }
      const myAction = action(function* () {
        yield* helperA();
        yield* helperB();
      });
      void myAction();
      expect(steps).toEqual(["A-1"]);
      await micro();
      expect(steps).toEqual(["A-1", "A-2", "B-1"]);
      await micro();
      expect(steps).toEqual(["A-1", "A-2", "B-1", "B-2"]);
    });

    test("should pass values through yield* correctly", async () => {
      const received: unknown[] = [];
      function* helper(): Generator<Promise<number>, string, number> {
        const a = yield Promise.resolve(1);
        received.push(a);
        const b = yield Promise.resolve(2);
        received.push(b);
        return "helper-result";
      }
      const myAction = action(function* () {
        const result: string = yield* helper();
        received.push(result);
        return "action-result";
      });
      const promise = myAction();
      await micro();
      await micro();
      expect(received).toEqual([1, 2, "helper-result"]);
      expect(await promise).toBe("action-result");
    });
  });

  describe("error handling", () => {
    test("should allow try/catch inside generator for yielded promise rejections", async () => {
      const steps: string[] = [];
      const myAction = action(function* () {
        steps.push("start");
        try {
          yield Promise.reject(new Error("test error"));
          steps.push("unreachable");
        } catch (e) {
          steps.push("caught: " + (e as Error).message);
        }
        steps.push("end");
      });
      await myAction();
      expect(steps).toEqual(["start", "caught: test error", "end"]);
    });

    test("should reject the promise for uncaught errors", async () => {
      const myAction = action(function* () {
        yield Promise.reject(new Error("uncaught error"));
      });
      await expect(myAction()).rejects.toThrow("uncaught error");
    });

    test("should reject the promise when generator throws synchronously", async () => {
      const myAction = action(function* () {
        throw new Error("sync error");
      });
      await expect(myAction()).rejects.toThrow("sync error");
    });

    test("should reject the promise when generator throws a falsy value", async () => {
      const myAction = action(function* () {
        throw undefined;
      });
      await expect(myAction()).rejects.toBeUndefined();
    });

    test("should reject the promise when generator throws after yield", async () => {
      const myAction = action(function* () {
        yield Promise.resolve();
        throw new Error("error after yield");
      });
      await expect(myAction()).rejects.toThrow("error after yield");
    });

    test("should reject the promise when an async generator throws immediately", async () => {
      const myAction = action(async function* () {
        throw new Error("boom");
      });
      await expect(myAction()).rejects.toThrow("boom");
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    test("should reject the promise when an async generator throws after an await", async () => {
      const myAction = action(async function* () {
        await Promise.resolve();
        yield undefined;
        throw new Error("async error after yield");
      });
      await expect(myAction()).rejects.toThrow("async error after yield");
    });

    test("should allow try/catch inside async generator for awaited rejections", async () => {
      const steps: string[] = [];
      const myAction = action(async function* () {
        steps.push("start");
        try {
          yield Promise.reject(new Error("test error"));
          steps.push("unreachable");
        } catch (e) {
          steps.push("caught: " + (e as Error).message);
        }
        steps.push("end");
      });
      await myAction();
      expect(steps).toEqual(["start", "caught: test error", "end"]);
    });

    test("should complete the transition when an async generator throws", async () => {
      const [$x, setX] = signal(0);
      const errorAction = action(async function* () {
        setX(1);
        yield undefined;
        throw new Error("async boom");
      });
      const successAction = action(function* () {
        setX((v) => v + 10);
        yield Promise.resolve();
        yield Promise.resolve();
        setX((v) => v + 100);
      });
      const errorPromise = errorAction();
      // Handled, should an assertion fail before the one that awaits it.
      errorPromise.catch(() => {});
      void successAction();
      flush();
      expect($x()).toBe(0);
      await expect(errorPromise).rejects.toThrow("async boom");
      await new Promise<void>((r) => setTimeout(r, 0));
      expect($x()).toBe(111);
    });

    test("should remove action from transition on error but let transition continue", async () => {
      const [$x, setX] = signal(0);
      const errorAction = action(function* () {
        setX(1);
        yield Promise.reject(new Error("error"));
      });
      const successAction = action(function* () {
        setX((v) => v + 10);
        yield Promise.resolve();
        yield Promise.resolve();
        setX((v) => v + 100);
      });
      const errorPromise = errorAction();
      // Handled, should an assertion fail before the one that awaits it.
      errorPromise.catch(() => {});
      void successAction();
      flush();
      expect($x()).toBe(0);
      await micro();
      await expect(errorPromise).rejects.toThrow("error");
      await micro();
      expect($x()).toBe(111);
    });

    test("should allow recovery and continuation after caught error", async () => {
      const [$x, setX] = signal(0);
      const myAction = action(function* () {
        setX(1);
        try {
          yield Promise.reject(new Error("recoverable"));
        } catch {
          setX(2);
        }
        yield Promise.resolve();
        setX(3);
      });
      await myAction();
      expect($x()).toBe(3);
    });

    test("should handle errors in yield* delegated generators", async () => {
      const steps: string[] = [];
      function* helper(): Generator<Promise<void>, void, void> {
        steps.push("helper-start");
        yield Promise.reject(new Error("helper error"));
        steps.push("helper-unreachable");
      }
      const myAction = action(function* () {
        steps.push("action-start");
        try {
          yield* helper();
        } catch (e) {
          steps.push("caught: " + (e as Error).message);
        }
        steps.push("action-end");
      });
      await myAction();
      expect(steps).toEqual(["action-start", "helper-start", "caught: helper error", "action-end"]);
    });
  });

  describe("promise return", () => {
    test("should resolve with the generator return value", async () => {
      const myAction = action(function* () {
        yield Promise.resolve();
        return 42;
      });
      expect(await myAction()).toBe(42);
    });

    test("should support await for waiting on action completion", async () => {
      const [$x, setX] = signal(0);
      const myAction = action(function* () {
        setX(1);
        yield Promise.resolve();
        setX(2);
        return "done";
      });
      const result = await myAction();
      expect(result).toBe("done");
      expect($x()).toBe(2);
    });

    test("should support Promise.all for parallel actions", async () => {
      const [$x, setX] = signal(0);
      const steps: string[] = [];
      const actionA = action(function* () {
        steps.push("A-start");
        setX((v) => v + 1);
        yield Promise.resolve();
        steps.push("A-end");
        return "A";
      });
      const actionB = action(function* () {
        steps.push("B-start");
        setX((v) => v + 10);
        yield Promise.resolve();
        steps.push("B-end");
        return "B";
      });
      const results = await Promise.all([actionA(), actionB()]);
      expect(results).toEqual(["A", "B"]);
      expect(steps).toContain("A-start");
      expect(steps).toContain("B-start");
      expect(steps).toContain("A-end");
      expect(steps).toContain("B-end");
      expect($x()).toBe(11);
    });

    test("should support yielding another action's promise", async () => {
      const [$x, setX] = signal(0);
      const steps: string[] = [];
      const innerAction = action(function* () {
        steps.push("inner-start");
        setX((v) => v + 10);
        yield Promise.resolve();
        steps.push("inner-end");
        return "inner-result";
      });
      const outerAction = action(function* () {
        steps.push("outer-start");
        setX(1);
        const innerResult: unknown = yield innerAction();
        steps.push("got: " + String(innerResult));
        setX((v) => v + 100);
        steps.push("outer-end");
        return "outer-result";
      });
      // Should the Promise never settle (both waiting for the one transition), a timer ends the wait.
      const result = await Promise.race([
        outerAction(),
        tick(50).then(() => {
          throw new Error("the outer action never settled");
        }),
      ]);
      expect(result).toBe("outer-result");
      expect(steps).toEqual(["outer-start", "inner-start", "inner-end", "got: inner-result", "outer-end"]);
      expect($x()).toBe(111);
    });

    test("should resolve immediately for sync actions", async () => {
      const myAction = action(function* () {
        return "immediate";
      });
      let resolved = false;
      void myAction().then(() => {
        resolved = true;
      });
      await micro();
      expect(resolved).toBe(true);
    });
  });
});

describe("signals/tests/createOptimistic.test.ts", () => {
  describe("basic behavior", () => {
    test("should store and return value on read", () => {
      const [$x] = createOptimistic(1);
      expect($x).toBeInstanceOf(Function);
      expect($x()).toBe(1);
    });

    gap(
      "optimistic-outside",
      "an optimistic write outside an action sets the base value: it shows, and stays",
      "a setter write in a frame that does not park never shows",
      () => {
        const [$x, setX] = createOptimistic(1);
        const values: number[] = [];
        watch($x, (v) => values.push(v));
        flush();
        setX(2);
        flush();
        expect(values).toEqual([1]);
        expect($x()).toBe(1);
      },
    );

    gap(
      "optimistic-outside",
      "an optimistic write outside an action sets the base value: it shows, and stays",
      "should provide current optimistic value in update callback",
      () => {
        const [$x, setX] = createOptimistic(10);
        const values: number[] = [];
        watch($x, (v) => values.push(v));
        flush();
        setX((prev) => {
          expect(prev).toBe(10);
          return 20;
        });
        setX((prev) => {
          expect(prev).toBe(20);
          return prev + 5;
        });
        flush();
        expect(values).toEqual([10]);
        expect($x()).toBe(10);
      },
    );
  });

  describe("async transitions", () => {
    test("should show optimistic value during async transition and revert when complete", async () => {
      const [$count, setCount] = createOptimistic(0);
      const values: number[] = [];
      watch(
        () => $count(),
        (v) => values.push(v),
      );
      flush();
      expect(values).toEqual([0]);
      const doAsync = action(function* () {
        setCount(1);
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect($count()).toBe(1);
      expect(values).toEqual([0, 1]);
      await micro();
      expect($count()).toBe(0);
      expect(values).toEqual([0, 1, 0]);
    });

    test("should show each optimistic update during transition", async () => {
      const [$count, setCount] = createOptimistic(0);
      const values: number[] = [];
      watch(
        () => $count(),
        (v) => values.push(v),
      );
      flush();
      const doAsync = action(function* () {
        setCount(1);
        yield Promise.resolve();
        setCount(2);
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect($count()).toBe(1);
      await micro();
      expect($count()).toBe(2);
      await micro();
      expect($count()).toBe(0);
      expect(values).toEqual([0, 1, 2, 0]);
    });

    test("should not trigger effect if optimistic value matches original", async () => {
      const [$count, setCount] = createOptimistic(5);
      const effectRuns = mock((_v: number) => {});
      watch(
        () => $count(),
        (v) => effectRuns(v),
      );
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      expect(effectRuns).toHaveBeenLastCalledWith(5);
      const doAsync = action(function* () {
        setCount(5);
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      await micro();
      expect(effectRuns).toHaveBeenCalledTimes(1);
    });

    test("should hold regular signal value during transition while showing optimistic", async () => {
      const [$regular, setRegular] = signal(10);
      const [$optimistic, setOptimistic] = createOptimistic(1);
      const values: { r: number; o: number }[] = [];
      createRoot(() =>
        reaction(
          () => ({ r: $regular(), o: $optimistic() }),
          (v) => void values.push(v),
        ),
      );
      flush();
      expect(values).toEqual([{ r: 10, o: 1 }]);
      const doAsync = action(function* () {
        setOptimistic(100);
        setRegular(20);
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(values).toEqual([
        { r: 10, o: 1 },
        { r: 10, o: 100 },
      ]);
      await micro();
      expect($regular()).toBe(20);
      expect($optimistic()).toBe(1);
      expect(values).toEqual([
        { r: 10, o: 1 },
        { r: 10, o: 100 },
        { r: 20, o: 1 },
      ]);
    });

    test("should revert multiple optimistic signals together when transition completes", async () => {
      const [$a, setA] = createOptimistic(1);
      const [$b, setB] = createOptimistic(10);
      const values: { a: number; b: number }[] = [];
      createRoot(() =>
        reaction(
          () => ({ a: $a(), b: $b() }),
          (v) => void values.push(v),
        ),
      );
      flush();
      expect(values).toEqual([{ a: 1, b: 10 }]);
      const doAsync = action(function* () {
        setA(2);
        setB(20);
        yield Promise.resolve();
        setA(3);
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(values).toEqual([
        { a: 1, b: 10 },
        { a: 2, b: 20 },
      ]);
      await micro();
      expect(values).toEqual([
        { a: 1, b: 10 },
        { a: 2, b: 20 },
        { a: 3, b: 20 },
      ]);
      await micro();
      expect($a()).toBe(1);
      expect($b()).toBe(10);
      expect(values).toEqual([
        { a: 1, b: 10 },
        { a: 2, b: 20 },
        { a: 3, b: 20 },
        { a: 1, b: 10 },
      ]);
    });
  });

  describe("computed optimistic", () => {
    gap(
      "optimistic-outside",
      "an optimistic write outside an action sets the value until its function runs again",
      "should derive from source; an optimistic write with no frame to hold it never shows",
      () => {
        const [$x, setX] = signal(1);
        const [$y, setY] = createOptimistic(() => $x() + 1);
        const values: number[] = [];
        watch($y, (v) => values.push(v));
        flush();
        expect($y()).toBe(2);
        setY(100);
        flush();
        expect(values).toEqual([2]);
        expect($y()).toBe(2);
        setX(5);
        flush();
        expect($y()).toBe(6);
      },
    );

    test("should allow optimistic override during transition with held source", async () => {
      const [$x, setX] = signal(1);
      const [$y, setY] = createOptimistic(() => $x() * 2);
      const values: number[] = [];
      watch(
        () => $y(),
        (v) => values.push(v),
      );
      flush();
      expect(values).toEqual([2]);
      const doAsync = action(function* () {
        setY(100);
        yield Promise.resolve();
        setX(10);
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect($y()).toBe(100);
      await micro();
      expect($y()).toBe(100);
      expect($x()).toBe(1);
      await micro();
      expect($y()).toBe(20);
      expect($x()).toBe(10);
    });
  });
});

describe("signals/tests/store/createOptimisticStore.test.ts", () => {
  describe("async transitions", () => {
    test("should show optimistic value during async transition and revert when complete", async () => {
      const [state, setState] = createOptimisticStore({ count: 0 });
      const values: number[] = [];
      watch(
        () => state.count,
        (v) => values.push(v),
      );
      flush();
      expect(values).toEqual([0]);
      const doAsync = action(function* () {
        setState((s) => {
          s.count = 1;
        });
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(state.count).toBe(1);
      expect(values).toEqual([0, 1]);
      await micro();
      expect(state.count).toBe(0);
      expect(values).toEqual([0, 1, 0]);
    });

    test("should show each optimistic update during transition", async () => {
      const [state, setState] = createOptimisticStore({ count: 0 });
      const values: number[] = [];
      watch(
        () => state.count,
        (v) => values.push(v),
      );
      flush();
      const doAsync = action(function* () {
        setState((s) => {
          s.count = 1;
        });
        yield Promise.resolve();
        setState((s) => {
          s.count = 2;
        });
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(state.count).toBe(1);
      await micro();
      expect(state.count).toBe(2);
      await micro();
      expect(state.count).toBe(0);
      expect(values).toEqual([0, 1, 2, 0]);
    });

    test("should not trigger effect if optimistic value matches original", async () => {
      const [state, setState] = createOptimisticStore({ value: 5 });
      const effectRuns = mock((_v: number) => {});
      watch(
        () => state.value,
        (v) => effectRuns(v),
      );
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      expect(effectRuns).toHaveBeenLastCalledWith(5);
      const doAsync = action(function* () {
        setState((s) => {
          s.value = 5;
        });
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(effectRuns).toHaveBeenCalledTimes(1);
      await micro();
      expect(effectRuns).toHaveBeenCalledTimes(1);
    });

    gap(
      "action-writes",
      "a store write in an action changes the store at once: an effect run for another change reads it",
      "should hold regular store value during transition while showing optimistic",
      async () => {
        const [regular, setRegular] = createStore({ value: 10 });
        const [optimistic, setOptimistic] = createOptimisticStore({ value: 1 });
        const values: { r: number; o: number }[] = [];
        createRoot(() =>
          reaction(
            () => ({ r: regular.value, o: optimistic.value }),
            (v) => void values.push(v),
          ),
        );
        flush();
        expect(values).toEqual([{ r: 10, o: 1 }]);
        const doAsync = action(function* () {
          setOptimistic((s) => {
            s.value = 100;
          });
          setRegular((s) => {
            s.value = 20;
          });
          yield Promise.resolve();
        });
        void doAsync();
        flush();
        expect(values).toEqual([
          { r: 10, o: 1 },
          { r: 10, o: 100 },
        ]);
        await micro();
        expect(regular.value).toBe(20);
        expect(optimistic.value).toBe(1);
        expect(values).toEqual([
          { r: 10, o: 1 },
          { r: 10, o: 100 },
          { r: 20, o: 1 },
        ]);
      },
    );

    test("should revert nested object changes when transition completes", async () => {
      const [state, setState] = createOptimisticStore({ user: { name: "John", settings: { theme: "light" } } });
      const doAsync = action(function* () {
        setState((s) => {
          s.user.name = "Jake";
          s.user.settings.theme = "dark";
        });
        yield Promise.resolve();
      });
      void doAsync();
      flush();
      expect(state.user.name).toBe("Jake");
      expect(state.user.settings.theme).toBe("dark");
      await micro();
      expect(state.user.name).toBe("John");
      expect(state.user.settings.theme).toBe("light");
    });
  });

  describe("derived optimistic stores (projections)", () => {
    gap(
      "optimistic-outside",
      "an optimistic store's write outside an action sets its base, until its function runs again",
      "should handle async projection and revert optimistic writes",
      async () => {
        const [$x] = signal(1);
        // An async fn that writes its draft and returns nothing, as Solid's: reactre's types
        // take an async fn that returns the value, so it is cast to that.
        const [state, setState] = createOptimisticStore(
          (async (s: { value: number }) => {
            const v = $x();
            await Promise.resolve();
            s.value = v * 2;
          }) as unknown as (s: { value: number }) => Promise<{ value: number }>,
          { value: 0 },
        );
        const values: number[] = [];
        watch(
          () => state.value,
          (v) => values.push(v),
        );
        flush();
        await micro();
        await micro();
        expect(state.value).toBe(2);
        expect(values).toEqual([2]);
        setState((s) => {
          s.value = 8;
        });
        flush();
        expect(values).toEqual([2]);
        await micro();
        await micro();
        await micro();
        await micro();
        expect(state.value).toBe(2);
      },
    );
  });
});

describe("web/test/loading.spec.tsx", () => {
  describe("<Loading> around an optimistic store's first flight", () => {
    const FETCH_MS = 5;
    const modules: Record<string, unknown> = {
      ...base,
      "@reactre/core/features/actions": actionsApi,
      "@reactre/core/features/async": asyncApi,
      "@reactre/core/features/context": context,
    };

    /** The poll app, its list made by `make` (createOptimisticStore or createStore) from an async fn. */
    function mount(make: "createOptimisticStore" | "createStore"): {
      html: () => string;
      refetch: () => void;
      dispose: () => void;
    } {
      const root = new FakeElement("DIV");
      const from = make === "createStore" ? "@reactre/core/features/store" : "@reactre/core/features/actions";
      const api = compile<{ setTick: (v: number) => void; dispose: () => void }>(
        `
        import { attach, For, signal } from "@reactre/core";
        import { Loading } from "@reactre/core/features/async";
        import { ${make} } from "${from}";
        const [tick, setTick] = signal(0);
        let fetches = 0;
        const [list] = ${make}(async () => {
          tick();
          const n = ++fetches;
          await new Promise((r) => setTimeout(r, ${FETCH_MS}));
          return [{ id: 1, label: "Tacos", votes: n - 1 }];
        }, []);
        const dispose = attach(
          () => (
            <>
              <h1>Poll</h1>
              <Loading fallback={<div>Loading...</div>}>
                <ul>
                  <For each={list} key={(item) => item.id}>
                    {(item) => <li>{item.label} - {item.votes}</li>}
                  </For>
                </ul>
              </Loading>
            </>
          ),
          root,
        );
        return { setTick, dispose };
      `,
        modules,
        { root },
      );
      flush();
      return { html: () => html(root), refetch: () => api.setTick(1), dispose: api.dispose };
    }

    test("createOptimisticStore(fn, seed) in the component body: fallback at mount, list after landing, content kept on refetch", async () => {
      const { html: page, dispose, refetch } = mount("createOptimisticStore");
      expect(page()).toBe("<h1>Poll</h1><div>Loading...</div>");
      await tick(FETCH_MS + 3);
      flush();
      expect(page()).toBe("<h1>Poll</h1><ul><li>Tacos - 0</li></ul>");
      refetch();
      flush();
      expect(page()).toBe("<h1>Poll</h1><ul><li>Tacos - 0</li></ul>");
      await tick(FETCH_MS + 3);
      flush();
      expect(page()).toBe("<h1>Poll</h1><ul><li>Tacos - 1</li></ul>");
      dispose();
    });

    gap(
      "async-store",
      "createStore takes no async function: use an async memo or createOptimisticStore",
      "control: createStore(fn, seed) in the same spot",
      async () => {
        const { html: page, dispose } = mount("createStore");
        try {
          expect(page()).toBe("<h1>Poll</h1><div>Loading...</div>");
          await tick(FETCH_MS + 3);
          flush();
          expect(page()).toBe("<h1>Poll</h1><ul><li>Tacos - 0</li></ul>");
        } finally {
          dispose();
        }
      },
    );
  });
});

/** The markup of `n`'s children, elements and text, as innerHTML writes it. */
function html(n: FakeElement): string {
  let out = "";
  for (const c of n.childNodes) {
    if (c instanceof FakeElement) {
      const tag = c.tagName.toLowerCase();
      out += `<${tag}>${html(c)}</${tag}>`;
    } else if (c.nodeType === 3) out += c.textContent ?? "";
  }
  return out;
}

describe("held writes", () => {
  gap(
    "held-writes",
    "Solid holds an optimistic write until flush; reactre applies it at once",
    "a setter write is not visible before the flush (createOptimistic basic behavior)",
    () => {
      const [$x, setX] = createOptimistic(1);
      const done = action(function* () {
        setX(2);
        yield new Promise(() => {});
      });
      void done();
      expect($x()).toBe(1);
    },
  );
});
