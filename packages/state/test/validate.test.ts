// Runtime validation (@reactre/state/validate), on compiled tables written by hand, as the compiler
// will write them for a setup with Standard Schemas.

import { describe, expect, test } from "bun:test";

import { durable, type DurableRun, type Host } from "../src/features/durable/index.ts";
import { __decided } from "../src/features/validate/decided.ts";
import { __restored, __validate, __validated, __validInput, ValidationError } from "../src/features/validate/index.ts";
import { type __Actor, __flat, __step, createActor, initial, type Shape, StateError } from "../src/index.ts";
import type { __Compiled, __Event, __Step, __StepHook } from "../src/internal.ts";
import { __lean } from "../src/tasks.ts";
import { later, number, object, type StandardSchemaV1, string, trimmed } from "./fixtures/standard-schema.ts";
import { to } from "./to.ts";

// The overloads type a machine by its shape; these tables are written by hand, without one.
const start = createActor as unknown as (m: __Compiled, options?: { input: unknown }) => __Actor;
/** An event from outside the types: any payload, as JSON gives. */
const ev = (e: { readonly type: string; readonly [field: string]: unknown }): __Event => e;
const send = (m: __Compiled, e: __Event) => __step(m, initial(m, undefined), e, false);

type Note = { text: string; by?: string };

// setup({ states: { draft: object({ text }), sent: object({ text, by }) },
//         events: { submit: object({ by: trimmed() }) }, internal: { saved: object({ id }) } })
const notes: __Compiled = {
  v: 0,
  e: { submit: 1 },
  i: () => to("draft", { text: "hi" }),
  o: {
    draft: {
      submit: (data, event) => to("sent", { text: (data as Note).text, by: (event as __Event & { by: string }).by }),
      saved: (data) => to("draft", data),
      ping: () => to("sent", { text: "x", by: "y" }),
    },
    sent: {},
  },
  f: { sent: 1 },
  s: {
    e: { submit: object({ by: trimmed() }), saved: object({ id: string() }) },
    d: { draft: object({ text: string() }), sent: object({ text: string(), by: string() }) },
  },
  x: __validate,
  y: __validated(),
};

describe("events", () => {
  test("a valid event passes, as its schema's value, with its type", () => {
    expect(send(notes, ev({ type: "submit", by: "  ann " }))).toEqual({
      ok: true,
      snapshot: { state: "sent", data: { text: "hi", by: "ann" }, version: 0 },
    });
  });

  test("an invalid event is refused as invalid, with its issues, and doesn't move", () => {
    const actor = start(notes);
    expect(actor.send(ev({ type: "submit", by: 7 }))).toEqual({
      ok: false,
      reason: "invalid",
      snapshot: { state: "draft", data: { text: "hi" }, version: 0 },
      issues: [{ message: "expected a string", path: [{ key: "by" }] }],
    });
    expect(actor.snapshot().state).toBe("draft");
  });

  test("an internal event (a task's result) is validated too", () => {
    const from = initial(notes, undefined);
    expect(__step(notes, from, ev({ type: "saved", id: 1 }), true)).toMatchObject({
      ok: false,
      reason: "invalid",
      issues: [{ message: "expected a string", path: [{ key: "id" }] }],
    });
    expect(__step(notes, from, ev({ type: "saved", id: "a" }), true).ok).toBe(true);
  });

  test("an invalid internal event carries S6 for the task's error handler; a sent one doesn't", () => {
    const hook = __validated();
    const from = initial(notes, undefined);
    expect(hook(notes, from, ev({ type: "saved", id: 1 }), true)).toMatchObject({
      reason: "invalid",
      error: new StateError(
        "S6",
        'a task in state "draft" resolved to an invalid "saved" event (event.id: expected a string). Resolve to what setup\'s internal "saved" declares.',
      ),
    });
    expect("error" in hook(notes, from, ev({ type: "submit", by: 1 }), false)).toBe(false);
  });

  test("an event without a schema goes through as it is", () => {
    expect(__step(notes, initial(notes, undefined), ev({ type: "ping", extra: 1 }), true).ok).toBe(true);
  });

  test("it wraps the hierarchy's step, which gets the validated event", () => {
    const seen: __Event[] = [];
    const nested: __StepHook = (m, from, event) => {
      seen.push(event);
      return __flat(m, from, event);
    };
    const m = { ...notes, y: __validated(nested) };
    expect(send(m, ev({ type: "submit", by: 1 })).ok).toBe(false);
    expect(seen).toEqual([]);
    expect(send(m, ev({ type: "submit", by: " bo " })).ok).toBe(true);
    expect(seen).toEqual([ev({ type: "submit", by: "bo" })]);
  });
});

