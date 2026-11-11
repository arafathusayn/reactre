// durable, as an app runs it: a compiled machine (./fixtures/durable/job.ts, compiled by the
// plugin) on a journaling host whose process can die. The host here is an in-memory journal: steps
// by id, saves, scheduled timers, and a clock. Each test is a scenario an app meets in production:
//
//   - a crash mid-charge resumes from the last save, and the charge runs exactly once;
//   - a 24h `after` is a host timer at its deadline, not a setTimeout that overflows;
//   - a cancel leaves the node: the host's timer is cancelled and a late charge is dropped;
//   - a failed charge retries, and the retry is a new entry with new ids;
//   - a host that dies between the save and the schedule resumes without losing the timer.

import { describe, expect, test } from "bun:test";

import type { __Event, Shape } from "@reactre/state";
import type { DurableSnapshot, Host } from "@reactre/state/durable";

import "../compiled.ts";

const { durable } = await import("@reactre/state/durable");
const { jobMachine, useCharge } = await import("./fixtures/durable/job.ts");

const DAY = 86_400_000;

/** What outlives a process: each step's result by id, every save, the timers, and the clock. */
interface Journal {
  readonly steps: Map<string, Promise<unknown>>;
  readonly saves: DurableSnapshot<Shape>[];
  readonly scheduled: Map<string, number>;
  readonly cancelled: string[];
  clock: number;
}

const journal = (): Journal => ({ steps: new Map(), saves: [], scheduled: new Map(), cancelled: [], clock: 1000 });

/** One process on the host: it can be killed, after which nothing reaches its run. */
function boot(j: Journal) {
  let alive = true;
  const asked: string[] = [];
  const host: Host<Shape> = {
    now: () => j.clock,
    step<T>(id: string, fn: () => Promise<T>): Promise<T> {
      asked.push(id);
      // A step runs once per id: a step still in flight when a process died is awaited, not run again.
      let result = j.steps.get(id);
      if (result === undefined) {
        result = fn();
        j.steps.set(id, result);
      }
      return (result as Promise<T>).then(
        (value) => (alive ? value : new Promise<T>(() => {})),
        (error: unknown) => (alive ? Promise.reject(error) : new Promise<T>(() => {})),
      );
    },
    schedule: (id, at) => {
      if (alive) j.scheduled.set(id, at);
    },
    cancel: (id) => {
      if (!alive) return;
      j.scheduled.delete(id);
      j.cancelled.push(id);
    },
    save: (snapshot) => {
      if (alive) j.saves.push(JSON.parse(JSON.stringify(snapshot)));
    },
  };
  return { host, asked, kill: () => void (alive = false) };
}

/** Let the microtask queue and the host's promises settle. */
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A charge that waits for the test to finish it: the side effect that must run once. */
function gated() {
  let charges = 0;
  const gates: ((event: __Event) => void)[] = [];
  useCharge(
    () =>
      new Promise<string>((resolve) => {
        charges++;
        gates.push((event) => resolve(String(Reflect.get(event, "id"))));
      }),
  );
  return { charges: () => charges, finish: (i: number, id: string) => gates[i]?.({ type: "charged", id } as __Event) };
}

