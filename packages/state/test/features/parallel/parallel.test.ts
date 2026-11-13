// parallel, compiled: regions in `p`, a parallel node's `done` in `n`, a step per region. The
// runtime is tested on hand-written tables in test/nested.test.ts, and compiled in
// test/actor.test.ts's fixtures.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import { PLAYER } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

describe("parallel", () => {
  optIn("parallel");

  test("a parallel node's regions and done go in the table, beside nested's hooks", () => {
    const code = compile("player.ts", PLAYER)?.code ?? "";
    expect(code).toContain('g: nested.g, p: { "on": ["a","b"] }, n: { "on": ');
    expect(code).toContain("y: nested.y");
  });

  test("a to(...) for a region with the node missing from setup's parallel fails closed", () => {
    // The type checker reports this (a region's `to` takes one argument, and the node's data has no
    // such field), so the compiler doesn't repeat it. But it must not emit the raw `to(...)` calls
    // either: the handler declines, so the output has no `to(` in it.
    const source = PLAYER.replace('  parallel: ["on"],\n', "");
    const code = compile("player.ts", source)?.code ?? "";
    expect(code).not.toMatch(/\bto\(/);
    // The correct machine still compiles its regions to steps.
    expect(compile("player.ts", PLAYER)?.code).toContain('"power": () => ({ state: "on", data: { "a": ');
  });

  describe("a parallel node inside another's region", () => {
    const load = async () => {
      await import("../../compiled.ts");
      const { createActor } = await import("@reactre/state");
      const { studioMachine } = await import("./machines.ts");
      const actor = createActor(studioMachine);
      actor.send({ type: "power" });
      actor.send({ type: "load" });
      return actor;
    };

    test("is the region's unit, entered with a step for each of its regions", async () => {
      const actor = await load();
      expect(actor.snapshot()).toEqual({
        state: "on",
        data: {
          media: {
            state: "on.media.player",
            data: {
              track: { state: "on.media.player.track.stopped", data: {} },
              volume: { state: "on.media.player.volume.level", data: { level: 5 } },
            },
          },
          chat: { state: "on.chat.closed", data: {} },
        },
        version: 0,
      });
    });

    test("its regions and the outer node's take events side by side; its own handler leaves it", async () => {
      const actor = await load();
      actor.send({ type: "play", title: "a" });
      actor.send({ type: "chat" });
      const s = actor.snapshot();
      expect(s.state === "on" && s.data.chat.state).toBe("on.chat.open");
      expect(s.state === "on" && s.data.media.state === "on.media.player" && s.data.media.data.track).toEqual({
        state: "on.media.player.track.playing",
        data: { title: "a" },
      });
      actor.send({ type: "eject" });
      const after = actor.snapshot();
      expect(after.state === "on" && after.data.media).toEqual({ state: "on.media.idle", data: {} });
      expect(after.state === "on" && after.data.chat.state).toBe("on.chat.open");
    });

    test("its done runs when all its regions end, inside the outer node", async () => {
      const actor = await load();
      actor.send({ type: "play", title: "a" });
      actor.send({ type: "end" });
      const one = actor.snapshot();
      expect(one.state === "on" && one.data.media.state).toBe("on.media.player");
      actor.send({ type: "mute" });
      const s = actor.snapshot();
      expect(s.state === "on" && s.data.media).toEqual({ state: "on.media.finished", data: {} });
      actor.send({ type: "power" });
      expect(actor.snapshot().state).toBe("off");
    });

    test("restoreActor takes a snapshot with a nested parallel node in a region", async () => {
      const actor = await load();
      const { restoreActor } = await import("@reactre/state");
      const { studioMachine } = await import("./machines.ts");
      const saved: ReturnType<typeof actor.snapshot> = JSON.parse(JSON.stringify(actor.snapshot()));
      const again = restoreActor(studioMachine, saved);
      again.send({ type: "mute" });
      const s = again.snapshot();
      expect(s.state === "on" && s.data.media.state === "on.media.player" && s.data.media.data.volume.state).toBe(
        "on.media.player.volume.muted",
      );
    });
  });
});
