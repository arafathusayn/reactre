// system: a registry of actors (`createSystem`, `registryKey`), and pure transitions of a whole
// system of machines with virtual time (`initialSystem`, `systemTransition`, `advanceSystemTime`).

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";

import { optIn } from "../opt-in.ts";

const { createActor } = await import("@reactre/state");
const { child } = await import("@reactre/state/children");
const { advanceSystemTime, createSystem, initialSystem, rootOf, runSystemTask, systemTransition } =
  await import("@reactre/state/system");
const { batchMachine, blinkerMachine, orderMachine, paymentMachine, pingPongMachine } = await import("./fixture.ts");
const { userMachine } = await import("../logic/fixture.ts");

describe("system", () => {
  optIn("system");
});

describe("the registry", () => {
  test("a child with a registryKey is in its system while its node is active", () => {
    const sys = createSystem({ registry: { payment: paymentMachine } });
    const actor = sys.createActor(orderMachine);
    expect(sys.get("payment")).toBeUndefined();
    actor.send({ type: "checkout" });
    const payment = sys.get("payment");
    expect(payment).toBe(child(actor, "payment"));
    expect(payment?.snapshot().state).toBe("pending");
    payment?.send({ type: "approve" });
    expect(actor.snapshot().state).toBe("placed");
    expect(sys.get("payment")).toBeUndefined();
  });

  test("a root actor joins by its registryKey and leaves when it stops; a key in use throws S32", () => {
    const sys = createSystem();
    const a = sys.createActor(orderMachine, { registryKey: "order" });
    expect(sys.get("order")).toBe(a);
    expect(Object.keys(sys.getAll())).toEqual(["order"]);
    expect(() => sys.createActor(orderMachine, { registryKey: "order" })).toThrow("S32");
    a.stop();
    expect(sys.get("order")).toBeUndefined();
  });

  test("an actor outside a system has no registry: its children run as before", () => {
    const actor = createActor(orderMachine);
    actor.send({ type: "checkout" });
    expect(child(actor, "payment")?.snapshot().state).toBe("pending");
    actor.stop();
  });
});