describe("input", () => {
  // setup({ input: object({ file: trimmed(), size: number() }) }), start: ({ input, to }) => to("draft", { text: input.file })
  const withInput: __Compiled = {
    ...notes,
    i: __validInput(object({ file: trimmed(), size: number() }), (input) =>
      to("draft", { text: (input as { file: string }).file }),
    ),
  };

  test("a valid input starts the machine, as the schema's value", () => {
    expect(start(withInput, { input: { file: " a.txt ", size: 1 } }).snapshot()).toEqual({
      state: "draft",
      data: { text: "a.txt" },
      version: 0,
    });
  });

  test("an invalid input throws S5, listing each issue as path: message", () => {
    expect(() => start(withInput, { input: { file: 1 } })).toThrow(
      new StateError(
        "S5",
        "the input doesn't match its schema: input.file: expected a string; input.size: expected a number. Give createActor an input the schema accepts.",
      ),
    );
    expect(() => start(withInput, { input: undefined })).toThrow(/S5\].*input: expected an object/);
  });
});

describe("restored data", () => {
  test("data that matches its state's schema passes", () => {
    expect(() => __restored(notes, { state: "sent", data: { text: "a", by: "b" }, version: 0 })).not.toThrow();
  });

  test("data that doesn't throws S7, naming the state and the issues", () => {
    expect(() => __restored(notes, { state: "sent", data: { text: "a" }, version: 0 })).toThrow(
      new StateError(
        "S7",
        "the saved data of state \"sent\" doesn't match its schema: data.by: expected a string. Migrate the saved data to the state's schema (and bump setup's version when a shape changes), then restore it.",
      ),
    );
  });

  test("a parallel node's regions and the history are checked too", () => {
    const player: __Compiled = {
      ...notes,
      p: { on: ["playback", "volume"] },
      s: { d: { "on.volume.audible": object({ level: number() }), idle: object({}) } },
    };
    const regions = (level: unknown) => ({
      playback: { state: "on.playback.stopped", data: {} },
      volume: { state: "on.volume.audible", data: { level } },
    });
    expect(() => __restored(player, { state: "on", data: regions(5), version: 0 })).not.toThrow();
    expect(() => __restored(player, { state: "on", data: regions("5"), version: 0 })).toThrow(
      /S7\].*state "on.volume.audible".*data.level: expected a number/,
    );
    const history = { on: { state: "on", data: regions(null) } };
    expect(() => __restored(player, { state: "idle", data: {}, version: 0, history })).toThrow(/S7\].*data.level/);
  });
});

describe("async schemas", () => {
  test("a schema that returns a Promise throws S8, naming the fix", () => {
    expect(() => __validate(later(), "x")).toThrow(
      /S8\].*Promise.*Use a synchronous schema.*validate the payload yourself before send/,
    );
    const m = { ...notes, s: { e: { submit: later() } } };
    expect(() => send(m, ev({ type: "submit", by: "a" }))).toThrow(/S8\]/);
  });
});

describe("the data a transition makes (XState's result check)", () => {
  // sent's schema wants a `by` of 2 letters or more: a refinement the types can't hold.
  const short: StandardSchemaV1<string> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        typeof value === "string" && value.length >= 2 ? { value } : { issues: [{ message: "Too short" }] },
    },
  };
  const strict: __Compiled = { ...notes, s: { ...notes.s, d: { sent: object({ text: string(), by: short }) } } };

  test("a step whose data its state's schema refuses is refused as invalid, and doesn't move", () => {
    const r = send(strict, ev({ type: "submit", by: "a" }));
    expect(r).toMatchObject({
      ok: false,
      reason: "invalid",
      snapshot: { state: "draft" },
      issues: [{ message: "Too short", path: [{ key: "by" }] }],
    });
    expect(send(strict, ev({ type: "submit", by: "ann" })).ok).toBe(true);
  });

  test("its error is a ValidationError, S23, for a task's error handler", () => {
    const r = __step(strict, initial(strict, undefined), ev({ type: "submit", by: "a" }), true);
    const error = r.ok ? undefined : r.error;
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ code: "S23", boundary: "data", state: "sent", event: "submit" });
    expect(String(error)).toMatch(
      /S23\] the "submit" handler in state "draft" went to "sent" with data its schema refuses \(data\.by: Too short\)\. Build data the state's schema accepts\./,
    );
  });

  test("start's data is checked too: createActor throws S23", () => {
    const m: __Compiled = {
      ...strict,
      i: __validInput(undefined, () => to("sent", { text: "x", by: "a" }), strict.s?.d),
    };
    expect(() => start(m)).toThrow(/S23\] start went to "sent" with data its schema refuses \(data\.by: Too short\)/);
    const ok: __Compiled = { ...m, i: __validInput(undefined, () => to("sent", { text: "x", by: "ab" }), strict.s?.d) };
    expect(start(ok).snapshot().state).toBe("sent");
  });

  // A timer's step and a task's error reach the actor through the lifecycle's `go`, past every step
  // hook: the compiler wraps their handlers (`__decided`), which check the data they decide.
  const d = strict.s?.d ?? {};
  const timed: __Compiled = {
    ...strict,
    a: {
      draft: [
        [60_000, __decided((_data: unknown, _state: string) => to("sent", { text: "x", by: "a" }), d, "a timer", 1)],
      ],
    },
    t: {
      draft: [
        () => Promise.reject(new Error("down")),
        __decided(
          (_data: unknown, _error: unknown, _state: string) => to("sent", { text: "x", by: "b" }),
          d,
          "a task's error",
          2,
        ),
      ],
    },
    u: { durable: 1 },
  };

  test("a timer's step and a task's error are checked where their handlers run: S23, and nothing moves", async () => {
    const timer = timed.a?.["draft"]?.[0]?.[1];
    expect(() => timer?.({ text: "hi" }, "draft")).toThrow(
      /S23\] a timer in state "draft" went to "sent" with data its schema refuses \(data\.by: Too short\)/,
    );
    // On a journaling host, the fire rejects with it, and the run stays where it was.
    const host: Host<Shape> = {
      now: () => 0,
      step: <T>(_id: string, fn: () => Promise<T>) => fn().catch(() => new Promise<T>(() => {})),
      schedule: () => {},
      cancel: () => {},
      save: () => {},
    };
    const run = (durable as unknown as (m: __Compiled, host: Host<Shape>) => DurableRun<Shape>)(timed, host);
    await run.start();
    await expect(run.fire("draft#1/after/60000")).rejects.toThrow(/S23\] a timer in state "draft"/);
    expect(run.snapshot().state).toBe("draft");
    expect(() => timed.t?.["draft"]?.[1]({ text: "hi" }, new Error("down"), "draft")).toThrow(
      /S23\] a task's error in state "draft" went to "sent"/,
    );
  });

  test("data the schema accepts goes through, unchanged", () => {
    const ok = __decided((_data: unknown, _state: string) => to("sent", { text: "x", by: "ann" }), d, "a timer", 1);
    expect(ok({}, "draft")).toEqual(to("sent", { text: "x", by: "ann" }));
    expect(__decided(() => null, d, "a child's update", 2)()).toBeNull();
  });

  test("a parallel step's regions are each checked", () => {
    const d = { "on.a.x": object({ n: number() }) };
    const regions = (n: unknown): __Step => to("on", { a: to("on.a.x", { n }), b: to("on.b.y") });
    expect(() => __validInput(undefined, () => regions(1), d)(undefined)).not.toThrow();
    expect(() => __validInput(undefined, () => regions("1"), d)(undefined)).toThrow(/S23\].*"on\.a\.x".*data\.n/);
  });
});

