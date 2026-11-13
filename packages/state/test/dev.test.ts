// @reactre/state/dev: what a development build adds. The freeze, and the JSON checks fused into it
// (M35: a non-finite number; M36: a cycle), which a production build never imports.

import { describe, expect, test } from "bun:test";

import type { __Compiled } from "@reactre/state";
import { compile } from "@reactre/state/compiler";

// The preload plugin, so the fixtures load compiled (with dev on, its default).
import "./compiled.ts";
import { __freeze } from "../src/dev.ts";
import { DOOR } from "./sources.ts";

const S3 = /\[@reactre\/state S3\]/;

describe("__freeze", () => {
  test("freezes data all the way down, so an edit throws", () => {
    const data = __freeze({ by: "ann", items: [{ n: 1 }] }) as { by: string; items: { n: number }[] };
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.items)).toBe(true);
    expect(Object.isFrozen(data.items[0])).toBe(true);
    expect(() => {
      data.by = "bob";
    }).toThrow(TypeError);
  });

  test("a finite number, -0 included, is data", () => {
    expect(() => __freeze({ ratio: 0.5, zero: -0, big: Number.MAX_VALUE })).not.toThrow();
    const kept = __freeze({ zero: -0 }) as { readonly zero: number };
    expect(Object.is(kept.zero, -0)).toBe(true);
  });

  test("M35: NaN and ±Infinity are refused, naming the path", () => {
    expect(() => __freeze({ ratio: Number.NaN })).toThrow(S3);
    expect(() => __freeze({ ratio: Number.NaN })).toThrow(/data\.ratio is NaN, which JSON turns into null/);
    expect(() => __freeze({ items: [{ n: Number.POSITIVE_INFINITY }] })).toThrow(/data\.items\[0\]\.n is Infinity/);
    expect(() => __freeze({ n: Number.NEGATIVE_INFINITY })).toThrow(/data\.n is -Infinity/);
  });

  test("M35: a frozen object is checked too (a module constant, __none)", () => {
    expect(() => __freeze(Object.freeze({ n: Number.NaN }))).toThrow(S3);
  });

  test("M36: a cycle is refused, naming the field that points back", () => {
    const a: { x: number; self?: unknown } = { x: 1 };
    a.self = a;
    expect(() => __freeze(a)).toThrow(S3);
    expect(() => __freeze(a)).toThrow(/data\.self is a cycle/);
  });

  test("M36: a value shared by two fields is not a cycle", () => {
    const shared = { n: 1 };
    expect(() => __freeze({ a: shared, b: shared })).not.toThrow();
    expect(Object.isFrozen(shared)).toBe(true);
  });

  test("M36: a parent and its child are not a cycle", () => {
    expect(() => __freeze({ parent: { child: { n: 1 } } })).not.toThrow();
  });
});

describe("M36 at the runtime boundary", () => {
  // A task's result is a payload the machine stores: a cyclic one reaches __snap through the
  // task's event, not through a handler's `to`. A hand-written table, as a compiled one is.
  test("a task's event carrying a cycle is refused in development, at the move", async () => {
    const { createActor } = await import("@reactre/state");
    const { to } = await import("./to.ts");
    const cyclic: { n: number; self?: unknown } = { n: 1 };
    cyclic.self = cyclic;
    const m = {
      v: 0,
      e: { go: 1, done: 1 },
      i: () => to("idle"),
      o: {
        idle: { go: () => to("waiting") },
        waiting: { done: (_: unknown, event: { payload: unknown }) => to("stored", { payload: event.payload }) },
      },
      t: { waiting: [async () => ({ type: "done", payload: cyclic }), () => to("failed")] },
      d: __freeze,
    } as unknown as __Compiled;
    const actor = createActor(m);
    actor.send({ type: "go" });
    await new Promise((r) => setTimeout(r, 0));
    // The task's own result carried the cycle: the move that stores it is refused.
    expect(actor.snapshot().state).toBe("waiting");
    // A variable, not a literal: the event carries a payload the table's `e` doesn't name.
    const done = { type: "done", payload: cyclic };
    expect(() => actor.send(done)).toThrow(/S3\] data\.payload\.self is a cycle/);
    actor.stop();
  });
});

// A hand-written table, as a compiled one is: `d` is the development value, which counts a move's
// listener rounds. A listener that sends on every snapshot it is told never rests; the count
// throws instead of hanging. A listener that sends a few times passes.
const { createActor } = await import("@reactre/state");
const { to } = await import("./to.ts");
const { __dev } = await import("../src/dev.ts");

