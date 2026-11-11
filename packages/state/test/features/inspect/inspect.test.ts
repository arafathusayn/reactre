// inspect: `inspect` and `logger` see an actor start, each event it steps (taken or refused), each
// move, and its stop; a child reports with its path as id. Compiled fixtures (./fixture.ts).

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";

import { optIn } from "../opt-in.ts";

const { createActor, transition } = await import("@reactre/state");
const { lightMachine, pageMachine } = await import("./fixture.ts");
const { child } = await import("@reactre/state/children");

type Seen = { readonly type: string; readonly id: string; readonly [k: string]: unknown };

describe("inspect", () => {
  // Listed, it is used: it wraps the step and the lifecycle (the lean one, for the job).
  optIn("inspect", {
    door: ["y: inspect.y()", "r: inspect.w()"],
    job: ["y: inspect.y()", "r: inspect.w(__reactreStateLean)"],
  });

  test("an inspector sees the start, each event with what it did, each move, and the stop", () => {
    const seen: Seen[] = [];
    const actor = createActor(lightMachine, { inspect: (e) => seen.push(e) });
    actor.send({ type: "flip" });
    actor.stop();
    expect(seen.map((e) => [e.type, e.id])).toEqual([
      ["actor", "root"],
      ["event", "root"],
      ["transition", "root"],
      ["stop", "root"],
    ]);
    expect(seen[1]).toMatchObject({ event: { type: "flip" }, internal: false, ok: true, snapshot: { state: "on" } });
    expect(seen[2]).toMatchObject({ snapshot: { state: "on" }, effects: [] });
    expect(seen[3]).toMatchObject({ status: "stopped", snapshot: { state: "on" } });
  });

  test("a refused event is reported with its reason, and moves nothing", () => {
    const seen: Seen[] = [];
    const actor = createActor(pageMachine, { inspect: (e) => seen.push(e), id: "page" });
    actor.send({ type: "cancel" });
    expect(seen.at(-1)).toMatchObject({ type: "event", id: "page", ok: false, reason: "unhandled" });
    expect(seen.filter((e) => e.type === "transition")).toEqual([]);
  });

  test("a child inherits the inspector, with its path as id; its end is a stop with status done", () => {
    const seen: Seen[] = [];
    const actor = createActor(pageMachine, { inspect: (e) => seen.push(e) });
    actor.send({ type: "pick", name: "a.png" });
    child(actor, "upload")?.send({ type: "ack" });
    expect(actor.snapshot().state).toBe("done");
    expect(seen.map((e) => `${e.type} ${e.id}`)).toEqual([
      "actor root",
      "event root",
      // The move, then the child it started.
      "transition root",
      "actor root/upload",
      "event root/upload",
      "transition root/upload",
      "stop root/upload",
      "transition root",
    ]);
    expect(seen[3]).toMatchObject({ parent: "root", snapshot: { state: "sending", data: { name: "a.png" } } });
    expect(seen[6]).toMatchObject({ status: "done", snapshot: { state: "sent" } });
  });

  test("logger gets each as a readable line", () => {
    const lines: string[] = [];
    const actor = createActor(pageMachine, { logger: (line) => lines.push(line) });
    actor.send({ type: "pick", name: "a.png" });
    actor.send({ type: "pick", name: "b.png" });
    actor.stop();
    expect(lines).toEqual([
      "[root] started in idle",
      "[root] pick → uploading",
      "[root/upload] started in sending (child of root)",
      "[root] pick refused: unhandled",
      "[root/upload] stopped in sending",
      "[root] stopped in uploading",
    ]);
  });

  test("an inspector that throws doesn't stop the actor: its error is rethrown in a microtask", () => {
    const rethrown: (() => void)[] = [];
    const queue = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (f) => rethrown.push(f);
    try {
      const lines: string[] = [];
      const actor = createActor(lightMachine, {
        inspect: () => {
          throw new Error("inspector");
        },
        logger: (line) => lines.push(line),
      });
      actor.send({ type: "flip" });
      expect(actor.snapshot().state).toBe("on");
      expect(lines).toEqual(["[root] started in off", "[root] flip → on"]);
    } finally {
      globalThis.queueMicrotask = queue;
    }
    expect(rethrown.length).toBe(3);
    expect(() => rethrown[0]?.()).toThrow("inspector");
  });

  test("transition() from a live actor's snapshot is reported to it; without an inspector, nothing is", () => {
    const seen: Seen[] = [];
    const actor = createActor(lightMachine, { inspect: (e) => seen.push(e) });
    transition(lightMachine, actor.snapshot(), { type: "flip" });
    expect(seen.at(-1)).toMatchObject({ type: "event", ok: true, snapshot: { state: "on" } });
    // The actor itself didn't move.
    expect(actor.snapshot().state).toBe("off");
    const quiet = createActor(lightMachine);
    expect(quiet.send({ type: "flip" }).ok).toBe(true);
    quiet.stop();
    expect(quiet.status()).toBe("stopped");
    expect(seen.filter((e) => e.type === "stop")).toEqual([]);
  });
});
