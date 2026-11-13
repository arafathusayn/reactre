// durable: a machine on a journaling host whose process dies. An in-memory host stands in for a
// workflow engine: a journal of steps and saves that outlives the process, a clock, durable timers.
// On compiled tables written by hand.

import { describe, expect, test } from "bun:test";

import type { __Child, __Compiled, __Event, __Step, __To, Shape } from "@reactre/state";
import { __step } from "@reactre/state";
import type { DurableRun, DurableSnapshot, Host } from "@reactre/state/durable";
import { durable as durableTyped } from "@reactre/state/durable";
import { __kids } from "@reactre/state/durable/children";
import { createAsyncLogic, createCallbackLogic } from "@reactre/state/logic";
import { __validate, __validated } from "@reactre/state/validate";

import { object, type StandardSchemaV1 } from "./fixtures/standard-schema.ts";
import { to } from "./to.ts";

// A cast: these tables are written by hand, without a shape that has durable in its `use`.
const durable = durableTyped as unknown as (machine: __Compiled, host: Host<Shape>) => DurableRun<Shape>;

/** A non-empty string. */
const nonEmpty = (): StandardSchemaV1<string> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string" && value !== "" ? { value } : { issues: [{ message: "Too short" }] },
  },
});

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** What outlives a process: each step's result, by id, and every save. */
interface Journal {
  readonly steps: Map<string, Promise<unknown>>;
  readonly saves: DurableSnapshot<Shape>[];
  clock: number;
}

const journal = (): Journal => ({ steps: new Map(), saves: [], clock: 1000 });

/** One process on the host: it can be killed, after which nothing reaches its run. */
function boot(j: Journal) {
  let alive = true;
  const asked: string[] = [];
  const scheduled = new Map<string, number>();
  const cancelled: string[] = [];
  const host: Host<Shape> = {
    now: () => j.clock,
    step<T>(id: string, fn: () => Promise<T>): Promise<T> {
      asked.push(id);
      // A step runs once per id, in the journal; a step still in flight when a process died is
      // awaited, not run again, as a workflow engine's activity keeps running.
      let result = j.steps.get(id);
      if (result === undefined) {
        result = fn();
        j.steps.set(id, result);
      }
      // The journal holds results of any step's type; this one's is the `T` its fn returned.
      return (result as Promise<T>).then(
        (value) => (alive ? value : new Promise<T>(() => {})),
        (error: unknown) => (alive ? Promise.reject(error) : new Promise<T>(() => {})),
      );
    },
    schedule: (id, at) => {
      if (alive) scheduled.set(id, at);
    },
    cancel: (id) => {
      if (!alive) return;
      scheduled.delete(id);
      cancelled.push(id);
    },
    save: (snapshot) => {
      if (alive) j.saves.push(JSON.parse(JSON.stringify(snapshot)));
    },
  };
  return { host, asked, scheduled, cancelled, kill: () => void (alive = false) };
}

/** A payment: the charge is the side effect that must run once. */
function payment() {
  let charges = 0;
  const gates: ((event: __Event) => void)[] = [];
  const machine: __Compiled = {
    v: 1,
    e: { go: 1, cancel: 1 },
    i: () => to("idle", {}, 1),
    o: {
      idle: { go: () => to("charging", { amount: 5 }, 1) },
      charging: {
        charged: (_, event): __Step => to("paid", { id: Reflect.get(event, "id") }, 1),
        cancel: () => to("idle", {}, 1),
      },
    },
    f: { paid: 1, timedOut: 1, failed: 1 },
    t: {
      charging: [
        () => {
          charges++;
          return new Promise<__Event>((r) => gates.push(r));
        },
        (_, error) => to("failed", { error: String(error) }, 1),
      ],
    },
    a: { charging: [[60_000, () => to("timedOut", {}, 1)]] },
    // As the compiler writes `use: [durable]`.
    u: { durable: 1 },
  };
  const finish = (i: number, id: string) => {
    const charged = { type: "charged", id };
    gates[i]?.(charged);
  };
  return { machine, charges: () => charges, finish };
}

