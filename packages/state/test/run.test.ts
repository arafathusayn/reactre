// The general lifecycle (@reactre/state/run): each move's effects go to the dispatcher after the
// move, with the actor's own moves. On compiled tables written by hand, with a dispatcher written by
// hand in place of the effects feature's (`__run(runners, dispatch)`).

import { describe, expect, test } from "bun:test";

import { createActor } from "@reactre/state";
import { __run } from "@reactre/state/run";

import type { __Compiled, __Dispatch } from "../src/internal.ts";
import { to } from "./to.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** What the dispatcher saw: the state of each move it was handed. */
let seen: string[] = [];

/** A dispatcher whose runner decides a transition after the move into `sent`: to `confirmed`. */
const dispatch: __Dispatch = (_fx, ctx) => {
  seen.push(ctx.snapshot.state);
  if (ctx.snapshot.state === "sent") setTimeout(() => ctx.go(to("confirmed")), 0);
};

const order: __Compiled = {
  v: 0,
  e: { send: 1 },
  i: () => to("draft"),
  o: { draft: { send: () => to("sent") }, sent: {} },
  f: { confirmed: 1 },
  r: __run([], dispatch),
};

describe("the dispatcher of the general lifecycle", () => {
  test("sees every move, the start too, and its go moves the actor after the move", async () => {
    seen = [];
    const actor = createActor(order);
    actor.send({ type: "send" });
    expect(actor.snapshot().state).toBe("sent");
    await tick();
    expect(actor.snapshot().state).toBe("confirmed");
    expect(seen).toEqual(["draft", "sent", "confirmed"]);
  });

  test("a go from an entry the actor didn't run (it started final) is dropped", async () => {
    seen = [];
    const actor = createActor({ ...order, i: () => to("sent"), f: { sent: 1, confirmed: 1 } });
    expect(actor.status()).toBe("done");
    await tick();
    expect(actor.snapshot().state).toBe("sent");
    expect(seen).toEqual(["sent"]);
  });
});