describe("failures are ValidationErrors", () => {
  test("each says where: boundary, issues, and the state or event", () => {
    const withInput = __validInput(object({ file: string() }), () => to("draft", { text: "" }));
    try {
      withInput({ file: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toBeInstanceOf(StateError);
      expect(error).toMatchObject({ code: "S5", boundary: "input", issues: [{ path: [{ key: "file" }] }] });
    }
    const r = __validated()(notes, initial(notes, undefined), ev({ type: "saved", id: 1 }), true);
    expect(r.ok ? undefined : r.error).toMatchObject({ code: "S6", boundary: "event", event: "saved", state: "draft" });
    expect(() => __restored(notes, { state: "sent", data: {}, version: 0 })).toThrow(ValidationError);
  });

  test("a schema that throws is S24, with what it threw as the cause", () => {
    const boom = new Error("boom");
    const throws: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw boom;
        },
      },
    };
    let caught: unknown;
    try {
      __validate(throws, 1);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toMatch(
      /S24\] a schema threw \(Error: boom\): a schema returns \{ issues \} for a value it refuses/,
    );
    expect(caught).toMatchObject({ cause: boom });
  });
});

// dur:S1, dur:S2: an internal event whose schema transforms. A task's result is parsed as a sent
// event is: the task resolves to what the schema takes (its input), and the handler gets what the
// schema gives (its output). So `run`'s return is the schema's input, as `send`'s argument is.
describe("an internal event's schema that transforms", () => {
  /** Digits in, a number out. */
  const digits: StandardSchemaV1<string, number> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) =>
        typeof v === "string" && /^\d+$/.test(v) ? { value: Number(v) } : { issues: [{ message: "expected digits" }] },
    },
  };
  const counted: __Compiled = {
    v: 0,
    e: { go: 1 },
    i: () => to("idle"),
    o: {
      idle: { go: () => to("waiting") },
      waiting: { counted: (_d, e) => to("done", { n: Reflect.get(e, "n") }) },
      done: {},
    },
    f: { done: 1 },
    t: {
      waiting: [async () => ev({ type: "counted", n: "42" }), (_d, error) => to("idle", { error: String(error) })],
    },
    r: __lean,
    s: { e: { counted: object({ n: digits }) } },
    x: __validate,
    y: __validated(),
  };

  test("the task resolves to the schema's input, and the handler gets its output", async () => {
    const actor = start(counted);
    actor.send(ev({ type: "go" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(actor.snapshot()).toEqual({ state: "done", data: { n: 42 }, version: 0 });
  });

  test("a result in the schema's output (the number) is refused: S6", () => {
    const waiting = { state: "waiting", data: {}, version: 0 };
    expect(__step(counted, waiting, ev({ type: "counted", n: 42 }), true)).toMatchObject({
      ok: false,
      reason: "invalid",
      error: { code: "S6", boundary: "event", event: "counted" },
    });
  });
});
