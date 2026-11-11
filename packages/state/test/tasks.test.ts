// The tasks runner: timers with absolute deadlines that survive a restore, and a task's event that
// its schema refuses. On compiled tables written by hand, with a fake clock.

import { afterEach, describe, expect, test } from "bun:test";

import type { __Compiled, __Event, Shape } from "@reactre/state";
import { createActor, restoreActor } from "@reactre/state";
import { __saved, persist as persistTyped, type Persisted } from "@reactre/state/persist";
import { __run } from "@reactre/state/run";
import { __lean, __leanQuick, __tasks, __tasksQuick } from "@reactre/state/tasks";
import { SimulatedClock } from "@reactre/state/utils/SimulatedClock";
import { __validate, __validated } from "@reactre/state/validate";

import { __wait } from "../src/wait.ts";
import { object, string } from "./fixtures/standard-schema.ts";
import { to } from "./to.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<__Event>(() => {});

let clock = 1000;
const now = () => clock;

// A cast: these tables are written by hand, without a shape that has persist in its `use`.
const persist = persistTyped as unknown as (actor: unknown) => Persisted<Shape>;

/** What the task does, swapped by each test. */
let work: (signal: AbortSignal) => Promise<__Event> = never;
let signals: AbortSignal[] = [];

const n = (data: unknown): number => Number(Reflect.get(Object(data), "n"));

// waiting: a task, a timer that stays (n + 10) at 20ms, and one that leaves at 60ms.
const job: __Compiled = {
  v: 0,
  e: { go: 1, cancel: 1, poke: 1 },
  i: () => to("idle"),
  o: {
    idle: { go: () => to("waiting", { n: 0 }) },
    waiting: {
      cancel: () => to("idle"),
      poke: (data) => to("waiting", { n: n(data) + 1 }),
      done: (_, event) => to("finished", { id: Reflect.get(event, "id") }),
    },
    timedOut: {},
    failed: {},
  },
  f: { finished: 1, timedOut: 1, failed: 1 },
  t: {
    waiting: [
      (_, signal) => {
        signals.push(signal);
        return work(signal);
      },
      (_, error) => to("failed", { error: String(error) }),
    ],
  },
  a: {
    waiting: [
      [20, (data) => to("waiting", { n: n(data) + 10 })],
      [60, () => to("timedOut")],
    ],
  },
  // As the compiler writes `use: [persist]`: the marker, and the runner that saves deadlines.
  u: { persist: 1 },
  r: __run([__saved]),
};

// The same machine without persist, as the compiler writes a flat machine with tasks: the lean
// lifecycle, which saves nothing.
const { u: _persist, ...plain } = job;
const lean: __Compiled = { ...plain, r: __lean };

// The same machine on the general lifecycle with the tasks runner, as the compiler writes it for a
// machine with a hierarchy or children: `r: __run([__tasks, ...])`.
const general: __Compiled = { ...plain, r: __run([__tasks]) };

afterEach(() => {
  clock = 1000;
  work = never;
  signals = [];
});

describe("timers that survive a restore", () => {
  test("persist saves each pending timer's absolute deadline", () => {
    const actor = createActor(job, { now });
    actor.send({ type: "go" });
    clock = 1015;
    expect(persist(actor)).toEqual({
      state: "waiting",
      data: { n: 0 },
      version: 0,
      run: { waiting: { t: [1020, 1060] } },
    });
    actor.stop();
  });

  test("a restored actor waits only the remaining time, and an overdue timer fires at once", async () => {
    const actor = createActor(job, { now });
    actor.send({ type: "go" });
    const saved: Persisted<Shape> = JSON.parse(JSON.stringify(persist(actor)));
    actor.stop();

    // 50ms later on the clock: the 20ms timer is overdue, the 60ms one has 10ms left.
    clock = 1050;
    const restored = restoreActor(job, saved, { now });
    await tick();
    expect(restored.snapshot()).toEqual({ state: "waiting", data: { n: 10 }, version: 0 });
    await wait(30);
    expect(restored.snapshot().state).toBe("timedOut");
  });

  test("a timer that fired while its node stayed doesn't fire again after a restore", async () => {
    const actor = createActor(job, { now });
    actor.send({ type: "go" });
    await wait(30);
    expect(actor.snapshot().data).toEqual({ n: 10 });
    const saved = persist(actor);
    expect(saved.run).toEqual({ waiting: { t: [null, 1060] } });
    actor.stop();

    const restored = restoreActor(job, saved, { now });
    await tick();
    expect(restored.snapshot().data).toEqual({ n: 10 });
    restored.stop();
  });

  test("a stay keeps the timers and their deadlines", () => {
    const actor = createActor(job, { now });
    actor.send({ type: "go" });
    clock = 1010;
    actor.send({ type: "poke" });
    expect(persist(actor).run).toEqual({ waiting: { t: [1020, 1060] } });
    actor.stop();
  });

  test("a plain snapshot starts the timers fresh", () => {
    clock = 5000;
    const actor = restoreActor(job, { state: "waiting", data: { n: 0 }, version: 0 }, { now });
    expect(persist(actor).run).toEqual({ waiting: { t: [5020, 5060] } });
    actor.stop();
  });

  test("leaving the node cancels its timers and aborts its task, restored or not", async () => {
    const actor = createActor(job, { now });
    actor.send({ type: "go" });
    const saved = persist(actor);
    actor.send({ type: "cancel" });
    expect(signals[0]?.aborted).toBe(true);

    const restored = restoreActor(job, saved, { now });
    restored.send({ type: "cancel" });
    expect(signals[1]?.aborted).toBe(true);
    await wait(80);
    expect(actor.snapshot().state).toBe("idle");
    expect(restored.snapshot().state).toBe("idle");
  });
});

