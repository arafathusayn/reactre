// Nested states, history and parallel states, on machines compiled as a build compiles them
// (./compiled.ts registers the plugin): bubbling, entry and exit, `back`, and regions.

import { describe, expect, test } from "bun:test";

import "./compiled.ts";

import type { __Compiled, MachineInfo, Snapshot } from "@reactre/state";

import { to } from "./to.ts";

/** A snapshot read back from JSON, typed as the machine's: restoreActor checks it at runtime. */
type Stored<M> = Snapshot<MachineInfo<M>["shape"]>;

const { createActor, initial, isIn, restoreActor, StateError, transition } = await import("@reactre/state");
const { __graph, __nested } = await import("@reactre/state/nested");
const { __run } = await import("@reactre/state/run");
const { __tasks } = await import("@reactre/state/tasks");
const { editorMachine } = await import("./fixtures/editor.ts");
const { checkoutMachine, playerMachine } = await import("./fixtures/player.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("nested states", () => {
  test("an event goes to the leaf, then its parents: the parent's handler applies to every leaf", () => {
    const draft = transition(editorMachine, initial(editorMachine, undefined), { type: "open" }).snapshot;
    expect(draft).toMatchObject({ state: "edit.draft", data: { text: "" } });
    // "edit.draft" has no `cancel`: its parent's does it.
    expect(transition(editorMachine, draft, { type: "cancel" }).snapshot.state).toBe("idle");
  });

  test("a parent's handler narrows on the leaf, and its null declines", () => {
    const draft = transition(editorMachine, initial(editorMachine, undefined), { type: "open" }).snapshot;
    const more = transition(editorMachine, draft, { type: "write", text: "hi" });
    expect(more).toMatchObject({ ok: true, snapshot: { state: "edit.draft", data: { text: "hi" } } });
    const review = transition(editorMachine, more.snapshot, { type: "submit", by: "ann" }).snapshot;
    expect(transition(editorMachine, review, { type: "write", text: "!" })).toMatchObject({
      ok: false,
      reason: "declined",
    });
    expect(transition(editorMachine, review, { type: "open" })).toMatchObject({ ok: false, reason: "unhandled" });
  });

  test("a leaf's null bubbles on to its parent", () => {
    const draft = transition(editorMachine, initial(editorMachine, undefined), { type: "open" }).snapshot;
    const byAnn = transition(editorMachine, draft, { type: "submit", by: "ann" }).snapshot;
    const byBoss = transition(editorMachine, draft, { type: "submit", by: "boss" }).snapshot;
    expect(transition(editorMachine, byAnn, { type: "cancel" }).snapshot.state).toBe("edit.draft");
    expect(transition(editorMachine, byBoss, { type: "cancel" }).snapshot.state).toBe("idle");
  });

  test("isIn narrows to the leaves under a parent", () => {
    const actor = createActor(editorMachine);
    const s0 = actor.snapshot();
    expect(isIn(s0, "edit")).toBe(false);
    actor.send({ type: "open" });
    const s1 = actor.snapshot();
    if (!isIn(s1, "edit")) throw new Error("not in edit");
    // Narrowed: every leaf under "edit" has text.
    expect(s1.data.text).toBe("");
    actor.stop();
  });

  test("a parent's timer keeps running while its leaves change, and stops when it exits", async () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    await wait(15);
    actor.send({ type: "write", text: "a" }); // the same leaf: it stays
    actor.send({ type: "submit", by: "ann" }); // another leaf under "edit": the parent stays
    await wait(15);
    expect(actor.snapshot().state).toBe("edit.review");
    await wait(25); // 40ms after "edit" was entered, not after the last move
    expect(actor.snapshot().state).toBe("away");

    actor.send({ type: "resume" }); // back to "edit.review", by ann
    actor.send({ type: "cancel" }); // the review's own cancel: back to the draft
    actor.send({ type: "cancel" }); // the draft has none: the parent's, to idle
    await wait(50);
    expect(actor.snapshot().state).toBe("idle"); // the timer stopped when "edit" exited
  });
});

describe("history", () => {
  test("back goes to the leaf the parent held when it was last left, with its data", () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "write", text: "hello" });
    actor.send({ type: "submit", by: "ann" });
    actor.send({ type: "leave" });
    expect(actor.snapshot()).toEqual({
      state: "away",
      data: {},
      version: 0,
      history: { edit: { state: "edit.review", data: { text: "hello", by: "ann" } } },
    });
    actor.send({ type: "resume" });
    expect(actor.snapshot()).toMatchObject({ state: "edit.review", data: { text: "hello", by: "ann" } });
    actor.stop();
  });

  test("back takes the fallback when the parent was never left", () => {
    const away = { state: "away", data: {}, version: 0, history: {} } as const;
    expect(transition(editorMachine, away, { type: "resume" }).snapshot).toEqual({
      state: "edit.draft",
      data: { text: "" },
      version: 0,
      history: {},
    });
  });

  test("history is part of the snapshot: JSON, and restored", () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "write", text: "x" });
    actor.send({ type: "leave" });
    const saved: Stored<typeof editorMachine> = JSON.parse(JSON.stringify(actor.snapshot()));
    actor.stop();
    const restored = restoreActor(editorMachine, saved);
    restored.send({ type: "resume" });
    expect(restored.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "x" } });
    restored.stop();
  });

  test("restoring a parent's name is refused, naming the leaves", () => {
    const old: Stored<typeof editorMachine> = JSON.parse('{"state":"edit","data":{},"version":0}');
    expect(() => restoreActor(editorMachine, old)).toThrow(
      /S1\].*no state "edit"\. The states are: idle, edit\.draft, edit\.review, away, sent\./,
    );
  });

  // M187: a rename leaves the saved history pointing at a state the machine no longer has, and
  // `back` would fall back silently. Refused as S1, naming the parent and the leaf.
  test("M187: a saved history leaf the machine lacks is refused as S1, naming the parent", () => {
    const old: Stored<typeof editorMachine> = JSON.parse(
      '{"state":"away","data":{},"version":0,"history":{"edit":{"state":"edit.gone","data":{}}}}',
    );
    expect(() => restoreActor(editorMachine, old)).toThrow(StateError);
    expect(() => restoreActor(editorMachine, old)).toThrow(
      /S1\] the saved history of "edit" holds "edit\.gone", which isn't a state of this machine/,
    );
    expect(() => restoreActor(editorMachine, old)).toThrow(/Migrate the saved snapshot/);
  });

  test("M187: a saved history leaf the machine has restores, and back goes to it", () => {
    const saved: Stored<typeof editorMachine> = JSON.parse(
      '{"state":"away","data":{},"version":0,"history":{"edit":{"state":"edit.draft","data":{"text":"x"}}}}',
    );
    const restored = restoreActor(editorMachine, saved);
    restored.send({ type: "resume" });
    expect(restored.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "x" } });
    restored.stop();
  });
});