describe("M51: a listener that sends on every snapshot", () => {
  const machine = {
    v: 0,
    e: { go: 1, tick: 1 },
    i: () => to("idle"),
    o: {
      idle: { go: () => to("counting", { n: 0 }) },
      counting: { tick: (d: { n: number }) => to("counting", { n: d.n + 1 }) },
    },
    d: __dev,
  } as unknown as __Compiled;

  test("a listener that sends on every snapshot throws S29, not hangs", () => {
    const actor = createActor(machine);
    actor.subscribe(() => actor.send({ type: "tick" }));
    expect(() => actor.send({ type: "go" })).toThrow(/S29\] a listener sent an event on every snapshot/);
    actor.stop();
  });

  test("a listener that sends a few times passes", () => {
    const actor = createActor(machine);
    let sent = 0;
    actor.subscribe((s) => {
      if (s.state === "counting" && sent < 3) {
        sent++;
        actor.send({ type: "tick" });
      }
    });
    expect(actor.send({ type: "go" }).ok).toBe(true);
    expect(actor.snapshot()).toMatchObject({ state: "counting", data: { n: 3 } });
    actor.stop();
  });

  test("after a listener throws, a later send still tells the listeners", () => {
    const actor = createActor(machine);
    const seen: string[] = [];
    let threw = false;
    actor.subscribe(() => {
      if (threw) return;
      threw = true;
      throw new Error("listener failed");
    });
    actor.subscribe((s) => seen.push(s.state));
    expect(() => actor.send({ type: "go" })).toThrow("listener failed");
    // The round ended with `telling` false: the next move tells the listeners again.
    expect(actor.send({ type: "tick" }).ok).toBe(true);
    expect(seen).toEqual(["counting", "counting"]);
    actor.stop();
  });

  test("after the round check throws, a later finite chain is still told", () => {
    const actor = createActor(machine);
    let looping = true;
    const seen: string[] = [];
    actor.subscribe((s) => {
      if (looping) actor.send({ type: "tick" });
      else seen.push(s.state);
    });
    expect(() => actor.send({ type: "go" })).toThrow(/S29/);
    looping = false;
    expect(actor.send({ type: "tick" }).ok).toBe(true);
    expect(seen).toEqual(["counting"]);
    actor.stop();
  });

  test("a production table (no d) counts nothing", () => {
    const { d: _dev, ...plain } = machine as { d?: unknown };
    const actor = createActor(plain as unknown as __Compiled);
    let sent = 0;
    actor.subscribe((s) => {
      if (s.state === "counting" && sent < 3) {
        sent++;
        actor.send({ type: "tick" });
      }
    });
    expect(actor.send({ type: "go" }).ok).toBe(true);
    expect(actor.snapshot()).toMatchObject({ state: "counting", data: { n: 3 } });
    actor.stop();
  });
});

// The dev runner map wraps effects.q's sendTo: a child by name that isn't running is a dropped
// event, which a development build says out loud. A production build's map is effects.q itself.
const { __effects } = await import("../src/dev.ts");
const { effects } = await import("@reactre/state/effects");