describe("durable", () => {
  test("a crash mid-task resumes from the last save, and the charge runs exactly once", async () => {
    const pay = payment();
    const j = journal();

    const first = boot(j);
    const run = durable(pay.machine, first.host);
    await run.start();
    await run.send({ type: "go" });
    expect(pay.charges()).toBe(1);
    expect(j.saves.at(-1)).toEqual({
      state: "charging",
      data: { amount: 5 },
      version: 1,
      entries: { charging: 1 },
      timers: { "charging#1/after/60000": 61_000 },
      tasks: ["charging#1/task"],
    });

    // The process dies; the charge completes on the host, and its result is journaled.
    first.kill();
    pay.finish(0, "ch_1");
    await tick();
    expect(run.snapshot().state).toBe("charging");

    // Another process resumes from the last save, 30s later.
    j.clock = 31_000;
    const second = boot(j);
    const resumed = durable(pay.machine, second.host);
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    await resumed.resume(last);
    await tick();
    expect(pay.charges()).toBe(1);
    expect(resumed.snapshot()).toMatchObject({ state: "paid", data: { id: "ch_1" }, tasks: [], timers: {} });
    expect(resumed.status()).toBe("done");
    // The same ids, asked again: the journal answered.
    expect(second.asked).toEqual(first.asked);
    expect(second.asked).toEqual(["charging#1/task"]);
    // The timer was scheduled again at its deadline, then cancelled when the node exited.
    expect(second.cancelled).toEqual(["charging#1/after/60000"]);
    expect(j.saves.at(-1)?.state).toBe("paid");
    expect(await resumed.send({ type: "go" })).toMatchObject({ ok: false, reason: "inactive" });
  });

  test("timers resume at their deadlines, and fire through the host", async () => {
    const pay = payment();
    const j = journal();
    const first = boot(j);
    const run = durable(pay.machine, first.host);
    await run.start();
    await run.send({ type: "go" });
    expect([...first.scheduled]).toEqual([["charging#1/after/60000", 61_000]]);
    first.kill();

    j.clock = 59_000;
    const second = boot(j);
    const resumed = durable(pay.machine, second.host);
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    await resumed.resume(last);
    // Not now + 60s: the deadline saved at entry.
    expect([...second.scheduled]).toEqual([["charging#1/after/60000", 61_000]]);
    // The charge was in flight when the first process died: awaited, not run again.
    expect(second.asked).toEqual(["charging#1/task"]);
    expect(pay.charges()).toBe(1);

    j.clock = 61_000;
    expect(await resumed.fire("charging#1/after/60000")).toMatchObject({ ok: true, snapshot: { state: "timedOut" } });
    expect(resumed.snapshot().timers).toEqual({});
    // A late charge result after the node exited is dropped.
    pay.finish(0, "ch_late");
    await tick();
    expect(resumed.snapshot().state).toBe("timedOut");
    // A timer fires once.
    expect(await resumed.fire("charging#1/after/60000")).toBeNull();
  });

  test("a result from an earlier entry is dropped, and the node's new entry gets new ids", async () => {
    const pay = payment();
    const p = boot(journal());
    const run = durable(pay.machine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "cancel" });
    expect(p.cancelled).toEqual(["charging#1/after/60000"]);
    await run.send({ type: "go" });
    expect(p.asked).toEqual(["charging#1/task", "charging#2/task"]);
    expect([...p.scheduled.keys()]).toEqual(["charging#2/after/60000"]);

    pay.finish(0, "stale");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "charging", tasks: ["charging#2/task"] });
    expect(await run.fire("charging#1/after/60000")).toBeNull();

    pay.finish(1, "fresh");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "paid", data: { id: "fresh" } });
  });

  test("a task that throws goes where its error handler says", async () => {
    const machine: __Compiled = {
      ...payment().machine,
      t: {
        charging: [
          async () => Promise.reject(new Error("card declined")),
          (_, error) => to("failed", { error: String(error) }, 1),
        ],
      },
    };
    const p = boot(journal());
    const run = durable(machine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "failed", data: { error: "Error: card declined" } });
    expect(p.cancelled).toEqual(["charging#1/after/60000"]);
  });

  test("a task's event its schema refuses goes to the task's error, as S6", async () => {
    const pay = payment();
    // As the compiler writes a machine whose internal `charged` has a schema: `id` can't be empty.
    const machine: __Compiled = {
      ...pay.machine,
      s: { e: { charged: object({ id: nonEmpty() }) } },
      x: __validate,
      y: __validated(),
    };
    const p = boot(journal());
    const run = durable(machine, p.host);
    await run.start();
    await run.send({ type: "go" });
    pay.finish(0, "");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "failed", tasks: [], timers: {} });
    expect(Reflect.get(run.snapshot().data, "error")).toMatch(
      /S6\].*"charging".*invalid "charged" event \(event\.id: Too short\)/,
    );
  });

  test("a parent's work stays through its leaves' moves, as in an actor", async () => {
    // "trip" is a parent of "trip.out" and "trip.back", in a node graph written by hand.
    const machine: __Compiled = {
      v: 0,
      e: { go: 1, turn: 1 },
      i: () => to("home"),
      o: {
        home: { go: () => to("trip.out") },
        trip: {},
        "trip.out": { turn: () => to("trip.back") },
        "trip.back": {},
      },
      a: { trip: [[1000, () => to("home")]], "trip.back": [[500, () => to("home")]] },
      g: {
        nodes: (_, s) => [
          ...(s.state.startsWith("trip.") ? [{ node: "trip", state: s.state, data: s.data }] : []),
          { node: s.state, state: s.state, data: s.data },
        ],
        // This graph's steps are all `to`s: each is its snapshot.
        snap: (_, step) => step as __To,
      },
      u: { durable: 1 },
    };
    const p = boot(journal());
    const run = durable(machine, p.host);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "turn" });
    expect([...p.scheduled]).toEqual([
      ["trip#1/after/1000", 2000],
      ["trip.back#1/after/500", 1500],
    ]);
    expect(await run.fire("trip#1/after/1000")).toMatchObject({ ok: true, snapshot: { state: "home" } });
    expect(p.cancelled).toEqual(["trip.back#1/after/500"]);
  });

  test("a machine without durable in its use is refused, naming the import", () => {
    const { u: _durable, ...machine } = payment().machine;
    expect(() => durable(machine, boot(journal()).host)).toThrow(
      /S11\].*durable\(machine, host\) needs durable: add durable to setup's use \(import \{ durable \} from "@reactre\/state\/durable"\)/,
    );
  });

  test("a run that hasn't begun says to start or resume it", async () => {
    const run = durable(payment().machine, boot(journal()).host);
    await expect(run.send({ type: "go" })).rejects.toThrow(/S10\].*run\.start\(input\) or run\.resume\(saved\)/);
  });

  test("a saved snapshot of another version is refused", async () => {
    const run = durable(payment().machine, boot(journal()).host);
    const old = { state: "idle", data: {}, version: 0, entries: {}, timers: {}, tasks: [] };
    await expect(run.resume(old)).rejects.toThrow(/S2\].*version 0.*version 1/);
  });

  test("a saved snapshot in a state the machine doesn't have is refused, naming its states", async () => {
    const run = durable(payment().machine, boot(journal()).host);
    const other = { state: "refunded", data: {}, version: 1, entries: {}, timers: {}, tasks: [] };
    await expect(run.resume(other)).rejects.toThrow(/S1\] there is no state "refunded". States: idle, charging/);
  });

  test("a saved timer the machine no longer has fires nothing", async () => {
    const pay = payment();
    const j = journal();
    const first = boot(j);
    const run = durable(pay.machine, first.host);
    await run.start();
    await run.send({ type: "go" });
    first.kill();
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    // The same version, without charging's timeout: its saved timer is no one's.
    const { a: _timers, ...untimed } = pay.machine;
    const second = boot(j);
    const resumed = durable(untimed, second.host);
    await resumed.resume(last);
    expect(await resumed.fire("charging#1/after/60000")).toBeNull();
    expect(resumed.snapshot().state).toBe("charging");
  });
});

