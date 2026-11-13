// effects through an actor's life: a declining leaf's effects, a timer's raise settled before the
// listeners hear, a final state's entry, a restore that runs no entry, and persist saving delayed
// raises and delays' timers. The machines are in ./machines.ts.

import { beforeEach, describe, expect, test } from "bun:test";

import "../../compiled.ts";

const { createActor, restoreActor, transition } = await import("@reactre/state");
const { initialTransition } = await import("@reactre/state/effects");
const { migrations, persist } = await import("@reactre/state/persist");
const { bellMachine, doorMachine, keptMachine, seen, treeMachine } = await import("./machines.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  seen.length = 0;
});

describe("effects are the taken handler's", () => {
  test("a leaf that records and declines leaves nothing in its parent's step", () => {
    const { snapshot } = initialTransition(treeMachine, undefined);
    const r = transition(treeMachine, snapshot, { type: "go" });
    if (!r.ok) throw new Error("go");
    expect(r.snapshot.state).toBe("b");
    for (const e of r.fx) if (e.type === "fn") e.fn();
    expect(seen).toEqual(["parent"]);
  });

  test("an actor runs the parent's alone", () => {
    const actor = createActor(treeMachine);
    actor.send({ type: "go" });
    expect(seen).toEqual(["parent"]);
  });
});

describe("a final state's entry", () => {
  test("transition returns it, and the actor runs it as it ends", () => {
    const r = transition(treeMachine, { state: "b", data: {}, version: 0 }, { type: "end" });
    expect(r.ok && r.fx.map((e) => e.type)).toEqual(["fn"]);
    const actor = createActor(treeMachine);
    actor.send({ type: "go" });
    actor.send({ type: "end" });
    expect(actor.status()).toBe("done");
    expect(seen).toEqual(["parent", "enter done"]);
  });
});

describe("a move that isn't a step is settled like one", () => {
  test("a timer's raise is handled before the listeners hear: they hear where it ends, once", async () => {
    const actor = createActor(bellMachine);
    const heard: string[] = [];
    actor.subscribe((s) => heard.push(s.state));
    actor.send({ type: "arm" });
    await tick(30);
    expect(actor.snapshot()).toEqual({ state: "ringing", data: { n: 1 }, version: 0 });
    expect(heard).toEqual(["armed", "ringing"]);
    actor.stop();
  });
});

describe("restore", () => {
  test("runs no entry: the restored node was entered before it was saved", () => {
    const actor = restoreActor(doorMachine, { state: "open", data: { by: "ann" }, version: 0 });
    expect(seen).toEqual([]);
    actor.send({ type: "close" });
    expect(seen).toEqual(["enter closed"]);
  });

  test("persist saves delayed raises and delays' timers with their deadlines; restore keeps the time left", async () => {
    const actor = createActor(keptMachine);
    actor.send({ type: "wait" });
    const saved = JSON.parse(JSON.stringify(persist(actor)));
    actor.stop();
    expect(saved.run.waiting.l).toEqual([expect.any(Number)]);
    expect(saved.run[""]["~fx"]).toEqual([
      { e: { type: "raise", event: { type: "ring", by: "raise" }, delay: 60 }, at: expect.any(Number) },
    ]);
    // 20ms later: the timer (30) has 10 left, the raise (60) 40.
    const restored = restoreActor(keptMachine, migrations(keptMachine)(saved), { now: () => Date.now() + 20 });
    await tick(20);
    expect(restored.snapshot()).toEqual({ state: "rung", data: { by: "timer" }, version: 0 });
    await tick(40);
    expect(restored.snapshot()).toEqual({ state: "rung", data: { by: "raise after" }, version: 0 });
    restored.stop();
  });
});
