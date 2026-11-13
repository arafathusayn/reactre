// persist: an actor's snapshot with what its running nodes saved, through JSON and back into
// restoreActor. On compiled tables written by hand, with a fake clock.

import { describe, expect, test } from "bun:test";

import type { __Compiled, __Runner, __To, Shape } from "@reactre/state";
import { createActor, restoreActor } from "@reactre/state";
import { __saved, persist, type Persisted } from "@reactre/state/persist";
import { __run } from "@reactre/state/run";
import { __tasks } from "@reactre/state/tasks";

import { to } from "./to.ts";

// A cast: these tables are written by hand, without a shape that has persist in its `use`.
const save = persist as unknown as (actor: unknown) => Persisted<Shape>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let clock = 0;
const now = () => clock;

// A parent "trip" (with a 40ms timer that stays) over the leaves "trip.out" and "trip.back"
// (each with a 1h timer), in a node graph written by hand as @reactre/state/nested's would be.
const trip: __Compiled = {
  v: 3,
  e: { go: 1, turn: 1 },
  i: () => to("home", {}, 3),
  o: {
    home: { go: () => to("trip.out", { km: 0 }, 3) },
    trip: {},
    "trip.out": { turn: (data) => to("trip.back", data, 3) },
    "trip.back": {},
  },
  a: {
    trip: [[40, (data, state) => to(state, { km: Number(Reflect.get(Object(data), "km")) + 1 }, 3)]],
    "trip.out": [[3_600_000, () => to("home", {}, 3)]],
    "trip.back": [[3_600_000, () => to("home", {}, 3)]],
  },
  g: {
    nodes: (_, s) => [
      ...(s.state.startsWith("trip.") ? [{ node: "trip", state: s.state, data: s.data }] : []),
      { node: s.state, state: s.state, data: s.data },
    ],
    // This graph's steps are all `to`s: each is its snapshot.
    snap: (_, step) => step as __To,
  },
  // What `use: [persist]` compiles to: the marker, and the tasks runner that saves deadlines.
  u: { persist: 1 },
  r: __run([__saved]),
};

describe("persist", () => {
  test("round-trips through JSON, and the restored timers keep their deadlines", async () => {
    clock = 1000;
    const actor = createActor(trip, { now });
    actor.send({ type: "go" });
    clock = 2000;
    actor.send({ type: "turn" });
    const json = JSON.stringify(save(actor));
    actor.stop();
    expect(JSON.parse(json)).toEqual({
      state: "trip.back",
      data: { km: 0 },
      version: 3,
      // The parent stayed through the turn, so its timer kept its deadline; the new leaf's is fresh.
      run: { trip: { t: [1040] }, "trip.back": { t: [3_602_000] } },
    });

    clock = 2000;
    const stored: Persisted<Shape> = JSON.parse(json);
    const restored = restoreActor(trip, stored, { now });
    // The parent's timer is overdue: it fires at once, and the leaf's keeps its deadline.
    await wait(5);
    expect(restored.snapshot()).toEqual({ state: "trip.back", data: { km: 1 }, version: 3 });
    expect(save(restored).run).toEqual({ trip: { t: [null] }, "trip.back": { t: [3_602_000] } });
    restored.stop();
  });

  test("a machine without runners persists as its plain snapshot", () => {
    const plain: __Compiled = {
      v: 0,
      e: { go: 1 },
      i: () => to("a"),
      o: { a: { go: () => to("b") }, b: {} },
      u: { persist: 1 },
      r: __run([]),
    };
    const actor = createActor(plain);
    actor.send({ type: "go" });
    expect(save(actor)).toEqual({ state: "b", data: {}, version: 0 });
  });

  test("a machine without persist in its use throws S11, naming the import", () => {
    const lean: __Compiled = { v: 0, e: { go: 1 }, i: () => to("a"), o: { a: {} }, r: __run([__tasks]) };
    expect(() => save(createActor(lean))).toThrow(
      /S11\].*persist\(actor\) needs persist in setup's use \(import \{ persist \} from "@reactre\/state\/persist"\)/,
    );
  });

  test("each runner saves its own part, by node and runner id, and gets it back on restore", () => {
    const given: unknown[] = [];
    const notes: __Runner = {
      id: "x",
      start: (_, node, ctx) => {
        given.push(ctx.saved);
        return { stop() {}, save: () => ({ note: node.node }) };
      },
    };
    const { a: _timers, ...rest } = trip;
    const machine: __Compiled = { ...rest, r: __run([__saved, notes]) };
    const actor = createActor(machine);
    actor.send({ type: "go" });
    const saved = save(actor);
    expect(saved.run).toEqual({ trip: { x: { note: "trip" } }, "trip.out": { x: { note: "trip.out" } } });
    const stored: Persisted<Shape> = JSON.parse(JSON.stringify(saved));
    restoreActor(machine, stored).stop();
    expect(given).toEqual([undefined, undefined, undefined, { note: "trip" }, { note: "trip.out" }]);
  });
});
