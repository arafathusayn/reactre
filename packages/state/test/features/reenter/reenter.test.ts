// reenter: a move that exits and enters its leaf again, so its timers restart.

import { describe, expect, test } from "bun:test";

import { compile } from "@reactre/state/compiler";

import "../../compiled.ts";
import { change, JOB, withUse } from "../../sources.ts";
import { optIn } from "../opt-in.ts";

const { createActor, initial, transition } = await import("@reactre/state");
const { fetcherMachine } = await import("./machines.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reenter", () => {
  optIn("reenter");

  test("compiles to its to's step marked r, its graph, and the general lifecycle", () => {
    const code =
      compile(
        "job.ts",
        change(
          withUse(["reenter"], JOB),
          'retry: ({ to }) => to("idle")',
          'retry: ({ data, reenter }) => reenter("failed", { error: data.error })',
        ),
      )?.code ?? "";
    expect(code).toContain(
      '"retry": (data) => ({ r: ({ state: "failed", data: { error: data.error }, version: 0 }) })',
    );
    expect(code).toContain("g: reenter.g()");
    expect(code).toContain("re: reenter.re");
    // The small general lifecycle: it keeps the `m.re` check reenter needs, and this machine has
    // no children, effects, persist or parallel node.
    expect(code).toContain("r: __reactreStateRunNested([__reactreStateTasks])");
  });

  test("the snapshot is what to would give", () => {
    const r = transition(fetcherMachine, initial(fetcherMachine, undefined), { type: "retry" });
    expect(r).toEqual({ ok: true, snapshot: { state: "loading", data: { attempt: 2 }, version: 0 } });
  });

  test("reenter restarts the leaf's timer; to the same leaf keeps it", async () => {
    const kept = createActor(fetcherMachine);
    const again = createActor(fetcherMachine);
    await wait(20);
    kept.send({ type: "nudge" });
    again.send({ type: "retry" });
    await wait(20); // 40ms after the start, 20ms after the retry
    expect(kept.snapshot().state).toBe("timedOut");
    expect(again.snapshot()).toMatchObject({ state: "loading", data: { attempt: 2 } });
    await wait(25);
    expect(again.snapshot()).toMatchObject({ state: "timedOut", data: { attempt: 2 } });
  });
});
