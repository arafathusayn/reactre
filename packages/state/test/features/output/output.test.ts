// output: a parent completes when a leaf under it is final, and a final leaf's data is its output.

import { describe, expect, test } from "bun:test";

import type { Output } from "@reactre/state/output";

import "../../compiled.ts";
import { optIn } from "../opt-in.ts";

const { createActor, initial, transition } = await import("@reactre/state");
const { jobMachine, uploadMachine } = await import("./machines.ts");

describe("output", () => {
  optIn("output");

  test("a parent's done gets its final leaf, in the step that reached it", () => {
    const sending = transition(uploadMachine, initial(uploadMachine, undefined), {
      type: "send",
      file: "a.png",
    }).snapshot;
    expect(transition(uploadMachine, sending, { type: "ok" }).snapshot).toEqual({
      state: "uploaded",
      data: { url: "/files/a.png" },
      version: 0,
    });
    expect(transition(uploadMachine, sending, { type: "fail", reason: "offline" }).snapshot).toMatchObject({
      state: "gaveUp",
      data: { reason: "offline" },
    });
  });

  test("the actor's output is its last snapshot, typed by Output", () => {
    const actor = createActor(uploadMachine);
    const seen: string[] = [];
    actor.subscribe((s) => seen.push(s.state));
    actor.send({ type: "send", file: "b" });
    actor.send({ type: "ok" });
    expect(actor.status()).toBe("done");
    expect(seen).toEqual(["upload.sending", "uploaded"]);
    const out: Output<typeof uploadMachine> = { state: "uploaded", data: { url: "/files/b" } };
    expect(actor.snapshot()).toMatchObject(out);
  });

  test("a parent inside a region completes before the region ends, then the parallel node's done runs", () => {
    const actor = createActor(jobMachine);
    actor.send({ type: "got", body: "hi" });
    expect(actor.snapshot()).toMatchObject({
      state: "work",
      data: { fetch: { state: "work.fetch.ok", data: { body: "hi" } } },
    });
    actor.send({ type: "quiet" });
    expect(actor.snapshot()).toEqual({ state: "finished", data: { body: "hi" }, version: 0 });
    expect(actor.status()).toBe("done");
  });
});