/**
 * A shipment that runs a `label` child while in `shipping`: the child buys a label (a task, the
 * side effect that must run once) or gives up after a minute (a timer). Its `done` decides where
 * the parent goes.
 */
function shipment() {
  let buys = 0;
  const gates: ((event: __Event) => void)[] = [];
  const label: __Compiled = {
    v: 0,
    e: {},
    i: (input) => to("buying", input),
    o: { buying: { bought: (_, event): __Step => to("bought", { code: Reflect.get(event, "code") }) } },
    f: { bought: 1, gaveUp: 1 },
    t: {
      buying: [
        () => {
          buys++;
          return new Promise<__Event>((r) => gates.push(r));
        },
        () => to("gaveUp"),
      ],
    },
    a: { buying: [[60_000, () => to("gaveUp")]] },
  };
  const machine: __Compiled = {
    v: 0,
    e: { ship: 1, cancel: 1 },
    i: () => to("idle"),
    o: { idle: { ship: () => to("shipping", { to: "Dhaka" }) }, shipping: { cancel: () => to("idle") } },
    f: { shipped: 1, lost: 1 },
    c: {
      shipping: {
        label: {
          m: label,
          i: (data) => ({ to: Reflect.get(Object(data), "to") }),
          d: (_, output) =>
            output.state === "bought" ? to("shipped", { label: Reflect.get(Object(output.data), "code") }) : to("lost"),
        },
      },
    },
    // As the compiler writes `use: [durable, children]`.
    u: { durable: 1 },
    dk: __kids,
  };
  return { machine, buys: () => buys, finish: (i: number, code: string) => gates[i]?.(ev({ type: "bought", code })) };
}

