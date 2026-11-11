// A durable reenter under a parent and inside a parallel node: the reentered leaf restarts alone.
// The parent's timer keeps its deadline, the other region's timer is untouched, and the leaf is
// stopped and entered exactly once (no duplicate stops or entries). The machine is
// ./fixtures/durable/nested.ts, compiled by the plugin.

import { describe, expect, test } from "bun:test";

import type { Shape } from "@reactre/state";
import type { DurableSnapshot, Host } from "@reactre/state/durable";

import "../compiled.ts";

const { durable } = await import("@reactre/state/durable");
const { tripMachine } = await import("./fixtures/durable/nested.ts");

/** A host that records what it was asked, with a clock the test moves. */
function host() {
  const scheduled: [string, number][] = [];
  const cancelled: string[] = [];
  const saves: DurableSnapshot<Shape>[] = [];
  const steps = new Map<string, Promise<unknown>>();
  let clock = 0;
  const h: Host<Shape> = {
    now: () => clock,
    step: <T>(id: string, fn: () => Promise<T>) => {
      let r = steps.get(id);
      if (r === undefined) {
        r = fn();
        steps.set(id, r);
      }
      return r as Promise<T>;
    },
    schedule: (id, at) => void scheduled.push([id, at]),
    cancel: (id) => void cancelled.push(id),
    save: (s) => void saves.push(JSON.parse(JSON.stringify(s))),
  };
  return {
    h,
    scheduled,
    cancelled,
    saves,
    set clock(v: number) {
      clock = v;
    },
  };
}

describe("a durable reenter under a parent and inside a parallel node", () => {
  test("restarts the reentered leaf alone: the parent's and the other region's timers keep their deadlines", async () => {
    const j = host();
    const run = durable(tripMachine, j.h);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "turn" });
    // The parent's timer, and each region's, at their deadlines.
    expect(j.scheduled).toEqual([
      ["trip#1/after/1000", 1000],
      ["trip.back.left.working#1/after/500", 500],
      ["trip.back.right.working#1/after/700", 700],
    ]);
    j.scheduled.length = 0;
    j.cancelled.length = 0;

    // The reenter: only the left region's timer is cancelled, and only it is scheduled again.
    await run.send({ type: "retry" });
    expect(j.cancelled).toEqual(["trip.back.left.working#1/after/500"]);
    expect(j.scheduled).toEqual([["trip.back.left.working#2/after/500", 500]]);
    // The parent and the right region were not restarted: their entry counts are unchanged.
    expect(run.snapshot().entries).toEqual({ trip: 1, "trip.back.left.working": 2, "trip.back.right.working": 1 });
    // The parent's timer still fires at its original deadline, and the right region's too.
    expect(await run.fire("trip#1/after/1000")).toMatchObject({ ok: true, snapshot: { state: "home" } });
  });

  test("the reentered leaf is stopped and entered once: one cancel, one schedule, one new entry", async () => {
    const j = host();
    const run = durable(tripMachine, j.h);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "turn" });
    j.cancelled.length = 0;
    j.scheduled.length = 0;
    await run.send({ type: "retry" });
    // Exactly one of each: no duplicate stop or entry from the reenter.
    expect(j.cancelled).toHaveLength(1);
    expect(j.scheduled).toHaveLength(1);
    expect(run.snapshot().entries["trip.back.left.working"]).toBe(2);
    // The old entry's timer id is gone; the new one is pending.
    expect(run.snapshot().timers).toEqual({
      "trip#1/after/1000": 1000,
      "trip.back.left.working#2/after/500": 500,
      "trip.back.right.working#1/after/700": 700,
    });
  });
});
