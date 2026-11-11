// provide: named actions and guards in setup, and `provide(machine, { actions, delays })`. The
// machines are ../effects/machines.ts's order and reminder, compiled by the preload plugin.

import { beforeEach, describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor, transition } = await import("@reactre/state");
const { provide } = await import("@reactre/state/provide");
const { orderMachine, reminderMachine, seen } = await import("../effects/machines.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  seen.length = 0;
});

describe("provide", () => {
  optIn("provide");

  test("listing it on a machine that uses no named source adds nothing", () => {
    expect(compile("door.ts", withUse(["effects", "provide"]))?.code).not.toContain("provide.");
  });
});

describe("named actions and guards", () => {
  test("a named action is data: its name and params", () => {
    const r = transition(orderMachine, { state: "cart", data: { total: 150 }, version: 0 }, { type: "submit" });
    expect(r.ok && r.fx).toEqual([
      { type: "action", name: "track", params: { key: "big" } },
      { type: "action", name: "reset", params: undefined },
    ]);
  });

  test("a guard decides during the transition", () => {
    expect(transition(orderMachine, { state: "cart", data: { total: 50 }, version: 0 }, { type: "submit" })).toEqual({
      ok: false,
      reason: "declined",
      snapshot: { state: "cart", data: { total: 50 }, version: 0 },
    });
  });

  test("an actor runs setup's implementations", () => {
    createActor(orderMachine).send({ type: "submit" });
    expect(seen).toEqual(["track big", "reset"]);
  });

  test("provide replaces them, and leaves the machine as it was", () => {
    const calls: string[] = [];
    const fake = provide(orderMachine, { actions: { track: (params) => calls.push(params.key) } });
    createActor(fake).send({ type: "submit" });
    expect(calls).toEqual(["big"]);
    expect(seen).toEqual(["reset"]);
    seen.length = 0;
    createActor(orderMachine).send({ type: "submit" });
    expect(seen).toEqual(["track big", "reset"]);
  });
});

describe("provide's delays", () => {
  test("replace a named delay, a static one or a function of the data", async () => {
    const quick = provide(reminderMachine, { delays: { sla: 0, soon: 0 } });
    const actor = createActor(quick);
    actor.send({ type: "start", ms: 1000 });
    await tick(5);
    // These are two timer callbacks, not one settling event: waiting's sla enters late, then
    // late's zero timeout enters done. A second turn keeps an independently pending 5ms timer
    // from observing the intermediate state when other suite work delayed both callbacks.
    await tick(0);
    // sla (0) fired before the timeout (1000ms), and late's timeout ("soon", 0) after it.
    expect(actor.snapshot().state).toBe("done");
    actor.stop();
  });
});