/** An event from outside the types: any payload. */
const ev = (e: { readonly type: string; readonly [field: string]: unknown }): __Event => e;

describe("durable children", () => {
  test("a child's work is journaled under its parent's ids, and the tree is saved at once", async () => {
    const ship = shipment();
    const j = journal();
    const p = boot(j);
    const run = durable(ship.machine, p.host);
    await run.start();
    await run.send({ type: "ship" });
    expect(p.asked).toEqual(["shipping#1/label/buying#1/task"]);
    expect([...p.scheduled]).toEqual([["shipping#1/label/buying#1/after/60000", 61_000]]);
    expect(j.saves.at(-1)).toEqual({
      state: "shipping",
      data: { to: "Dhaka" },
      version: 0,
      entries: { shipping: 1 },
      timers: {},
      tasks: [],
      children: {
        "shipping#1/label": {
          state: "buying",
          data: { to: "Dhaka" },
          version: 0,
          entries: { buying: 1 },
          timers: { "shipping#1/label/buying#1/after/60000": 61_000 },
          tasks: ["shipping#1/label/buying#1/task"],
        },
      },
    });
  });

  test("a crash mid child task resumes from the last save: the label is bought once, and done moves the parent", async () => {
    const ship = shipment();
    const j = journal();
    const first = boot(j);
    const run = durable(ship.machine, first.host);
    await run.start();
    await run.send({ type: "ship" });
    first.kill();
    ship.finish(0, "LB-1");
    await tick();

    const second = boot(j);
    const resumed = durable(ship.machine, second.host);
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    await resumed.resume(last);
    await tick();
    expect(ship.buys()).toBe(1);
    expect(second.asked).toEqual(["shipping#1/label/buying#1/task"]);
    expect(resumed.snapshot()).toEqual({
      state: "shipped",
      data: { label: "LB-1" },
      version: 0,
      entries: { shipping: 1 },
      timers: {},
      tasks: [],
    });
    // The child's timer was scheduled again on resume, then cancelled when the child ended.
    expect(second.cancelled).toEqual(["shipping#1/label/buying#1/after/60000"]);
  });

  test("a child's timer fires through run.fire, by its id", async () => {
    const ship = shipment();
    const p = boot(journal());
    const run = durable(ship.machine, p.host);
    await run.start();
    await run.send({ type: "ship" });
    expect(await run.fire("shipping#1/label/buying#1/after/60000")).toMatchObject({
      ok: true,
      snapshot: { state: "lost" },
    });
    // The label bought after the child gave up is dropped.
    ship.finish(0, "late");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "lost", tasks: [], timers: {} });
    expect(await run.fire("shipping#1/label/buying#1/after/60000")).toBeNull();
  });

  test("leaving the node stops its child; entering again starts a new one at a new address", async () => {
    const ship = shipment();
    const p = boot(journal());
    const run = durable(ship.machine, p.host);
    await run.start();
    await run.send({ type: "ship" });
    await run.send({ type: "cancel" });
    expect(p.cancelled).toEqual(["shipping#1/label/buying#1/after/60000"]);
    expect(run.snapshot().children).toBeUndefined();
    await run.send({ type: "ship" });
    expect(p.asked).toEqual(["shipping#1/label/buying#1/task", "shipping#2/label/buying#1/task"]);
    ship.finish(0, "stale");
    await tick();
    expect(run.snapshot().state).toBe("shipping");
    ship.finish(1, "LB-2");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "shipped", data: { label: "LB-2" } });
  });

  test("keyed children: reconciled as the node's data changes, each reporting its done", async () => {
    // A batch of uploads, one child per file: `update` counts what's moving, `done` drops the file.
    const upload: __Compiled = {
      v: 0,
      e: {},
      i: (input) => to("sending", input),
      o: { sending: {} },
      f: { sent: 1 },
      a: { sending: [[1000, (data) => to("sent", data)]] },
    };
    const files = (data: unknown): string[] => (Reflect.get(Object(data), "files") as string[] | undefined) ?? [];
    const machine: __Compiled = {
      v: 0,
      e: { add: 1 },
      i: () => to("batch", { files: ["a/1"] }),
      o: { batch: { add: (data, event) => to("batch", { files: [...files(data), Reflect.get(event, "file")] }) } },
      c: {
        batch: {
          upload: {
            m: upload,
            k: (data) => files(data).map((f) => [f, { file: f }] as const),
            d: (data, output) =>
              to("batch", { files: files(data).filter((f) => f !== Reflect.get(Object(output.data), "file")) }),
          },
        },
      },
      u: { durable: 1 },
      dk: __kids,
    };
    const p = boot(journal());
    const run = durable(machine, p.host);
    await run.start();
    expect(Object.keys(run.snapshot().children ?? {})).toEqual(["batch#1/upload/a%2F1"]);
    await run.send(ev({ type: "add", file: "b" }));
    expect(Object.keys(run.snapshot().children ?? {})).toEqual(["batch#1/upload/a%2F1", "batch#1/upload/b"]);
    expect([...p.scheduled.keys()]).toEqual([
      "batch#1/upload/a%2F1/sending#1/after/1000",
      "batch#1/upload/b/sending#1/after/1000",
    ]);
    // a/1 is sent: its done drops it from the data, and the reconcile stops it.
    await run.fire("batch#1/upload/a%2F1/sending#1/after/1000");
    expect(run.snapshot()).toMatchObject({ state: "batch", data: { files: ["b"] } });
    expect(Object.keys(run.snapshot().children ?? {})).toEqual(["batch#1/upload/b"]);
  });

  test("a resumed child keeps its address, entries and deadlines; a stale child version is refused", async () => {
    const ship = shipment();
    const j = journal();
    const first = boot(j);
    const run = durable(ship.machine, first.host);
    await run.start();
    await run.send({ type: "ship" });
    first.kill();
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    j.clock = 30_000;
    const second = boot(j);
    await durable(ship.machine, second.host).resume(last);
    expect([...second.scheduled]).toEqual([["shipping#1/label/buying#1/after/60000", 61_000]]);

    const stale = JSON.parse(JSON.stringify(last));
    stale.children["shipping#1/label"].version = 7;
    // `as never`: the types refuse an any snapshot (M558), and this one reaches the runtime's check.
    await expect(durable(ship.machine, boot(j).host).resume(stale as never)).rejects.toThrow(
      /S2\] the snapshot of child "shipping#1\/label" is of version 7, and the machine is at version 0/,
    );
  });

  test("a child that starts in a final state reports its done once the parent's entry is done", async () => {
    // A prepaid label: bought as it starts, so nothing is bought and no timer is set.
    const prepaid: __Compiled = {
      v: 0,
      e: {},
      i: (input) => to("bought", { code: Reflect.get(Object(input), "code") }),
      o: {},
      f: { bought: 1 },
    };
    const ship = shipment();
    const machine: __Compiled = {
      ...ship.machine,
      c: {
        shipping: {
          label: {
            m: prepaid,
            i: () => ({ code: "PRE-1" }),
            d: (_, output) => to("shipped", { label: Reflect.get(Object(output.data), "code") }),
          },
        },
      },
    };
    const p = boot(journal());
    const run = durable(machine, p.host);
    await run.start();
    await run.send({ type: "ship" });
    expect(run.snapshot()).toEqual({
      state: "shipped",
      data: { label: "PRE-1" },
      version: 0,
      entries: { shipping: 1 },
      timers: {},
      tasks: [],
    });
    expect(p.asked).toEqual([]);
    expect(p.scheduled.size).toBe(0);
  });

  test("a saved child that its state no longer runs is refused, naming the state and the child", async () => {
    const ship = shipment();
    const j = journal();
    const first = boot(j);
    const run = durable(ship.machine, first.host);
    await run.start();
    await run.send({ type: "ship" });
    first.kill();
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    // The same version, with shipping no longer running its label child.
    const { c: _children, ...childless } = ship.machine;
    await expect(durable(childless, boot(j).host).resume(last)).rejects.toThrow(
      /S1\] the snapshot has child "shipping#1\/label", and state "shipping" runs no child "label"/,
    );
  });

  test("without the children hooks (dk), a run has none of the children code: its children don't run", async () => {
    const { dk: _, ...bare } = shipment().machine;
    const p = boot(journal());
    const run = durable(bare, p.host);
    await run.start();
    await run.send({ type: "ship" });
    expect(p.asked).toEqual([]);
    expect(run.snapshot().children).toBeUndefined();
  });

  test("a child whose start throws goes to its spec's error, once the parent's entry is done", async () => {
    const refusing: __Compiled = {
      v: 0,
      e: {},
      i: () => {
        throw new Error("bad input");
      },
      o: { working: {} },
    };
    const machine = (x?: __Child["x"]): __Compiled => ({
      v: 0,
      e: { go: 1 },
      i: () => to("idle"),
      o: { idle: { go: () => to("busy") }, busy: {} },
      f: { failed: 1 },
      c: { busy: { job: { m: refusing, ...(x && { x }) } } },
      u: { durable: 1 },
      dk: __kids,
    });
    const run = durable(
      machine((_, error) => to("failed", { error: String(error) })),
      boot(journal()).host,
    );
    await run.start();
    await run.send({ type: "go" });
    expect(run.snapshot()).toMatchObject({ state: "failed", data: { error: "Error: bad input" } });
    // Without `error`, the throw reaches whoever entered the node.
    const bare = durable(machine(), boot(journal()).host);
    await bare.start();
    await expect(bare.send({ type: "go" })).rejects.toThrow("bad input");
  });
});