describe("M149: enq.sendTo to a child that isn't running", () => {
  const ctx = (child: ((n: string, k?: string) => unknown) | undefined) =>
    ({
      live: { works: new Map([["", [{ id: "c", work: { child } }]]]) },
      now: () => 0,
    }) as unknown as Parameters<NonNullable<typeof effects.q.sendTo>>[1];

  test("a send to a child that isn't running warns, naming the child and the fix", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      __effects(effects.q).sendTo?.({ type: "sendTo", to: "payment", event: { type: "go" } } as never, ctx(undefined));
    } finally {
      console.warn = original;
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('enq.sendTo("payment") found no running child');
    expect(warned[0]).toContain("send it from a state whose children include");
  });

  test("a delayed send warns when it fires with no child, not when it is scheduled", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      __effects(effects.q).sendTo?.(
        { type: "sendTo", to: "payment", event: { type: "go" }, delay: 5 } as never,
        ctx(undefined),
      );
      // Scheduled: nothing said yet, since the child may start before it fires.
      expect(warned).toEqual([]);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.warn = original;
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('enq.sendTo("payment") found no running child');
  });

  test("a delayed send to a child that started before it fires doesn't warn", async () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    let running = false;
    const sent: unknown[] = [];
    try {
      __effects(effects.q).sendTo?.(
        { type: "sendTo", to: "payment", event: { type: "go" }, delay: 5 } as never,
        ctx((n) => (running && n === "payment" ? { send: (e: unknown) => sent.push(e) } : undefined)),
      );
      running = true;
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([]);
    expect(sent).toEqual([{ type: "go" }]);
  });

  test("a send to a running child doesn't warn", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      __effects(effects.q).sendTo?.(
        { type: "sendTo", to: "payment", event: { type: "go" } } as never,
        ctx((n) => (n === "payment" ? { send: () => {} } : undefined)),
      );
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([]);
  });

  test("a send to an actor by reference isn't checked", () => {
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      __effects(effects.q).sendTo?.(
        { type: "sendTo", to: { send: () => {} }, event: { type: "go" } } as never,
        ctx(undefined),
      );
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([]);
  });

  // The real path: the preload plugin compiles ./features/effects/machines.ts with dev on, so the
  // relay's dispatcher gets __effects(effects.q). Its `idle` state has no echo child; `relaying` does.
  test("a compiled dev actor warns for a send to a child that isn't running", async () => {
    const { createActor } = await import("@reactre/state");
    const { relayMachine } = await import("./features/effects/machines.ts");
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      const actor = createActor(relayMachine);
      actor.send({ type: "say", text: "lost" });
      actor.stop();
    } finally {
      console.warn = original;
    }
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('enq.sendTo("echo") found no running child');
  });

  test("a compiled dev actor doesn't warn when the child is running", async () => {
    const { createActor } = await import("@reactre/state");
    const { relayMachine } = await import("./features/effects/machines.ts");
    const warned: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      const actor = createActor(relayMachine);
      actor.send({ type: "open" });
      actor.send({ type: "say", text: "hi" });
      actor.stop();
    } finally {
      console.warn = original;
    }
    expect(warned).toEqual([]);
  });

  test("a production build's runner map is effects.q itself: no wrapper, no warning", () => {
    const code = compile("door.ts", DOOR)?.code ?? "";
    expect(code).not.toContain("@reactre/state/dev");
    expect(code).not.toContain("__reactreStateDevEffects");
  });
});

describe("M51 on a compiled development machine", () => {
  // The real path: the preload plugin compiles the fixture with dev on, so its table's `d` is
  // @reactre/state/dev's __freeze, which carries `round`. A listener that sends on every snapshot
  // throws S29 instead of hanging.
  // The editor's `write` stays in `edit.draft` with new data, so a listener that sends it on every
  // snapshot never rests.
  test("a compiled dev machine's listener loop throws S29", async () => {
    const { createActor } = await import("@reactre/state");
    const { editorMachine } = await import("./fixtures/editor.ts");
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.subscribe(() => actor.send({ type: "write", text: "x" }));
    expect(() => actor.send({ type: "write", text: "x" })).toThrow(/S29\] a listener sent an event on every snapshot/);
    actor.stop();
  });

  test("a compiled dev machine's finite listener chain is told", async () => {
    const { createActor } = await import("@reactre/state");
    const { editorMachine } = await import("./fixtures/editor.ts");
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    const seen: string[] = [];
    let sent = false;
    actor.subscribe((s) => {
      seen.push(s.state);
      if (!sent) {
        sent = true;
        actor.send({ type: "write", text: "y" });
      }
    });
    expect(actor.send({ type: "write", text: "x" }).ok).toBe(true);
    expect(seen).toEqual(["edit.draft", "edit.draft"]);
    actor.stop();
  });
});

describe("the compiled dev value", () => {
  // The compiler emits `d: __reactreStateFreeze`, the import from @reactre/state/dev. That value
  // carries `round` and `dead`, so a compiled development machine's `m.d.round` is there.
  test("the value the compiler emits as d carries round and dead", async () => {
    const { __freeze } = await import("../src/dev.ts");
    expect(typeof __freeze.round).toBe("function");
    expect(typeof __freeze.dead).toBe("function");
    const code = compile("door.ts", DOOR, { dev: true })?.code ?? "";
    expect(code).toContain("d: __reactreStateFreeze");
    expect(code).toContain('import { __freeze as __reactreStateFreeze } from "@reactre/state/dev";');
  });
});

describe("a production build", () => {
  test("imports none of it: no freeze, no S3", () => {
    const code = compile("door.ts", DOOR)?.code ?? "";
    expect(code).not.toContain("@reactre/state/dev");
    expect(code).not.toContain("__reactreStateFreeze");
    expect(code).not.toContain("S3");
  });
});
