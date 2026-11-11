// A durable child's life after its parent cancels or restarts, on a journaling host: the parent's
// "busy" node runs a "job" child with a gated task and a 900ms timer. Cancelling leaves the node,
// so the child's run is dropped (its task aborted, its timer cancelled) and a late result lands
// nowhere; going again starts a new child at a new address with new ids. The machine is
// ./fixtures/durable/child-cancel.ts, compiled by the plugin.
//
// ../../children.test.ts proves the same scenarios in a plain actor; this proves them in a durable
// run, where the host's journal (steps, timers, saves) is the record. No subprocess and no files:
// the journal is in memory, as in ../integration/durable.test.ts.

import { describe, expect, test } from "bun:test";

import type { Shape } from "@reactre/state";
import type { DurableSnapshot, Host } from "@reactre/state/durable";

import "../compiled.ts";

const { durable } = await import("@reactre/state/durable");
const { parentMachine, useWork } = await import("./fixtures/durable/child-cancel.ts");

/** What outlives a process: each step's result by id, every save, the timers, and the clock. */
interface Journal {
  readonly steps: Map<string, Promise<unknown>>;
  readonly saves: DurableSnapshot<Shape>[];
  readonly scheduled: Map<string, number>;
  readonly cancelled: string[];
  clock: number;
}

const journal = (): Journal => ({ steps: new Map(), saves: [], scheduled: new Map(), cancelled: [], clock: 1000 });

/** One process on the host: a step ask records its id in `asked`. */
function boot(j: Journal) {
  const asked: string[] = [];
  const host: Host<Shape> = {
    now: () => j.clock,
    step<T>(id: string, fn: () => Promise<T>): Promise<T> {
      asked.push(id);
      let result = j.steps.get(id);
      if (result === undefined) {
        result = fn();
        j.steps.set(id, result);
      }
      return result as Promise<T>;
    },
    schedule: (id, at) => void j.scheduled.set(id, at),
    cancel: (id) => {
      j.scheduled.delete(id);
      j.cancelled.push(id);
    },
    save: (snapshot) => void j.saves.push(JSON.parse(JSON.stringify(snapshot))),
  };
  return { host, asked };
}

/** Let the microtask queue and the host's promises settle. */
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A child task that waits for the test to finish it: the side effect a cancel must drop. */
function gated() {
  let runs = 0;
  const gates: ((id: string) => void)[] = [];
  useWork(
    () =>
      new Promise<string>((resolve) => {
        runs++;
        gates.push((value) => resolve(value));
      }),
  );
  return { runs: () => runs, finish: (i: number, id: string) => gates[i]?.(id) };
}

describe("a durable child after its parent cancels or restarts", () => {
  test("cancelling the node drops the child: its timer is cancelled, its task aborted, a late result lands nowhere", async () => {
    const work = gated();
    const j = journal();
    const p = boot(j);
    const run = durable(parentMachine, p.host);
    await run.start();
    await run.send({ type: "go" });
    // The child starts with its node: one task, one timer, at its address under the node's entry.
    expect(p.asked).toEqual(["busy#1/job/working#1/task"]);
    expect([...j.scheduled.keys()]).toEqual(["busy#1/job/working#1/after/900"]);
    expect(Object.keys(run.snapshot().children ?? {})).toEqual(["busy#1/job"]);
    expect(work.runs()).toBe(1);

    // The cancel: the parent leaves busy for idle, and the child's timer is cancelled.
    await run.send({ type: "cancel" });
    expect(run.snapshot()).toMatchObject({ state: "idle", tasks: [], timers: {} });
    expect(j.cancelled).toEqual(["busy#1/job/working#1/after/900"]);
    expect(j.scheduled.size).toBe(0);
    // The child is gone from the snapshot, and its task is no longer pending: a finished result
    // after the node exited lands nowhere.
    expect(run.snapshot().children).toBeUndefined();
    work.finish(0, "late");
    await tick();
    expect(run.snapshot().state).toBe("idle");
    expect(run.snapshot().children).toBeUndefined();
  });

  test("going again starts a new child at a new address, with a new task and timer", async () => {
    const work = gated();
    const j = journal();
    const p = boot(j);
    const run = durable(parentMachine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "cancel" });
    j.cancelled.length = 0;

    // A new entry, a new child: its address and its work's ids carry the node's new entry count.
    await run.send({ type: "go" });
    expect(p.asked).toEqual(["busy#1/job/working#1/task", "busy#2/job/working#1/task"]);
    expect([...j.scheduled.keys()]).toEqual(["busy#2/job/working#1/after/900"]);
    expect(Object.keys(run.snapshot().children ?? {})).toEqual(["busy#2/job"]);
    expect(run.snapshot()).toMatchObject({ state: "busy", data: { n: 2 } });
    // The old child's task ran once and never finished; the new one ran once more.
    expect(work.runs()).toBe(2);
    // The old child's late result is dropped; the new child's lands and ends the parent.
    work.finish(0, "stale");
    await tick();
    expect(run.snapshot().state).toBe("busy");
    work.finish(1, "job-2");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "finished", data: { n: 2 } });
  });

  test("the child's timer fires through the host and ends the parent, as the child's done", async () => {
    gated();
    const j = journal();
    const p = boot(j);
    const run = durable(parentMachine, p.host);
    await run.start();
    await run.send({ type: "go" });
    // The child's 900ms timer fires at its deadline: the child ends, and its done moves the parent.
    j.clock = 1900;
    expect(await run.fire("busy#1/job/working#1/after/900")).toMatchObject({
      ok: true,
      snapshot: { state: "finished", data: { n: 1 } },
    });
    expect(run.status()).toBe("done");
    // The child went with the parent's final state: gone from the snapshot, its task dropped.
    expect(run.snapshot().children).toBeUndefined();
  });
});
