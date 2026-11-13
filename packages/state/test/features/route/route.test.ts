// route: go to a routable node from anywhere with `{ type: "route", to }`.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor, initial, transition } = await import("@reactre/state");
const { shopMachine } = await import("./machines.ts");

describe("route", () => {
  optIn("route");

  test("compiles to ro, the route event in e, and a step around the one before it", () => {
    const code =
      compile(
        "door.ts",
        change(
          withUse(["route"]),
          "locked: { on:",
          'locked: { route: ({ data, to }) => to("locked", { code: "" }), on:',
        ),
      )?.code ?? "";
    expect(code).toContain('e: { "push": 1, "close": 1, "lock": 1, "unlock": 1, "route": 1 }');
    expect(code).toContain('ro: { "locked": (data) => ({ state: "locked", data: { code: "" }, version: 0 }) }');
    expect(code).toContain("y: route.y()");
  });

  test("a route goes to its node from anywhere, and its null refuses", () => {
    const home = initial(shopMachine, undefined);
    expect(transition(shopMachine, home, { type: "route", to: "checkout" })).toMatchObject({
      ok: false,
      reason: "declined",
    });
    const cart = transition(shopMachine, home, { type: "add" }).snapshot;
    expect(transition(shopMachine, cart, { type: "route", to: "checkout" })).toEqual({
      ok: true,
      snapshot: { state: "checkout", data: { items: 1 }, version: 0 },
    });
    expect(transition(shopMachine, cart, { type: "route", to: "home" }).snapshot.state).toBe("home");
  });

  test("an actor takes it like any event; a node without a route is unhandled", () => {
    const actor = createActor(shopMachine);
    actor.send({ type: "add" });
    actor.send({ type: "route", to: "checkout" });
    actor.send({ type: "pay", id: "r1" });
    expect(actor.snapshot()).toEqual({ state: "receipt", data: { id: "r1" }, version: 0 });
    const other = createActor(shopMachine);
    // Untyped code: a node without a route (`as never`: the types refuse an any event, M429).
    expect(other.send(JSON.parse('{ "type": "route", "to": "cart" }') as never)).toMatchObject({
      ok: false,
      reason: "unhandled",
    });
  });
});