describe("durable logic children", () => {
  /** A profile loaded by async logic: its whole run is the side effect that must run once. */
  function profile(fail = false) {
    let runs = 0;
    const gates: ((name: string) => void)[] = [];
    const load = createAsyncLogic({
      run: ({ input }: { input: { id: string }; signal: AbortSignal }) => {
        runs++;
        return new Promise<string>((resolve, reject) =>
          gates.push((name) => (fail ? reject(new Error(`no ${input.id}`)) : resolve(name))),
        );
      },
    }) as unknown as __Compiled;
    const machine: __Compiled = {
      v: 0,
      e: { open: 1 },
      i: () => to("idle"),
      o: { idle: { open: () => to("loading", { id: "u1" }) }, loading: {} },
      f: { loaded: 1, failed: 1 },
      c: {
        loading: {
          load: {
            m: load,
            i: (data) => ({ id: Reflect.get(Object(data), "id") }),
            d: (_, output) => to("loaded", { name: output }),
            x: (_, error) => to("failed", { error: String(error) }),
          },
        },
      },
      u: { durable: 1 },
      dk: __kids,
    };
    return { machine, runs: () => runs, finish: (name: string) => gates.at(-1)?.(name) };
  }

  test("its end is journaled under its address: done gets the output, and a resume gets the recorded end", async () => {
    const pro = profile();
    const j = journal();
    const first = boot(j);
    const run = durable(pro.machine, first.host);
    await run.start();
    await run.send({ type: "open" });
    expect(first.asked).toEqual(["loading#1/load/active#1/task"]);
    expect(j.saves.at(-1)?.children).toEqual({
      "loading#1/load": {
        state: "active",
        data: { input: { id: "u1" } },
        version: 0,
        entries: { active: 1 },
        timers: {},
        tasks: ["loading#1/load/active#1/task"],
      },
    });
    // The process dies; the logic ends anyway, and the journal records its output.
    first.kill();
    pro.finish("Ann");
    await tick();
    const last = j.saves.at(-1);
    if (last === undefined) throw new Error("no save");
    const second = boot(j);
    const resumed = durable(pro.machine, second.host);
    await resumed.resume(last);
    await tick();
    expect(second.asked).toEqual(["loading#1/load/active#1/task"]);
    expect(pro.runs()).toBe(1);
    expect(resumed.snapshot()).toMatchObject({ state: "loaded", data: { name: "Ann" } });
  });

  test("its failure goes to the spec's error, with what it threw", async () => {
    const pro = profile(true);
    const run = durable(pro.machine, boot(journal()).host);
    await run.start();
    await run.send({ type: "open" });
    pro.finish("");
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "failed", data: { error: "Error: no u1" } });
  });

  test("the events it sends back go to the spec's on, each a saved transition of its parent", async () => {
    let send: ((n: number) => void) | undefined;
    let stopped = 0;
    const socket = createCallbackLogic<never, undefined, { type: "progress"; n: number }>(({ sendBack }) => {
      sendBack({ type: "progress", n: 1 });
      send = (n) => sendBack({ type: "progress", n });
      return () => stopped++;
    }) as unknown as __Compiled;
    const machine: __Compiled = {
      v: 0,
      e: { go: 1, stop: 1 },
      i: () => to("idle"),
      o: { idle: { go: () => to("busy", { n: 0 }) }, busy: { stop: () => to("idle") } },
      c: {
        busy: {
          socket: { m: socket, o: { progress: (_, event) => to("busy", { n: Reflect.get(event, "n") }) } },
        },
      },
      u: { durable: 1 },
      dk: __kids,
    };
    const j = journal();
    const run = durable(machine, boot(j).host);
    await run.start();
    await run.send({ type: "go" });
    await tick();
    expect(run.snapshot()).toMatchObject({ state: "busy", data: { n: 1 } });
    send?.(2);
    await tick();
    expect(j.saves.at(-1)).toMatchObject({ state: "busy", data: { n: 2 } });
    // Leaving the node stops the logic: what it sends after that is dropped.
    await run.send({ type: "stop" });
    expect(stopped).toBe(1);
    send?.(3);
    await tick();
    expect(run.snapshot().state).toBe("idle");
  });
});

