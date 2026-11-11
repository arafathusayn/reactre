// emit: `enq.emit(event)` in handlers, and `on(actor, type | "*", listener)` in the app; `trigger`.
// The machine is ../effects/machines.ts's player, compiled by the preload plugin.

import { describe, expect, spyOn, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor, StateError, transition } = await import("@reactre/state");
const { on, trigger } = await import("@reactre/state/emit");
const { doorMachine, playerMachine } = await import("../effects/machines.ts");

describe("emit", () => {
  optIn("emit");

  test("with effects recording, the emit runner joins the dispatcher, and enq gets emit", () => {
    const source = change(
      withUse(["effects", "emit"]),
      'open: { on: { close: ({ to }) => to("closed") } },',
      'open: { on: { close: ({ enq, to }) => { enq.emit({ type: "shut" }); return to("closed"); } } },',
    );
    const code = compile("door.ts", source)?.code ?? "";
    expect(code).toContain("const __reactreStateEnq_door = /* @__PURE__ */ effects.w([emit]);");
    expect(code).toContain('__reactreStateEnq_door.emit({ type: "shut" });');
    expect(code).toContain("effects.d([effects.q, emit.q])");
  });

  test("listed on a machine that records nothing, it adds nothing", () => {
    expect(compile("door.ts", withUse(["effects", "emit"]))?.code).not.toContain("emit.q");
  });
});

describe("emitted events", () => {
  test("transition returns them as effects, unrun", () => {
    const r = transition(playerMachine, { state: "paused", data: {}, version: 0 }, { type: "play", track: "a" });
    const fx: unknown = r.ok && r.fx;
    expect(fx).toEqual([{ type: "emit", event: { type: "played", track: "a" } }]);
  });

  test("listeners get them after the move: by type, then '*'; the returned function removes one", () => {
    const actor = createActor(playerMachine);
    const heard: string[] = [];
    on(actor, "played", (event) => heard.push(`played ${event.track} in ${actor.snapshot().state}`));
    const off = on(actor, "*", (event) => heard.push(`* ${event.type}`));
    actor.send({ type: "play", track: "a" });
    expect(heard).toEqual(["played a in playing", "* played"]);
    off();
    actor.send({ type: "pause" });
    expect(heard).toEqual(["played a in playing", "* played"]);
    on(actor, "stopped", () => heard.push("stopped"));
    actor.send({ type: "play", track: "b" });
    actor.send({ type: "pause" });
    expect(heard.slice(2)).toEqual(["played b in playing", "stopped"]);
  });

  test("a listener that throws is reported, and doesn't stop the others or the actor", () => {
    const actor = createActor(playerMachine);
    const heard: string[] = [];
    const reported = spyOn(console, "error").mockImplementation(() => {});
    on(actor, "played", () => {
      throw new Error("listener");
    });
    on(actor, "*", () => heard.push("still"));
    actor.send({ type: "play", track: "a" });
    expect(heard).toEqual(["still"]);
    expect(actor.snapshot().state).toBe("playing");
    expect(reported).toHaveBeenCalledTimes(1);
    reported.mockRestore();
  });

  test("on an actor whose machine has no lifecycle throws S62, naming the imports", async () => {
    const { doorMachine: plain } = await import("../../fixtures/door.ts");
    // A machine the type checker didn't see: no effects, so nothing to listen to.
    const listen = on as unknown as (actor: unknown, type: string, l: () => void) => () => void;
    expect(() => listen(createActor(plain), "x", () => {})).toThrow(StateError);
    expect(() => listen(createActor(plain), "x", () => {})).toThrow(/S62.*import \{ emit \}/);
  });
});

describe("trigger", () => {
  test("is send, by event", () => {
    const actor = createActor(playerMachine);
    expect(trigger(actor).play({ track: "a" })).toMatchObject({ ok: true, snapshot: { state: "playing" } });
    expect(trigger(actor).pause().snapshot.state).toBe("paused");
    const door = createActor(doorMachine);
    expect(trigger(door).push({ by: "ann" }).snapshot).toEqual({ state: "open", data: { by: "ann" }, version: 0 });
  });
});
