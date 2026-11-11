// logic: every kind of actor logic as a root actor, and as a node's child (compiled, ./fixture.ts).

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";

import { compile } from "@reactre/state/compiler";

import { optIn } from "../opt-in.ts";

const { createActor, restoreActor, transition, initial } = await import("@reactre/state");
const { child } = await import("@reactre/state/children");
const {
  createAsyncLogic,
  createCallbackLogic,
  createEmptyActor,
  createEventObservableLogic,
  createListenerLogic,
  createObservableLogic,
  createStepLogic,
  createSubscriptionLogic,
  TimeoutError,
} = await import("@reactre/state/logic");
const { calls, userMachine } = await import("./fixture.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A hand-made observable: `emit` pushes to every subscriber. */
function subject<T>() {
  const observers = new Set<{ next: (v: T) => void; error: (e: unknown) => void; complete: () => void }>();
  return {
    subscribe(o: { next: (v: T) => void; error: (e: unknown) => void; complete: () => void }) {
      observers.add(o);
      return { unsubscribe: () => observers.delete(o) };
    },
    next: (v: T) => {
      for (const o of observers) o.next(v);
    },
    error: (e: unknown) => {
      for (const o of observers) o.error(e);
    },
    complete: () => {
      for (const o of observers) o.complete();
    },
    get size() {
      return observers.size;
    },
  };
}

describe("logic", () => {
  optIn("logic");

  test("a logic child compiles to a child with its error and on handlers", () => {
    const source = `import { setup, types } from "@reactre/state";
import { children } from "@reactre/state/children";
import { createCallbackLogic, logic } from "@reactre/state/logic";
const ticks = createCallbackLogic<never, undefined, { type: "tick" }>(() => () => {});
const s = setup({ use: [children, logic], states: { a: types<{ n: number }>(), b: types<{}>() }, events: {}, children: { ticks } });
export const m = s.machine({
  start: ({ to }) => to("a", { n: 0 }),
  states: {
    a: { children: { ticks: { error: ({ to }) => to("b"), on: { tick: ({ data, to }) => to("a", { n: data.n + 1 }) } } } },
    b: { final: true },
  },
});
`;
    const code = compile("logic.ts", source)?.code ?? "";
    expect(code).toContain(
      'c: { "a": { "ticks": { m: ticks, x: () => ({ state: "b", data: __reactreStateNone, version: 0 }), o: { "tick": (data) => ({ state: "a", data: { n: data.n + 1 }, version: 0 }) } } } }',
    );
    expect(code).toContain('import { createCallbackLogic, logic } from "@reactre/state/logic";');
  });
});

describe("async logic", () => {
  test("as a root actor: active with its input, then done with the output", async () => {
    const load = createAsyncLogic({
      run: async ({ input }: { input: { id: string }; signal: AbortSignal }) => input.id.length,
    });
    const actor = createActor(load, { input: { id: "abc" } });
    expect(actor.snapshot()).toEqual({ state: "active", data: { input: { id: "abc" } }, version: 0 });
    await tick();
    expect(actor.snapshot()).toEqual({ state: "done", data: { output: 3 }, version: 0 });
    expect(actor.status()).toBe("done");
  });

  test("what run throws is its error; stopping aborts the signal", async () => {
    const boom = new Error("no");
    const failing = createActor(createAsyncLogic({ run: async () => Promise.reject(boom) }));
    await tick();
    expect(failing.snapshot()).toMatchObject({ state: "error", data: { error: boom } });

    let signal: AbortSignal | undefined;
    const slow = createActor(createAsyncLogic({ run: (args) => ((signal = args.signal), new Promise(() => {})) }));
    slow.stop();
    expect(signal?.aborted).toBe(true);
  });

  test("a timeout aborts the signal and fails with a TimeoutError", async () => {
    let signal: AbortSignal | undefined;
    const actor = createActor(
      createAsyncLogic({ id: "slow", timeout: "10ms", run: (args) => ((signal = args.signal), new Promise(() => {})) }),
    );
    await tick(30);
    expect(signal?.aborted).toBe(true);
    const s = actor.snapshot();
    expect(s.state).toBe("error");
    if (s.state === "error") {
      expect(s.data.error).toBeInstanceOf(TimeoutError);
      expect(String(s.data.error)).toContain('async logic "slow" took longer than its timeout, 10ms');
    }
  });

  test("a duration that isn't one throws S31", () => {
    // @ts-expect-error not a duration
    expect(() => createAsyncLogic({ timeout: "5 sec", run: async () => 1 })).toThrow("S31");
  });

  test("steps are recorded in its data, and a restored actor doesn't run a recorded step again", async () => {
    const ran: string[] = [];
    let release: () => void = () => {};
    const charge = createAsyncLogic({
      run: async ({ input }: { input: { amount: number }; signal: AbortSignal }, enq) => {
        const id = await enq.step("charge", () => (ran.push("charge"), `ch_${input.amount}`));
        await new Promise<void>((r) => (release = r));
        const receipt = await enq.step("receipt", () => (ran.push("receipt"), `r_${id}`));
        return receipt;
      },
    });
    const actor = createActor(charge, { input: { amount: 5 } });
    await tick();
    expect(actor.snapshot().data).toEqual({ input: { amount: 5 }, steps: { charge: "ch_5" } });
    const saved: ReturnType<typeof actor.snapshot> = JSON.parse(JSON.stringify(actor.snapshot()));
    actor.stop();

    const again = restoreActor(charge, saved);
    await tick();
    release();
    await tick();
    expect(again.snapshot()).toEqual({ state: "done", data: { output: "r_ch_5" }, version: 0 });
    expect(ran).toEqual(["charge", "receipt"]);
  });
});

describe("callback logic", () => {
  test("receive gets what is sent to it, and stopping cleans up", () => {
    const heard: string[] = [];
    let cleaned = false;
    const logic = createCallbackLogic<{ type: "say"; text: string }, undefined, { type: "heard"; text: string }>(
      ({ sendBack, receive }) => {
        receive((e) => {
          heard.push(e.text);
          // A root actor has no parent: what it sends back is dropped.
          sendBack({ type: "heard", text: e.text });
        });
        return () => (cleaned = true);
      },
    );
    const actor = createActor(logic);
    expect(actor.send({ type: "say", text: "hi" })).toMatchObject({ ok: true, snapshot: { state: "active" } });
    expect(heard).toEqual(["hi"]);
    actor.stop();
    expect(cleaned).toBe(true);
    // Stopped: nothing more is received.
    expect(actor.send({ type: "say", text: "again" }).ok).toBe(false);
    expect(heard).toEqual(["hi"]);
  });

  test("a callback that throws fails the actor", () => {
    const actor = createActor(
      createCallbackLogic(() => {
        throw new Error("no socket");
      }),
    );
    expect(actor.snapshot()).toMatchObject({ state: "error", data: { error: new Error("no socket") } });
  });
});

describe("observables", () => {
  test("observable logic's data is the last value; complete ends it, error fails it", () => {
    const values = subject<number>();
    const actor = createActor(createObservableLogic(() => values));
    values.next(1);
    values.next(2);
    expect(actor.snapshot().data).toEqual({ input: undefined, value: 2 });
    values.complete();
    expect(actor.snapshot()).toMatchObject({ state: "done", data: { output: undefined } });
    expect(values.size).toBe(0);

    const failing = subject<number>();
    const b = createActor(createObservableLogic(() => failing));
    failing.error("lost");
    expect(b.snapshot()).toMatchObject({ state: "error", data: { error: "lost" } });
  });

  test("event observable logic sends each event to its parent", () => {
    const events = subject<{ type: "ping" }>();
    const actor = createActor(createEventObservableLogic(() => events));
    events.next({ type: "ping" });
    expect(actor.snapshot().state).toBe("active");
    actor.stop();
    expect(events.size).toBe(0);
  });

  test("event observable logic ends when its stream completes, and fails when it errors", () => {
    const events = subject<{ type: "ping" }>();
    const actor = createActor(createEventObservableLogic(() => events));
    events.complete();
    expect(actor.snapshot()).toMatchObject({ state: "done", data: { output: undefined } });
    expect(events.size).toBe(0);

    const failing = subject<{ type: "ping" }>();
    const b = createActor(createEventObservableLogic(() => failing));
    failing.error("lost");
    expect(b.snapshot()).toMatchObject({ state: "error", data: { error: "lost" } });
  });
});

describe("step logic", () => {
  const counter = createStepLogic<
    { count: number },
    { type: "inc" } | { type: "end" } | { type: "bad" },
    never,
    undefined,
    number
  >({
    context: { count: 0 },
    run: ({ context, event }, enq) => {
      if (event.type === "end") return { status: "done", output: context.count };
      if (event.type === "bad") return { status: "error", error: "bad" };
      enq.effect("poll", () => () => undefined);
      return { context: { count: context.count + 1 } };
    },
  });

  test("run is a pure step: transition gives the next context and the recorded effects, unrun", () => {
    const r = transition(counter, initial(counter, undefined), { type: "inc" });
    expect(r).toMatchObject({ ok: true, snapshot: { state: "active", data: { context: { count: 1 } } } });
    if (r.ok) expect((r as { fx?: unknown[] }).fx).toHaveLength(1);
  });

  test("as an actor: each event steps it, done ends it with the output", () => {
    const actor = createActor(counter);
    actor.send({ type: "inc" });
    actor.send({ type: "inc" });
    expect(actor.snapshot().data).toEqual({ input: undefined, context: { count: 2 } });
    actor.send({ type: "end" });
    expect(actor.snapshot()).toMatchObject({ state: "done", data: { output: 2 } });
    expect(createActor(counter).send({ type: "bad" }).snapshot).toMatchObject({
      state: "error",
      data: { error: "bad" },
    });
  });

  test("enq.raise steps it again, and a keyed effect starts once and cleans up at stop", () => {
    let started = 0;
    let stopped = 0;
    const twice = createStepLogic<{ n: number }, { type: "go" } | { type: "again" }>({
      context: { n: 0 },
      run: ({ context, event }, enq) => {
        enq.effect("once", () => (started++, () => stopped++));
        if (event.type === "go") enq.raise({ type: "again" });
        return { context: { n: context.n + 1 } };
      },
    });
    const actor = createActor(twice);
    actor.send({ type: "go" });
    expect(actor.snapshot().data).toEqual({ input: undefined, context: { n: 2 } });
    expect(started).toBe(1);
    actor.stop();
    expect(stopped).toBe(1);
  });

  test("an effect without a key runs on each step; nothing returned stays; a throw fails it", () => {
    const ran: string[] = [];
    const chat = createStepLogic<
      { said: number },
      { type: "say"; text: string } | { type: "noop" } | { type: "crash" },
      { type: "said"; text: string }
    >({
      context: { said: 0 },
      run: ({ context, event }, enq) => {
        if (event.type === "noop") return;
        if (event.type === "crash") throw new Error("crashed");
        enq.effect(() => void ran.push(event.text));
        // A root actor has no parent: what it sends back is dropped.
        enq.sendBack({ type: "said", text: event.text });
        return { context: { said: context.said + 1 } };
      },
    });
    const actor = createActor(chat);
    actor.send({ type: "say", text: "a" });
    actor.send({ type: "say", text: "b" });
    expect(ran).toEqual(["a", "b"]);
    const before = actor.snapshot();
    expect(actor.send({ type: "noop" })).toMatchObject({ ok: true, snapshot: before });
    expect(actor.snapshot()).toBe(before);
    actor.send({ type: "crash" });
    expect(actor.snapshot()).toMatchObject({ state: "error", data: { error: new Error("crashed") } });
    expect(actor.status()).toBe("done");
  });
});

describe("listener, subscription and empty actors", () => {
  test("listener logic maps the events another actor emits, by type and wildcard", () => {
    const listeners = new Set<(e: { type: string }) => void>();
    const source = {
      on: (_: "*", l: (e: { type: string }) => void) => (listeners.add(l), () => listeners.delete(l)),
    };
    const actor = createActor(createListenerLogic(source, "upload.*", (e) => ({ type: "seen", what: e.type })));
    for (const l of listeners) l({ type: "upload.done" });
    actor.stop();
    expect(listeners.size).toBe(0);
  });

  test("subscription logic reads another actor's snapshots and its outcome", async () => {
    const load = createAsyncLogic({ run: async () => "ok" });
    const source = createActor(load);
    const seen: unknown[] = [];
    const sub = createActor(
      createSubscriptionLogic(source, { done: (output) => (seen.push(output), { type: "loaded" }) }),
    );
    await tick();
    expect(seen).toEqual(["ok"]);
    sub.stop();
  });

  test("the empty actor is active, takes nothing, and stops", () => {
    const actor = createEmptyActor();
    expect(actor.snapshot().state).toBe("active");
    actor.stop();
    expect(actor.status()).toBe("stopped");
  });
});

describe("as a node's child", () => {
  test("async logic's output reaches done; a callback's events reach the child's on", async () => {
    calls.length = 0;
    const actor = createActor(userMachine);
    actor.send({ type: "load" });
    expect(calls.map((c) => c.id)).toEqual(["u1"]);
    await tick(12);
    const s = actor.snapshot();
    expect(s.state === "loading" && s.data.ticks > 0).toBe(true);
    expect(child(actor, "load")?.snapshot().state).toBe("active");
    calls[0]?.resolve("Ann");
    await tick();
    expect(actor.snapshot()).toEqual({ state: "ready", data: { name: "Ann" }, version: 0 });
  });

  test("a rejection reaches error, and so does a timeout, as a TimeoutError", async () => {
    calls.length = 0;
    const actor = createActor(userMachine);
    actor.send({ type: "load" });
    calls[0]?.reject("down");
    await tick();
    expect(actor.snapshot()).toEqual({ state: "failed", data: { reason: "down" }, version: 0 });
    actor.send({ type: "retry" });
    actor.send({ type: "load" });
    await tick(70);
    expect(actor.snapshot()).toEqual({ state: "failed", data: { reason: "timeout" }, version: 0 });
  });

  test("leaving the node stops its logic children: the load's signal aborts, the ticker stops", async () => {
    calls.length = 0;
    const actor = createActor(userMachine);
    actor.send({ type: "load" });
    const load = child(actor, "load");
    const ticker = child(actor, "ticker");
    calls[0]?.reject("down");
    await tick();
    expect(load?.status()).toBe("done");
    expect(ticker?.status()).toBe("stopped");
  });
});
