// A child's life after its parent cancels or restarts, compiled: the parent's "busy" node runs a
// "job" child; cancelling leaves the node and stops the child; going again starts a new one with
// a new id; stopping the parent stops the child. The machine is ./fixtures/children/lifecycle.ts.

import { beforeEach, describe, expect, test } from "bun:test";

import "../compiled.ts";

const { createActor } = await import("@reactre/state");
const { child } = await import("@reactre/state/children");
const { log, parentMachine } = await import("./fixtures/children/lifecycle.ts");

beforeEach(() => {
  log.length = 0;
});

describe("a child's life after its parent cancels or restarts", () => {
  test("cancelling the parent's node stops the child, and going again starts a new one", () => {
    const actor = createActor(parentMachine);
    actor.send({ type: "go" });
    expect(log).toEqual(["start job-1"]);
    const first = child(actor, "job");
    expect(first?.status()).toBe("active");
    actor.send({ type: "cancel" });
    // The child stopped with its node: the parent is back in idle, and the child is gone.
    expect(actor.snapshot()).toMatchObject({ state: "idle", data: { n: 1 } });
    expect(first?.status()).toBe("stopped");
    expect(child(actor, "job")).toBeUndefined();
    actor.send({ type: "go" });
    // A new entry, a new child: a new id, not the old one resumed.
    expect(log).toEqual(["start job-1", "start job-2"]);
    expect(child(actor, "job")?.status()).toBe("active");
    actor.stop();
  });

  test("stopping the parent stops the child", () => {
    const actor = createActor(parentMachine);
    actor.send({ type: "go" });
    const job = child(actor, "job");
    expect(job?.status()).toBe("active");
    actor.stop();
    expect(actor.status()).toBe("stopped");
    expect(job?.status()).toBe("stopped");
    // A send to the stopped parent is refused.
    expect(actor.send({ type: "go" })).toMatchObject({ ok: false, reason: "inactive" });
  });

  test("the child's done moves the parent, and the parent's final state ends it", () => {
    const actor = createActor(parentMachine);
    actor.send({ type: "go" });
    const job = child(actor, "job");
    if (job === undefined) throw new Error("no job child");
    job.send({ type: "finish" });
    expect(actor.snapshot()).toMatchObject({ state: "finished", data: { n: 1 } });
    expect(actor.status()).toBe("done");
  });
});
