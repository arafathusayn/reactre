// effects: `entry`, `exit`, and `enq` in handlers, recorded as data during the pure transition and
// run after it by the runners the features in use register (src/internal.ts, "The effect registry").
// The machines are in ./machines.ts, compiled by the preload plugin as a build would.

import { beforeEach, describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, DOOR, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor, StateError, transition } = await import("@reactre/state");
const { initialTransition } = await import("@reactre/state/effects");
const { child } = await import("@reactre/state/children");
const { doorMachine, editorMachine, loaderMachine, relayMachine, seen } = await import("./machines.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const closed = { state: "closed", data: {}, version: 0 } as const;

beforeEach(() => {
  seen.length = 0;
});

describe("effects", () => {
  optIn("effects");

  test("a machine that records effects gets the recording step, b, and the dispatcher", () => {
    const source = change(
      withUse(["effects"]),
      'open: { on: { close: ({ to }) => to("closed") } },',
      'open: { entry: ({ enq }) => enq.log("open"), on: { close: ({ enq, to }) => { enq(() => {}); return to("closed"); } } },',
    );
    const code = compile("door.ts", source)?.code ?? "";
    expect(code).toContain('b: { "open": [() => effects.enq.log("open"), 0] }');
    expect(code).toContain("effects.enq(() => {});");
    expect(code).toContain("y: effects.y()");
    expect(code).toContain("r: effects.l(__reactreStateRun([], effects.d([effects.q])))");
  });
});

describe("transition: effects are data, returned unrun", () => {
  test("exits, then the handler's, then entries, and nothing runs", () => {
    const r = transition(doorMachine, closed, { type: "push", by: "ann" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot).toEqual({ state: "open", data: { by: "ann" }, version: 0 });
    expect(r.fx.map((e) => e.type)).toEqual(["fn", "fn", "sendTo", "effect"]);
    expect(r.fx[1]).toMatchObject({ type: "fn", args: ["ann"] });
    expect(r.fx[2]).toMatchObject({ type: "sendTo", event: { type: "ping", from: "ann" } });
    expect(r.fx[3]).toMatchObject({ type: "effect", node: "open" });
    expect(seen).toEqual([]);
  });

  test("a raised event is handled in the same step: the result is where it ends", () => {
    const r = transition(doorMachine, closed, { type: "arm" });
    expect(r).toEqual({
      ok: true,
      snapshot: { state: "alarmed", data: { n: 1 }, version: 0 },
      fx: [expect.objectContaining({ type: "fn" }), { type: "log", values: ["ring", 1] }],
    });
  });

  test("a delayed raise is an effect like the others, with its delay and id", () => {
    const r = transition(doorMachine, closed, { type: "wait" });
    const fx: unknown = r.ok && r.fx;
    expect(fx).toEqual([
      { type: "cancel", id: "later" },
      { type: "raise", event: { type: "ring", n: 2 }, delay: 20, id: "later" },
    ]);
  });

  test("a raise loop throws S61, naming the event", () => {
    expect(() => transition(doorMachine, closed, { type: "loop" })).toThrow(StateError);
    expect(() => transition(doorMachine, closed, { type: "loop" })).toThrow(/S61.*"loop"/);
  });

  test("a declined or unhandled event records nothing", () => {
    expect(transition(doorMachine, closed, { type: "close" })).toEqual({
      ok: false,
      reason: "unhandled",
      snapshot: closed,
    });
  });

  test("initialTransition: the start's snapshot and its entries' effects, unrun", () => {
    const { snapshot, fx } = initialTransition(doorMachine, undefined);
    expect(snapshot).toEqual(closed);
    expect(fx.map((e) => e.type)).toEqual(["fn"]);
    expect(seen).toEqual([]);
  });

  test("in a hierarchy: exits innermost first, entries outermost first, a parent that stays does neither", () => {
    const start = { state: "idle", data: {}, version: 0 } as const;
    const open = transition(editorMachine, start, { type: "open" });
    if (!open.ok) throw new Error("open");
    for (const e of open.fx) if (e.type === "fn") e.fn();
    expect(seen).toEqual(["exit idle", "enter edit at edit.draft", "enter draft"]);
    seen.length = 0;
    const review = transition(editorMachine, open.snapshot, { type: "submit" });
    if (!review.ok) throw new Error("submit");
    for (const e of review.fx) if (e.type === "fn") e.fn();
    expect(seen).toEqual(["exit draft", "enter review"]);
  });
});

describe("an actor runs them after each move", () => {
  test("the start's entries, then each move's, in order", () => {
    const actor = createActor(doorMachine);
    expect(seen).toEqual(["enter closed"]);
    actor.send({ type: "push", by: "ann" });
    expect(seen).toEqual(["enter closed", "exit closed", "push ann", "ping ann", "open by ann"]);
    actor.send({ type: "close" });
    expect(seen.slice(5)).toEqual(["cleanup ann", "enter closed"]);
  });

  test("a listener sees only where a step with raised events ends", () => {
    const actor = createActor(doorMachine);
    const states: string[] = [];
    actor.subscribe((s) => states.push(s.state));
    actor.send({ type: "arm" });
    expect(states).toEqual(["alarmed"]);
  });

  test("a delayed raise arrives later, and cancel stops it", async () => {
    const actor = createActor(doorMachine);
    actor.send({ type: "wait" });
    await tick(40);
    expect(actor.snapshot()).toEqual({ state: "alarmed", data: { n: 2 }, version: 0 });

    const other = createActor(doorMachine);
    other.send({ type: "wait" });
    other.send({ type: "disarm" });
    await tick(40);
    expect(other.snapshot().state).toBe("closed");
  });

  test("a delayed raise survives a move, and stops with the actor", async () => {
    const moved = createActor(doorMachine);
    moved.send({ type: "wait" });
    moved.send({ type: "push", by: "bob" });
    moved.send({ type: "close" });
    await tick(40);
    expect(moved.snapshot().state).toBe("alarmed");

    const stopped = createActor(doorMachine);
    stopped.send({ type: "wait" });
    stopped.stop();
    await tick(40);
    expect(stopped.snapshot().state).toBe("closed");
  });

  test("an effect's cleanup: its node's exit (from entry), or the actor's stop (from a handler)", () => {
    const actor = createActor(doorMachine);
    actor.send({ type: "push", by: "ann" });
    actor.stop();
    expect(seen).toContain("cleanup ann");

    seen.length = 0;
    const alarmed = createActor(doorMachine);
    alarmed.send({ type: "arm" });
    alarmed.send({ type: "close" });
    expect(seen).not.toContain("cleanup actor");
    alarmed.stop();
    expect(seen).toContain("cleanup actor");
  });

  test("an event the start's entry raises is handled as the actor starts", () => {
    const states: string[] = [];
    const actor = createActor(loaderMachine);
    actor.subscribe((s) => states.push(s.state));
    expect(actor.snapshot()).toEqual({ state: "ready", data: {}, version: 0 });
    expect(initialTransition(loaderMachine, undefined).snapshot.state).toBe("ready");
    expect(states).toEqual([]);
  });

  test("enq.sendTo a child by its name reaches it; a child that isn't running drops it", () => {
    const actor = createActor(relayMachine);
    expect(actor.send({ type: "say", text: "lost" }).ok).toBe(true);
    actor.send({ type: "open" });
    expect(child(actor, "echo")?.snapshot().data).toEqual({ heard: "" });
    actor.send({ type: "say", text: "hi" });
    expect(child(actor, "echo")?.snapshot().data).toEqual({ heard: "hi" });
  });

  test("in a hierarchy, the actor runs entries and exits as transition returns them", () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "submit" });
    actor.send({ type: "leave" });
    expect(seen).toEqual([
      "exit idle",
      "enter edit at edit.draft",
      "enter draft",
      "exit draft",
      "enter review",
      "exit edit",
    ]);
  });
});