// dur:D3: the timers resolved at entry (delays's named delays and ISO durations, timeout's) run on
// a durable host as `after`'s do, and a timer's id is its delay, not its place in the list.
describe("durable timers", () => {
  /** A wait with an ISO duration (`l`'s milliseconds), a named delay, a timeout from the data, and `after`. */
  const waiting = (): __Compiled => ({
    v: 0,
    e: { go: 1, answer: 1 },
    i: () => to("idle"),
    o: { idle: { go: () => to("waiting", { ms: 7000 }) }, waiting: { answer: () => to("idle") } },
    f: { late: 1 },
    a: { waiting: [[2000, () => to("late", { by: "after" })]] },
    l: {
      waiting: [
        [90_000, () => to("late", { by: "iso" })],
        ["sla", () => to("late", { by: "sla" })],
        [(data: unknown) => (data as { ms: number }).ms, () => to("late", { by: "timeout" })],
      ],
    },
    w: { sla: (data: unknown) => (data as { ms: number }).ms * 2 },
    u: { durable: 1 },
  });

  test("delays's and timeout's timers are scheduled, fired and cancelled as after's are", async () => {
    const j = journal();
    const p = boot(j);
    const run = durable(waiting(), p.host);
    await run.start();
    await run.send({ type: "go" });
    expect([...p.scheduled]).toEqual([
      ["waiting#1/after/2000", 3000],
      ["waiting#1/after/90000", 91_000],
      ["waiting#1/after/sla", 15_000],
      ["waiting#1/after/fn", 8000],
    ]);
    expect(run.snapshot().timers).toEqual(Object.fromEntries(p.scheduled));
    expect(await run.fire("waiting#1/after/fn")).toMatchObject({
      ok: true,
      snapshot: { state: "late", data: { by: "timeout" } },
    });
    // The final state ends the run: the others are cancelled.
    expect(p.cancelled.sort()).toEqual(["waiting#1/after/2000", "waiting#1/after/90000", "waiting#1/after/sla"]);
    const again = durable(waiting(), boot(journal()).host);
    await again.start();
    await again.send({ type: "go" });
    expect(await again.fire("waiting#1/after/sla")).toMatchObject({ snapshot: { data: { by: "sla" } } });
  });

  test("leaving the node cancels them", async () => {
    const p = boot(journal());
    const run = durable(waiting(), p.host);
    await run.start();
    await run.send({ type: "go" });
    await run.send({ type: "answer" });
    expect(p.cancelled).toHaveLength(4);
    expect(run.snapshot().timers).toEqual({});
    expect(await run.fire("waiting#1/after/sla")).toBeNull();
  });

  test("a timer's id is its delay: a new version that reorders after's keys fires the right handler on a resumed run", async () => {
    const make = (order: "short first" | "long first"): __Compiled => {
      const short = [5000, () => to("short")] as const;
      const long = [10_000, () => to("long")] as const;
      return {
        v: 0,
        e: { go: 1 },
        i: () => to("idle"),
        o: { idle: { go: () => to("waiting") }, waiting: {} },
        f: { short: 1, long: 1 },
        a: { waiting: order === "short first" ? [short, long] : [long, short] },
        u: { durable: 1 },
      };
    };
    const j = journal();
    const first = boot(j);
    const run = durable(make("short first"), first.host);
    await run.start();
    await run.send({ type: "go" });
    first.kill();
    const saved = j.saves.at(-1);
    if (saved === undefined) throw new Error("no save");
    const resumed = durable(make("long first"), boot(j).host);
    await resumed.resume(saved);
    expect(await resumed.fire("waiting#1/after/5000")).toMatchObject({ snapshot: { state: "short" } });
  });

  test("two timers with the same delay in one node: the second's id says so", async () => {
    const p = boot(journal());
    const run = durable(
      {
        v: 0,
        e: { go: 1 },
        i: () => to("idle"),
        o: { idle: { go: () => to("waiting") } },
        f: { a: 1, b: 1 },
        a: { waiting: [[1000, () => to("a")]] },
        l: { waiting: [[1000, () => to("b")]] },
        u: { durable: 1 },
      },
      p.host,
    );
    await run.start();
    await run.send({ type: "go" });
    expect([...p.scheduled.keys()]).toEqual(["waiting#1/after/1000", "waiting#1/after/1000/1"]);
    expect(await run.fire("waiting#1/after/1000/1")).toMatchObject({ snapshot: { state: "b" } });
  });
});

