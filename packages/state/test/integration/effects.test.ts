// Effects in a parallel machine, compiled: each region's entry and exit effects are its own, the
// parallel node's run around them, and a region's move doesn't re-run the other region's. The
// machine is ./fixtures/effects/parallel.ts, compiled by the plugin.

import { beforeEach, describe, expect, test } from "bun:test";

import "../compiled.ts";

const { createActor } = await import("@reactre/state");
const { playerMachine, seen } = await import("./fixtures/effects/parallel.ts");

beforeEach(() => {
  seen.length = 0;
});

describe("effects in a parallel machine", () => {
  test("entering the parallel node runs its entry, then each region's, in order", () => {
    const actor = createActor(playerMachine);
    expect(seen).toEqual(["enter off"]);
    actor.send({ type: "power" });
    // The exits, then the handler's effect, then the entries outermost first: the parallel node,
    // then its regions in the order the snapshot lists them.
    expect(seen).toEqual(["enter off", "exit off", "power", "enter on", "enter stopped", "enter audible"]);
    actor.stop();
  });

  test("a region's move runs only that region's effects, not the other's", () => {
    const actor = createActor(playerMachine);
    actor.send({ type: "power" });
    seen.length = 0;
    actor.send({ type: "play", track: "a" });
    // playback's exit and entry; volume's stay, so its effects don't run.
    expect(seen).toEqual(["exit stopped", "play a"]);
    seen.length = 0;
    actor.send({ type: "mute" });
    expect(seen).toEqual(["exit audible", "enter muted"]);
    actor.stop();
  });

  test("an effect's cleanup runs when its region exits, and the parallel node's exit runs after its regions'", () => {
    const actor = createActor(playerMachine);
    actor.send({ type: "power" });
    actor.send({ type: "play", track: "a" });
    seen.length = 0;
    actor.send({ type: "power" });
    // The regions exit innermost first, then the parallel node, then off's entry: the playing
    // effect's cleanup is its region's exit.
    expect(seen).toEqual(["stop a", "exit audible", "exit on", "enter off"]);
    actor.stop();
  });

  test("stopping the actor runs the live effects' cleanups", () => {
    const actor = createActor(playerMachine);
    actor.send({ type: "power" });
    actor.send({ type: "play", track: "b" });
    seen.length = 0;
    actor.stop();
    expect(seen).toEqual(["stop b"]);
  });
});