describe("task results", () => {
  test("a task's event moves the machine", async () => {
    work = async () => ({ type: "done", id: "a" });
    const actor = createActor(job, { now });
    actor.send({ type: "go" });
    await tick();
    expect(actor.snapshot()).toEqual({ state: "finished", data: { id: "a" }, version: 0 });
  });

  test("an event its schema refuses goes to the task's error, as S6 with the issues and the fix", async () => {
    // As the compiler writes a machine whose internal `done` has a schema: `id` must be a string.
    work = async () => ({ type: "done", id: 42 });
    const validated: __Compiled = {
      ...job,
      s: { e: { done: object({ id: string() }) } },
      x: __validate,
      y: __validated(),
    };
    const actor = createActor(validated, { now });
    actor.send({ type: "go" });
    await tick();
    const { state, data } = actor.snapshot();
    expect(state).toBe("failed");
    expect(String(Reflect.get(data, "error"))).toBe(
      `Error: [@reactre/state S6] a task in state "waiting" resolved to an invalid "done" event (event.id: expected a string). Resolve to what setup's internal "done" declares.`,
    );
  });
});

describe("the lean lifecycle (a flat machine without persist)", () => {
  test("a task's event moves the machine, and a timer that stays keeps the other running", async () => {
    work = async () => ({ type: "done", id: "b" });
    const actor = createActor(lean);
    actor.send({ type: "go" });
    await tick();
    expect(actor.snapshot()).toEqual({ state: "finished", data: { id: "b" }, version: 0 });

    work = never;
    const other = createActor(lean);
    other.send({ type: "go" });
    await wait(30);
    expect(other.snapshot()).toEqual({ state: "waiting", data: { n: 10 }, version: 0 });
    await wait(50);
    expect(other.snapshot().state).toBe("timedOut");
  });

  test("leaving aborts the task, a late result is dropped, and a stay keeps the task", async () => {
    let finish!: (e: __Event) => void;
    work = () => new Promise((r) => (finish = r));
    const actor = createActor(lean);
    actor.send({ type: "go" });
    actor.send({ type: "poke" });
    expect(signals.length).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
    actor.send({ type: "cancel" });
    expect(signals[0]?.aborted).toBe(true);
    const late = { type: "done", id: "late" };
    finish(late);
    await tick();
    expect(actor.snapshot().state).toBe("idle");
  });

  test("stop aborts the task, and saves nothing: persist needs its opt-in", () => {
    const actor = createActor(lean);
    actor.send({ type: "go" });
    expect(() => persist(actor)).toThrow(/S11\]/);
    actor.stop();
    expect(signals[0]?.aborted).toBe(true);
  });

  test("an actor created stopped-at-start runs no work, and a later stop is safe", () => {
    // A machine that starts in a final state: the lifecycle enters it inactive.
    const done: __Compiled = { ...lean, i: () => to("finished", { id: "x" }) };
    const actor = createActor(done);
    expect(actor.status()).toBe("done");
    expect(signals).toEqual([]);
    actor.stop();
  });
});

