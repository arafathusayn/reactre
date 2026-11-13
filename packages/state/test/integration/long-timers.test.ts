// A long `after` timer on the real host: setTimeout takes at most 2^31 − 1 ms (about 24.8 days),
// and a longer delay fires at once. The lean lifecycle (src/tasks.ts) and persist's runner
// (src/features/persist/index.ts) call setTimeout with the delay as written, so a 30-day `after`
// fires immediately there; only delays's and timeout's timers (`l`) wait in parts (`__wait`).
//
// These tests use the real Bun timers, not a simulated clock: a clock that doesn't overflow would
// hide the bug. The eventual-firing test uses SimulatedClock's time travel, which is the behaviour
// a corrected runner must keep.

import { afterEach, describe, expect, test } from "bun:test";

import type { __Compiled } from "@reactre/state";
import { createActor } from "@reactre/state";
import { __saved } from "@reactre/state/persist";
import { __run } from "@reactre/state/run";
import { __lean } from "@reactre/state/tasks";
import { SimulatedClock } from "@reactre/state/utils/SimulatedClock";

import { to } from "../to.ts";

const DAY = 86_400_000;
/** setTimeout's limit: 2^31 − 1 ms. */
const LIMIT = 2_147_483_647;

/** A machine that waits 30 days in `waiting`, then goes to `late`. */
const waiting = (lifecycle: "lean" | "persist"): __Compiled => ({
  v: 0,
  e: { go: 1 },
  i: () => to("idle"),
  o: { idle: { go: () => to("waiting") }, waiting: {} },
  f: { late: 1 },
  a: { waiting: [[30 * DAY, () => to("late")]] },
  ...(lifecycle === "persist" ? { u: { persist: 1 }, r: __run([__saved]) } : { r: __lean }),
});

/** Let the real timers run: a timer that overflowed fires within a millisecond. */
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("a 30-day `after` on the real host", () => {
  test("the lean lifecycle doesn't fire it at once", async () => {
    const actor = createActor(waiting("lean"));
    actor.send({ type: "go" });
    expect(actor.snapshot().state).toBe("waiting");
    await settle();
    // Observed before the fix: "late" (setTimeout overflowed and fired at once).
    expect(actor.snapshot().state).toBe("waiting");
    actor.stop();
  });

  test("persist's runner doesn't fire it at once", async () => {
    const actor = createActor(waiting("persist"));
    actor.send({ type: "go" });
    expect(actor.snapshot().state).toBe("waiting");
    await settle();
    expect(actor.snapshot().state).toBe("waiting");
    actor.stop();
  });
});

describe("a 30-day `after` still fires when its time comes", () => {
  let clock: SimulatedClock | undefined;
  afterEach(() => clock?.uninstall());

  test.each(["lean", "persist"] as const)("%s: time travel to the deadline fires it", (lifecycle) => {
    clock = new SimulatedClock();
    const actor = createActor(waiting(lifecycle), { now: clock.now });
    actor.send({ type: "go" });
    clock.advance(30 * DAY - 1);
    expect(actor.snapshot().state).toBe("waiting");
    clock.advance(1);
    expect(actor.snapshot().state).toBe("late");
    actor.stop();
  });

  test("a delay just past the limit waits the rest, not the whole delay again", () => {
    clock = new SimulatedClock();
    const m: __Compiled = {
      v: 0,
      e: { go: 1 },
      i: () => to("idle"),
      o: { idle: { go: () => to("waiting") }, waiting: {} },
      f: { late: 1 },
      a: { waiting: [[LIMIT + 1000, () => to("late")]] },
      r: __lean,
    };
    const actor = createActor(m, { now: clock.now });
    actor.send({ type: "go" });
    clock.advance(LIMIT);
    expect(actor.snapshot().state).toBe("waiting");
    clock.advance(1000);
    expect(actor.snapshot().state).toBe("late");
    actor.stop();
  });
});
