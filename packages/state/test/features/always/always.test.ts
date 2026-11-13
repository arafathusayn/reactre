// always: eventless transitions, compiled as a build compiles them.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor, initial, StateError, transition } = await import("@reactre/state");
const { cartMachine, editorMachine, loopMachine } = await import("./machines.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("always", () => {
  optIn("always");

  test("compiles to al and a graph that wraps the one before it (flat: none)", () => {
    const code =
      compile(
        "door.ts",
        change(
          withUse(["always"]),
          "open: { on:",
          'open: { always: ({ data, to }) => (data.by === "" ? to("closed") : null), on:',
        ),
      )?.code ?? "";
    expect(code).toContain(
      'al: { "open": (data) => (data.by === "" ? ({ state: "closed", data: __reactreStateNone, version: 0 }) : null) }',
    );
    expect(code).toContain("g: always.g()");
  });

  test("an always moves on in the same step, and null rests", () => {
    const s0 = initial(cartMachine, undefined);
    expect(s0).toEqual({ state: "filling", data: { n: 2 }, version: 0 });
    const r = transition(cartMachine, s0, { type: "add" });
    expect(r).toMatchObject({ ok: true, snapshot: { state: "full", data: { n: 3 } } });
  });

  test("an actor never shows the in-between state", () => {
    const actor = createActor(cartMachine);
    const seen: string[] = [];
    actor.subscribe((s) => seen.push(s.state));
    actor.send({ type: "add" });
    actor.send({ type: "empty" });
    expect(seen).toEqual(["full", "filling"]);
  });

  test("a parent's always runs for its leaves, after events and after a timer", async () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "write", text: "hello world" });
    expect(actor.snapshot()).toMatchObject({ state: "edit.long", data: { text: "hello world" } });
    await wait(30);
    expect(actor.snapshot().state).toBe("saved");
  });

  test("a loop throws S50 instead of hanging", () => {
    const s0 = initial(loopMachine, undefined);
    expect(() => transition(loopMachine, s0, { type: "go" })).toThrow(StateError);
    expect(() => transition(loopMachine, s0, { type: "go" })).toThrow(
      /\[@reactre\/state S50\] eventless transitions moved 100 times without resting, last into "[^"]+": an always must rest once it moved \(check its data\); a choice or a parent's done must not loop$/,
    );
  });
});