describe("pure system transitions", () => {
  test("the initial system, and a send that starts a child, its timers and its task", () => {
    const [s0, fx0] = initialSystem(orderMachine, { time: 0 });
    expect(rootOf(s0)).toEqual({ state: "cart", data: { total: 10 }, version: 0 });
    expect(fx0).toEqual([]);
    const [s1, fx1] = systemTransition(orderMachine, s0, "root", { type: "checkout" });
    expect(s1.actors["root/payment"]?.snapshot).toEqual({ state: "pending", data: { amount: 10 }, version: 0 });
    expect(s1.registry).toEqual({ payment: "root/payment" });
    expect(s1.timers.map((t) => [t.actor, t.due])).toEqual([
      ["root", 5000],
      ["root/payment", 3000],
    ]);
    expect(fx1).toEqual([
      { type: "task", id: "task:2", actor: "root/payment", node: "pending", state: "pending", data: { amount: 10 } },
    ]);
    // The input is unchanged, and the snapshot is JSON.
    expect(s0.actors["root/payment"]).toBeUndefined();
    expect(JSON.parse(JSON.stringify(s1))).toEqual(s1);
  });

  test("a child's send reaches its parent's done; leaving the node stops it, its timers and its task", () => {
    const [s0] = initialSystem(orderMachine);
    const [s1] = systemTransition(orderMachine, s0, "root", { type: "checkout" });
    const [s2, fx2] = systemTransition(orderMachine, s1, "root/payment", { type: "approve" });
    expect(rootOf(s2)).toEqual({ state: "placed", data: { total: 10 }, version: 0 });
    expect(s2.actors["root/payment"]).toBeUndefined();
    expect(s2.timers).toEqual([]);
    expect(s2.registry).toEqual({});
    expect(fx2).toEqual([{ type: "cancel", id: "task:2" }]);
  });

  test("a task's result comes back by its id; a stale one is dropped", async () => {
    const [s0] = initialSystem(orderMachine);
    const [s1, fx] = systemTransition(orderMachine, s0, "root", { type: "checkout" });
    const task = fx.find((e) => e.type === "task");
    if (task?.type !== "task") throw new Error("no task");
    const event = await runSystemTask(orderMachine, s1, task, new AbortController().signal);
    expect<unknown>(event).toEqual({ type: "charged", id: "ch_10" });
    const [s2] = systemTransition(orderMachine, s1, task.id, event);
    expect(rootOf(s2).state).toBe("placed");
    const [s3] = systemTransition(orderMachine, s2, task.id, event);
    expect(s3).toEqual(s2);
    // A failure goes to the task's error.
    const [s4] = systemTransition(orderMachine, s1, task.id, { type: "@error", error: new Error("card") } as never);
    expect(rootOf(s4).state).toBe("cancelled");
  });

  test("advanceSystemTime fires each due timer at its own deadline, in order", () => {
    const [s0] = initialSystem(orderMachine);
    const [s1] = systemTransition(orderMachine, s0, "root", { type: "checkout" });
    const [s2] = advanceSystemTime(orderMachine, s1, { time: 2999 });
    expect(rootOf(s2).state).toBe("paying");
    // At 3000 the payment declines (its own timer), which ends the order before its 5s timer.
    const [s3] = advanceSystemTime(orderMachine, s2, { time: 6000 });
    expect(rootOf(s3)).toEqual({ state: "cancelled", data: {}, version: 0 });
    expect(s3.time).toBe(6000);
    expect(() => advanceSystemTime(orderMachine, s3, { time: 10 })).toThrow("S35");
  });

  test("a child's update moves its parent on each of its moves", () => {
    const [s0] = initialSystem(orderMachine);
    const [s1] = systemTransition(orderMachine, s0, "root", { type: "checkout" });
    const [s2] = systemTransition(orderMachine, s1, "root/payment", { type: "decline" });
    expect(rootOf(s2).state).toBe("cancelled");
    expect(() => systemTransition(orderMachine, s1, "root/nobody", { type: "x" })).toThrow("S34");
  });

  test("leaving the node stops a child that is still running: its timer goes, and its task is cancelled", () => {
    const [s0] = initialSystem(orderMachine);
    const [s1] = systemTransition(orderMachine, s0, "root", { type: "checkout" });
    const [s2, fx2] = systemTransition(orderMachine, s1, "root", { type: "cancel" });
    expect(rootOf(s2)).toEqual({ state: "cancelled", data: {}, version: 0 });
    expect(s2.actors["root/payment"]).toBeUndefined();
    expect(s2.timers).toEqual([]);
    expect(s2.tasks).toEqual({});
    expect(s2.registry).toEqual({});
    expect(fx2).toEqual([{ type: "cancel", id: "task:2" }]);
  });

  test("keyed children: one per key, started and stopped as the data changes; each move updates the parent", () => {
    const [s0] = initialSystem(batchMachine);
    expect(Object.keys(s0.actors)).toEqual(["root", "root/transfer:a"]);
    const add = { type: "add", file: "b" };
    const [s1] = systemTransition(batchMachine, s0, "root", add);
    expect(Object.keys(s1.actors)).toEqual(["root", "root/transfer:a", "root/transfer:b"]);
    expect(s1.actors["root/transfer:b"]).toMatchObject({ parent: "root", node: "sending", name: "transfer", key: "b" });
    const progress = { type: "progress", pct: 40 };
    const [s2] = systemTransition(batchMachine, s1, "root/transfer:b", progress);
    expect(rootOf(s2)).toEqual({ state: "sending", data: { files: ["a", "b"], pct: 40 }, version: 0 });
    // a ends: its done drops it from the data, and the reconcile stops it.
    const [s3] = systemTransition(batchMachine, s2, "root/transfer:a", { type: "finish" });
    expect(rootOf(s3).data).toEqual({ files: ["b"], pct: 40 });
    expect(Object.keys(s3.actors)).toEqual(["root", "root/transfer:b"]);
  });

  test("a child and its parent that keep reporting to each other throw S36", () => {
    expect(() => initialSystem(pingPongMachine)).toThrow(
      /S36\] the system kept moving after 10000 steps: a child and its parent keep reporting to each other/,
    );
  });

  test("a timer that keeps scheduling itself throws S36 past 10000 timers", () => {
    const [s0] = initialSystem(blinkerMachine);
    const [s1] = advanceSystemTime(blinkerMachine, s0, { time: 3500 });
    expect(rootOf(s1).state).toBe("off");
    expect(s1.timers).toMatchObject([{ actor: "root", node: "off", due: 4000 }]);
    expect(() => advanceSystemTime(blinkerMachine, s1, { time: 20_000_000 })).toThrow(
      /S36\] the system kept moving after 10000 timers: a timer keeps scheduling itself/,
    );
  });

  test("a logic child throws S33: its work runs only in a live actor", () => {
    const [s0] = initialSystem(userMachine);
    expect(() => systemTransition(userMachine, s0, "root", { type: "load" })).toThrow(
      /S33\].*child "load" is actor logic \(load\), whose work runs only in a live actor/,
    );
  });

  test("runSystemTask of a task the machine doesn't have throws S34", () => {
    const [s0] = initialSystem(orderMachine);
    const effect = { type: "task", id: "task:9", actor: "root", node: "cart", state: "cart", data: {} } as const;
    expect(() => runSystemTask(orderMachine, s0, effect, new AbortController().signal)).toThrow(
      /S34\] the system has no task at "root" in "cart"/,
    );
  });
});