describe("parallel states", () => {
  test("entering a parallel node puts each region in its leaf", () => {
    const on = transition(playerMachine, initial(playerMachine, undefined), { type: "power" }).snapshot;
    expect(on).toEqual({
      state: "on",
      data: {
        playback: { state: "on.playback.stopped", data: {} },
        volume: { state: "on.volume.audible", data: { level: 5 } },
      },
      version: 0,
    });
  });

  test("a step in one region moves that region only", () => {
    const actor = createActor(playerMachine);
    actor.send({ type: "power" });
    const before = actor.snapshot();
    actor.send({ type: "play", track: "a" });
    const after = actor.snapshot();
    if (after.state !== "on" || before.state !== "on") throw new Error("not on");
    expect(after.data.playback).toEqual({ state: "on.playback.playing", data: { track: "a" } });
    expect(after.data.volume).toBe(before.data.volume);
    actor.send({ type: "mute" });
    expect(actor.snapshot()).toMatchObject({
      data: { playback: { state: "on.playback.playing" }, volume: { state: "on.volume.muted", data: { level: 5 } } },
    });
    actor.stop();
  });

  test("an event no region takes goes to the parallel node, and one nobody takes is unhandled", () => {
    const on = transition(playerMachine, initial(playerMachine, undefined), { type: "power" }).snapshot;
    expect(transition(playerMachine, on, { type: "unmute" })).toMatchObject({ ok: false, reason: "unhandled" });
    expect(transition(playerMachine, on, { type: "power" }).snapshot).toEqual({ state: "off", data: {}, version: 0 });
  });

  test("when every region is in a final leaf, done decides where to go", () => {
    const actor = createActor(checkoutMachine);
    actor.send({ type: "pay" });
    actor.send({ type: "card", last4: "4242" });
    expect(actor.snapshot()).toMatchObject({ state: "paying", data: { card: { state: "paying.card.ok" } } });
    // A region in a final leaf has ended: it takes no more events.
    expect(actor.send({ type: "card", last4: "0000" })).toMatchObject({ ok: false, reason: "unhandled" });
    actor.send({ type: "address", city: "Dhaka" });
    expect(actor.snapshot()).toEqual({ state: "paid", data: { last4: "4242", city: "Dhaka" }, version: 0 });
    expect(actor.status()).toBe("done");
  });

  test("a parallel snapshot restores, and a region in a leaf it lacks is refused", () => {
    const saved = {
      state: "on",
      data: {
        playback: { state: "on.playback.playing", data: { track: "b" } },
        volume: { state: "on.volume.muted", data: { level: 2 } },
      },
      version: 0,
    } as const;
    const stored: Stored<typeof playerMachine> = JSON.parse(JSON.stringify(saved));
    const actor = restoreActor(playerMachine, stored);
    actor.send({ type: "stop" });
    expect(actor.snapshot()).toMatchObject({ data: { playback: { state: "on.playback.stopped" } } });
    const wrong: Stored<typeof playerMachine> = JSON.parse(
      JSON.stringify({ ...saved, data: { ...saved.data, volume: { state: "on.playback.stopped", data: {} } } }),
    );
    expect(() => restoreActor(playerMachine, wrong)).toThrow(
      /S1\].*no state "on\.playback\.stopped" in a region of "on"/,
    );
  });

  test("a region's timer reads its own leaf, and a move to the same leaf keeps it running", async () => {
    // Written by hand as the compiler writes it: a region leaf with a 30ms timer.
    const m: __Compiled = {
      v: 0,
      e: { bump: 1 },
      i: () => to("p", { a: to("p.a.x", { n: 1 }), b: to("p.b.y") }),
      o: {
        "p.a.x": { bump: (data) => to("p.a.x", { n: Number(Reflect.get(Object(data), "n")) + 1 }) },
        "p.b.y": {},
        done: {},
      },
      a: { "p.a.x": [[30, (data, state) => to("done", { seen: [state, data] })]] },
      p: { p: ["a", "b"] },
      f: { done: 1 },
      g: __graph,
      y: __nested,
      r: __run([__tasks]),
    };
    const actor = createActor(m);
    await wait(15);
    actor.send({ type: "bump" });
    await wait(25);
    expect(actor.snapshot()).toEqual({ state: "done", data: { seen: ["p.a.x", { n: 2 }] }, version: 0 });
  });
});
