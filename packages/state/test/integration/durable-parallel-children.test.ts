// A durable reenter inside a parallel node whose regions each run a child: the reentered region's
// child restarts (a new address, a new timer), and the sibling region's child is untouched (its
// address and timer stay). The machine is ./fixtures/durable/parallel-children.ts.

import { describe, expect, test } from "bun:test";

import type { Shape } from "@reactre/state";
import type { DurableSnapshot, Host } from "@reactre/state/durable";

import "../compiled.ts";

const { durable } = await import("@reactre/state/durable");
const { backMachine } = await import("./fixtures/durable/parallel-children.ts");

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

describe("a durable reenter inside a parallel node with children", () => {
  test("the reentered region's child restarts; the sibling region's child keeps its address and timer", async () => {
    const j = host();
    const run = durable(backMachine, j.h);
    await run.start();
    await run.send({ type: "go" });
    // Each region's child is at its own address, with its own timer.
    expect(Object.keys(run.snapshot().children ?? {}).sort()).toEqual([
      "back.left.working#1/job",
      "back.right.working#1/job",
    ]);
    expect(j.scheduled.map(([id]) => id).sort()).toEqual([
      "back.left.working#1/job/working#1/after/900",
      "back.right.working#1/job/working#1/after/900",
    ]);
    j.scheduled.length = 0;
    j.cancelled.length = 0;

    // The reenter: the left region's child is stopped and a new one starts at a new address (the
    // region's entry count went to 2); the right region's child is untouched.
    await run.send({ type: "retry" });
    expect(j.cancelled).toEqual(["back.left.working#1/job/working#1/after/900"]);
    expect(j.scheduled).toEqual([["back.left.working#2/job/working#1/after/900", 900]]);
    expect(Object.keys(run.snapshot().children ?? {}).sort()).toEqual([
      "back.left.working#2/job",
      "back.right.working#1/job",
    ]);
    // The right child's timer was never cancelled or re-scheduled.
    expect(j.cancelled).not.toContain("back.right.working#1/job/working#1/after/900");
    expect(j.scheduled.map(([id]) => id)).not.toContain("back.right.working#1/job/working#1/after/900");
  });

  test("the reentered region's child gets a new input, and the sibling's keeps its own", async () => {
    const j = host();
    const run = durable(backMachine, j.h);
    await run.start();
    await run.send({ type: "go" });
    const before = run.snapshot().children ?? {};
    // The left child's data is left-0; the right's is right-0.
    expect(before["back.left.working#1/job"]?.data).toEqual({ id: "left-0" });
    expect(before["back.right.working#1/job"]?.data).toEqual({ id: "right-0" });
    await run.send({ type: "retry" });
    const after = run.snapshot().children ?? {};
    // The left child restarted at a new address with the new data (left-1); the right's is unchanged.
    expect(after["back.left.working#2/job"]?.data).toEqual({ id: "left-1" });
    expect(after["back.right.working#1/job"]?.data).toEqual({ id: "right-0" });
  });
});