describe("durable, compiled, on a journaling host", () => {
  test("a crash mid-charge resumes from the last save, and the charge runs exactly once", async () => {
    const charge = gated();
    const j = journal();
    const first = boot(j);
    const run = durable(jobMachine, first.host);
    await run.start();
    await run.send({ type: "go" });
    expect(charge.charges()).toBe(1);
    // The save holds the pending task and the 24h timer, at its deadline.
    expect(j.saves.at(-1)).toMatchObject({
      state: "charging",
      data: { amount: 5, tries: 0 },
      tasks: ["charging#1/task"],
      timers: { "charging#1/after/86400000": 1000 + DAY },
    });

    // The process dies; the charge completes on the host, and its result is journaled.
    first.kill();
    charge.finish(0, "ch_1");
    await tick();
    expect(run.snapshot().state).toBe("charging");

    // Another process resumes from the last save, a second later.
    j.clock = 2_000;
    const second = boot(j);
    const resumed = durable(jobMachine, second.host);
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    await resumed.resume(last as never);
    await tick();
    expect(charge.charges()).toBe(1);
    expect(resumed.snapshot()).toMatchObject({ state: "paid", data: { id: "ch_1" }, tasks: [], timers: {} });
    expect(resumed.status()).toBe("done");
    // The same id, asked again: the journal answered.
    expect(second.asked).toEqual(["charging#1/task"]);
  });

  test("a 24h `after` is a host timer at its deadline, and fires through the host", async () => {
    const charge = gated();
    const j = journal();
    const first = boot(j);
    const run = durable(jobMachine, first.host);
    await run.start();
    await run.send({ type: "go" });
    // Not a setTimeout: the host holds the deadline, a day out.
    expect([...j.scheduled]).toEqual([["charging#1/after/86400000", 1000 + DAY]]);
    first.kill();

    // A resume a second later schedules the same deadline, not now + a day.
    j.clock = 1000 + DAY - 1000;
    const second = boot(j);
    const resumed = durable(jobMachine, second.host);
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    await resumed.resume(last as never);
    expect([...j.scheduled]).toEqual([["charging#1/after/86400000", 1000 + DAY]]);

    // The host fires it at the deadline: the run gives up, and the charge's late result is dropped.
    j.clock = 1000 + DAY;
    expect(await resumed.fire("charging#1/after/86400000")).toMatchObject({
      ok: true,
      snapshot: { state: "failed", data: { error: "timed out" } },
    });
    charge.finish(0, "late");
    await tick();
    expect(resumed.snapshot().state).toBe("failed");
    // A timer fires once.
    expect(await resumed.fire("charging#1/after/86400000")).toBeNull();
  });

  test("a cancel leaves the node: the host's timer is cancelled and a late charge is dropped", async () => {
    const charge = gated();
    const j = journal();
    const p = boot(j);
    const run = durable(jobMachine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "cancel" });
    expect(p.asked).toEqual(["charging#1/task"]);
    expect(j.cancelled).toEqual(["charging#1/after/86400000"]);
    expect(run.snapshot()).toMatchObject({ state: "idle", tasks: [], timers: {} });
    // The charge finishes after the node exited: its result lands nowhere.
    charge.finish(0, "stale");
    await tick();
    expect(run.snapshot().state).toBe("idle");
    // Entering again is a new entry, with new ids.
    await run.send({ type: "go" });
    expect(p.asked).toEqual(["charging#1/task", "charging#2/task"]);
    expect([...j.scheduled.keys()]).toEqual(["charging#2/after/86400000"]);
  });

  test("a failed charge waits a second and retries: a new entry, and the old timer is cancelled", async () => {
    let charges = 0;
    useCharge(async () => {
      charges++;
      if (charges === 1) throw new Error("card declined");
      return "ch_2";
    });
    const j = journal();
    const p = boot(j);
    const run = durable(jobMachine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await tick();
    // The error handler goes to retrying, which waits a second: the charge's timer is cancelled.
    expect(run.snapshot()).toMatchObject({ state: "retrying", data: { amount: 5, tries: 1 } });
    expect(j.cancelled).toEqual(["charging#1/after/86400000"]);
    expect([...j.scheduled.keys()]).toEqual(["retrying#1/after/1000"]);
    // The host fires the retry's timer: charging again is a new entry, with a new task.
    j.clock = 2000;
    expect(await run.fire("retrying#1/after/1000")).toMatchObject({ ok: true, snapshot: { state: "charging" } });
    await tick();
    expect(charges).toBe(2);
    expect(p.asked).toEqual(["charging#1/task", "charging#2/task"]);
    expect(run.snapshot()).toMatchObject({ state: "paid", data: { id: "ch_2" } });
  });

  test("a retry event reenters the node at once: a new entry, a new task, and the old timer cancelled", async () => {
    const charge = gated();
    const j = journal();
    const p = boot(j);
    const run = durable(jobMachine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "retry" });
    // The reenter restarts charging: a new entry, a new task, and the old timer cancelled.
    expect(p.asked).toEqual(["charging#1/task", "charging#2/task"]);
    expect(j.cancelled).toEqual(["charging#1/after/86400000"]);
    expect([...j.scheduled.keys()]).toEqual(["charging#2/after/86400000"]);
    expect(run.snapshot()).toMatchObject({ state: "charging", data: { amount: 5, tries: 1 } });
    // The first charge's late result is dropped; the second's lands.
    charge.finish(0, "stale");
    await tick();
    expect(run.snapshot().state).toBe("charging");
    charge.finish(1, "ch_2");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "paid", data: { id: "ch_2" } });
  });

  test("a host that dies between the save and the schedule resumes without losing the timer", async () => {
    const charge = gated();
    const j = journal();
    const first = boot(j);
    const run = durable(jobMachine, first.host);
    await run.start();
    await run.send({ type: "go" });
    // The save happened; the process dies before the host scheduled the timer.
    j.scheduled.clear();
    first.kill();
    const second = boot(j);
    const resumed = durable(jobMachine, second.host);
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    await resumed.resume(last as never);
    // The resume schedules the pending timer again, at its saved deadline.
    expect([...j.scheduled]).toEqual([["charging#1/after/86400000", 1000 + DAY]]);
    expect(charge.charges()).toBe(1);
  });
});