describe("the compiler", () => {
  test("a function handed to enq is the effect: it may read globals; the rest of the handler is checked", () => {
    const source = change(
      withUse(["effects"]),
      'open: { on: { close: ({ to }) => to("closed") } },',
      'open: { on: { close: ({ enq, to }) => { enq(() => console.log(Date.now())); return to("closed"); } } },',
    );
    expect(compile("door.ts", source)?.code).toContain("effects.enq(() => console.log(Date.now()));");
  });

  test("listing effects on a machine that records nothing adds nothing", () => {
    expect(compile("door.ts", withUse(["effects"]))?.code).not.toContain("effects.");
    expect(compile("door.ts", DOOR)?.code).not.toContain("effects.");
  });

  test("a development build wraps the runner map so a dead sendTo warns; production ships it plain", () => {
    // A machine that records an effect: its dispatcher's runner map is `effects.q`.
    const source = change(
      withUse(["effects"]),
      'open: { on: { close: ({ to }) => to("closed") } },',
      'open: { on: { close: ({ enq, to }) => { enq.log("x"); return to("closed"); } } },',
    );
    const prod = compile("door.ts", source, { dev: false })?.code ?? "";
    const dev = compile("door.ts", source, { dev: true })?.code ?? "";
    // Production: the map itself, and no dev import.
    expect(prod).toContain("effects.d([effects.q])");
    expect(prod).not.toContain("__reactreStateDevEffects");
    expect(prod).not.toContain("@reactre/state/dev");
    // Development: the wrapper, and its import.
    expect(dev).toContain("effects.d([__reactreStateDevEffects(effects.q)])");
    expect(dev).toContain('import { __effects as __reactreStateDevEffects } from "@reactre/state/dev";');
  });
});

// The runner registry: a runner for each effect a feature records; one with none throws S60.
describe("the dispatcher", () => {
  test("an effect with no runner throws S60, naming the feature to add", async () => {
    const { effects } = await import("@reactre/state/effects");
    const dispatch = effects.d([effects.q]);
    const live = { m: doorMachine, enter: () => {}, stop: () => {} };
    const ctx = { deliver: () => null, go: () => {}, now: Date.now, snapshot: closed, live };
    expect(() => dispatch([{ type: "emit" }], ctx)).toThrow(/S60.*add emit to setup's use/);
    // A step's effects (the snapshot it settled) run as they are.
    await tick();
  });
});