describe("the quick lifecycles (every ordinary delay a short literal)", () => {
  // What the compiler emits for `job` from source: its `a` delays are 20 and 60 ms, both within
  // setTimeout's range, so the lifecycle skips `__wait`'s split. The behavior must be the plain
  // lifecycle's: a timer fires at its delay, leaving cancels it, and a late result is dropped.
  const leanQuick: __Compiled = { ...plain, r: __leanQuick };
  const generalQuick: __Compiled = { ...plain, r: __run([__tasksQuick]) };

  test.each([
    ["lean", leanQuick],
    ["general", generalQuick],
  ] as const)("%s: a timer fires at its delay, and the staying one keeps the node", async (_, m) => {
    const actor = createActor(m);
    actor.send({ type: "go" });
    await wait(30);
    expect(actor.snapshot()).toEqual({ state: "waiting", data: { n: 10 }, version: 0 });
    await wait(50);
    expect(actor.snapshot().state).toBe("timedOut");
  });

  test.each([
    ["lean", leanQuick],
    ["general", generalQuick],
  ] as const)("%s: leaving the node cancels its timers", async (_, m) => {
    const actor = createActor(m);
    actor.send({ type: "go" });
    actor.send({ type: "cancel" });
    await wait(30);
    expect(actor.snapshot().state).toBe("idle");
    await wait(50);
    expect(actor.snapshot().state).toBe("idle");
  });

  test.each([
    ["lean", leanQuick],
    ["general", generalQuick],
  ] as const)("%s: a task's result after leaving the node is dropped", async (_, m) => {
    let finish!: (e: __Event) => void;
    work = () => new Promise((r) => (finish = r));
    const actor = createActor(m);
    actor.send({ type: "go" });
    actor.send({ type: "cancel" });
    expect(signals[0]?.aborted).toBe(true);
    finish({ type: "done", id: "late" } as __Event);
    await tick();
    expect(actor.snapshot().state).toBe("idle");
  });

  test("stop cancels the quick timers", async () => {
    const actor = createActor(leanQuick);
    actor.send({ type: "go" });
    actor.stop();
    await wait(30);
    expect(actor.snapshot()).toEqual({ state: "waiting", data: { n: 0 }, version: 0 });
  });
});

describe("the tasks runner of the general lifecycle", () => {
  test("a task that fails goes to its error handler, after a stay that kept it running", async () => {
    work = async () => {
      throw new Error("offline");
    };
    const actor = createActor(general);
    actor.send({ type: "go" });
    actor.send({ type: "poke" });
    expect(signals.length).toBe(1);
    await tick();
    expect(actor.snapshot()).toEqual({ state: "failed", data: { error: "Error: offline" }, version: 0 });
  });

  test("an event its schema refuses goes to the task's error, as S6", async () => {
    work = async () => ({ type: "done", id: 42 });
    const validated: __Compiled = {
      ...general,
      s: { e: { done: object({ id: string() }) } },
      x: __validate,
      y: __validated(),
    };
    const actor = createActor(validated);
    actor.send({ type: "go" });
    await tick();
    expect(actor.snapshot().state).toBe("failed");
    expect(String(Reflect.get(actor.snapshot().data, "error"))).toMatch(/S6\] a task in state "waiting" resolved/);
  });

  test("a failure or a result after the node exited is dropped", async () => {
    let reject!: (error: unknown) => void;
    work = () => new Promise((_, r) => (reject = r));
    const failing = createActor(general);
    failing.send({ type: "go" });
    failing.send({ type: "cancel" });
    reject(new Error("late"));

    let resolve!: (event: __Event) => void;
    work = () => new Promise((r) => (resolve = r));
    const resolving = createActor(general);
    resolving.send({ type: "go" });
    resolving.send({ type: "cancel" });
    const late = { type: "done", id: "late" };
    resolve(late);

    await tick();
    expect(failing.snapshot().state).toBe("idle");
    expect(resolving.snapshot().state).toBe("idle");
  });
});

describe("a delay that isn't a finite number", () => {
  // setTimeout(NaN) is 0: an immediate fire, an accidental retry. `__wait` never fires it, and
  // neither does a runner that goes through it. Infinity would re-arm every 24.8 days forever.
  const odd = (ms: number): __Compiled => ({
    v: 0,
    e: { go: 1 },
    i: () => to("idle"),
    o: { idle: { go: () => to("waiting") }, waiting: {} },
    f: { late: 1 },
    a: { waiting: [[ms, () => to("late")]] },
  });

  test.each([
    ["lean", (m: __Compiled): __Compiled => ({ ...m, r: __lean })],
    ["general", (m: __Compiled): __Compiled => ({ ...m, r: __run([__tasks]) })],
    ["persist", (m: __Compiled): __Compiled => ({ ...m, u: { persist: 1 }, r: __run([__saved]) })],
  ] as const)("%s: a NaN delay doesn't fire at once", async (_, lifecycle) => {
    const actor = createActor(lifecycle(odd(Number.NaN)));
    actor.send({ type: "go" });
    await wait(10);
    expect(actor.snapshot().state).toBe("waiting");
    actor.stop();
  });

  test.each([
    ["lean", (m: __Compiled): __Compiled => ({ ...m, r: __lean })],
    ["general", (m: __Compiled): __Compiled => ({ ...m, r: __run([__tasks]) })],
    ["persist", (m: __Compiled): __Compiled => ({ ...m, u: { persist: 1 }, r: __run([__saved]) })],
  ] as const)("%s: an Infinity delay doesn't fire at once", async (_, lifecycle) => {
    const actor = createActor(lifecycle(odd(Number.POSITIVE_INFINITY)));
    actor.send({ type: "go" });
    await wait(10);
    expect(actor.snapshot().state).toBe("waiting");
    actor.stop();
  });
});