// dur:D3, M555: effects don't run on a durable host (an effect isn't journaled): a machine that
// records them is refused, where the type checker didn't see it.
describe("durable and effects", () => {
  test("a machine with entry or exit effects is refused at once: S12", () => {
    const machine: __Compiled = {
      v: 0,
      e: {},
      i: () => to("idle"),
      o: { idle: {} },
      b: { idle: [() => {}, 0] },
      u: { durable: 1 },
    } as unknown as __Compiled;
    expect(() => durable(machine, boot(journal()).host)).toThrow(/S12\] effects don't run on a durable host/);
  });

  test("a transition that records effects is refused, and nothing moves: S12", async () => {
    const flat: __Compiled = { v: 0, e: { go: 1 }, i: () => to("idle"), o: { idle: { go: () => to("busy") } } };
    // The effects feature's step, as it records an `enq.log(...)`.
    const machine: __Compiled = {
      ...flat,
      y: (_m, from, event) => {
        const next = __step(flat, from, event, false);
        return next.ok ? { ...next, fx: [{ type: "log" }] } : next;
      },
      u: { durable: 1 },
    };
    const run = durable(machine, boot(journal()).host);
    await run.start();
    await expect(run.send({ type: "go" })).rejects.toThrow(/S12\] effects don't run on a durable host/);
    expect(run.snapshot().state).toBe("idle");
  });
});
