// choice: states that decide and never rest, compiled as a build compiles them.

import { describe, expect, test } from "bun:test";

import "../../compiled.ts";
import { optIn } from "../opt-in.ts";

const { createActor, initial, transition } = await import("@reactre/state");
const { orderMachine } = await import("./machines.ts");

describe("choice", () => {
  optIn("choice");

  test("the start goes through a choice: the first snapshot is where it decided", () => {
    expect(initial(orderMachine, undefined)).toEqual({ state: "idle", data: {}, version: 0 });
  });

  test("each branch, in the step that entered the choice", () => {
    const idle = initial(orderMachine, undefined);
    for (const [event, state] of [
      [{ type: "checkout", total: 10, vip: true }, "vip"],
      [{ type: "checkout", total: 500, vip: false }, "review"],
      [{ type: "checkout", total: 10, vip: false }, "standard"],
    ] as const)
      expect(transition(orderMachine, idle, event)).toMatchObject({
        ok: true,
        snapshot: { state, data: { total: event.total } },
      });
  });

  test("an actor's listeners never see the choice", () => {
    const actor = createActor(orderMachine);
    const seen: string[] = [];
    actor.subscribe((s) => seen.push(s.state));
    actor.send({ type: "checkout", total: 5, vip: false });
    actor.send({ type: "reset" });
    expect(seen).toEqual(["standard", "idle"]);
  });
});