describe("__wait itself", () => {
  // The runners above go through it; these pin its own contract, so a rewrite of it is held to the
  // same behavior: chunking, cancellation, nonfinite and already-past delays.
  test("a delay past the limit is waited in parts, and the cancel stops the part in flight", () => {
    const clock = new SimulatedClock();
    try {
      let fired = 0;
      const cancel = __wait(2147483647 + 1000, () => fired++);
      clock.advance(2147483647);
      expect(fired).toBe(0);
      clock.advance(999);
      expect(fired).toBe(0);
      clock.advance(1);
      expect(fired).toBe(1);
      cancel();
      expect(clock.pending()).toBe(0);
    } finally {
      clock.uninstall();
    }
  });

  test("a cancel before the deadline stops it", () => {
    const clock = new SimulatedClock();
    try {
      let fired = 0;
      const cancel = __wait(1000, () => fired++);
      cancel();
      clock.advance(1000);
      expect(fired).toBe(0);
    } finally {
      clock.uninstall();
    }
  });

  // NaN and +Infinity never fire. -Infinity is a deadline already past, so it fires at once, as a
  // negative delay does: `ms < Infinity` holds for it.
  test.each([Number.NaN, Number.POSITIVE_INFINITY])("%p never fires, and its cancel is a no-op", (ms) => {
    const clock = new SimulatedClock();
    try {
      let fired = 0;
      const cancel = __wait(ms, () => fired++);
      expect(clock.pending()).toBe(0);
      clock.advance(1e9);
      expect(fired).toBe(0);
      cancel();
    } finally {
      clock.uninstall();
    }
  });

  test.each([-30, Number.NEGATIVE_INFINITY])("a negative delay (%p) fires at once", (ms) => {
    const clock = new SimulatedClock();
    try {
      let fired = 0;
      __wait(ms, () => fired++);
      clock.advance(0);
      expect(fired).toBe(1);
    } finally {
      clock.uninstall();
    }
  });
});

describe("SimulatedClock", () => {
  let clock: SimulatedClock | undefined;
  afterEach(() => clock?.uninstall());

  test("timers fire when the test moves the clock, in deadline order, at their deadlines", () => {
    clock = new SimulatedClock(1000);
    const actor = createActor(lean, { now: clock.now });
    actor.send({ type: "go" });
    expect(clock.pending()).toBe(2);
    clock.advance(19);
    expect(actor.snapshot().data).toEqual({ n: 0 });
    clock.advance(1);
    expect(actor.snapshot().data).toEqual({ n: 10 });
    expect(clock.now()).toBe(1020);
    clock.advance(100);
    expect(actor.snapshot().state).toBe("timedOut");
    expect(clock.pending()).toBe(0);
  });

  test("timers that come due in one move fire in deadline order, and in the order set at a tie", () => {
    clock = new SimulatedClock();
    const fired: string[] = [];
    setTimeout(() => fired.push(`b at ${clock?.now()}`), 20);
    setTimeout(() => fired.push(`a at ${clock?.now()}`), 10);
    setTimeout(() => fired.push(`c at ${clock?.now()}`), 20);
    clock.advance(30);
    expect(fired).toEqual(["a at 10", "b at 20", "c at 20"]);
    expect(clock.now()).toBe(30);
  });

  test("leaving a state cancels its timers on the clock", () => {
    clock = new SimulatedClock();
    const actor = createActor(lean, { now: clock.now });
    actor.send({ type: "go" });
    actor.send({ type: "cancel" });
    expect(clock.pending()).toBe(0);
    clock.advance(1000);
    expect(actor.snapshot().state).toBe("idle");
  });

  test("persisted deadlines are read from it: a restored actor waits only what is left", () => {
    clock = new SimulatedClock(0);
    const actor = createActor(job, { now: clock.now });
    actor.send({ type: "go" });
    clock.advance(30);
    const saved = persist(actor);
    expect(saved.run).toEqual({ waiting: { t: [null, 60] } });
    actor.stop();
    clock.set(50);
    const restored = restoreActor(job, saved, { now: clock.now });
    clock.advance(9);
    expect(restored.snapshot().state).toBe("waiting");
    clock.advance(1);
    expect(restored.snapshot().state).toBe("timedOut");
  });

  test("uninstall gives back the real timers", async () => {
    clock = new SimulatedClock();
    clock.uninstall();
    await new Promise((r) => setTimeout(r, 1));
    expect(clock.pending()).toBe(0);
  });
});
