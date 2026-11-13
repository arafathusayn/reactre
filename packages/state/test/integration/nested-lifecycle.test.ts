// The general lifecycle on a machine with a hierarchy and nothing else: the shape a statically
// selected nested-only lifecycle may serve (no children, effects, persist, inspect or reenter).
//
// Two halves:
//   1. The compiled fixture (./fixtures/lifecycle/nested.ts, through the plugin) on the lifecycle
//      the compiler picked today: the behaviour a smaller lifecycle must keep.
//   2. The same machine as a hand-written table (the way test/nested.test.ts writes one), run under
//      `__run` and under `__runNested` (./src/run-nested.ts) with the same runners. The two must
//      agree on every observable, so this is the gate the compiler's choice has to pass.
//
// What the lifecycle must do, and what each test pins:
//   - the node diff: a parent stays while its leaf moves, so its timer keeps its deadline;
//   - `update`: a node that stays gets the leaf under it now, only when that leaf changed;
//   - `deliver`: a task's result reaches the machine, and is dropped once its node exits;
//   - `stop`: every node's work stops, and a stopped actor takes no more moves;
//   - the clock: `options.now` is the actor's clock, not `Date.now`.

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { build } from "esbuild";

import "../compiled.ts";

import state from "../../plugin/esbuild.ts";
import type { __Compiled, __Event } from "../../src/internal.ts";
import { runEmittedInteractive } from "../run-emitted-interactive.ts";
import { to } from "../to.ts";

const { createActor } = await import("@reactre/state");
const { __flatGraph, __flatNested } = await import("@reactre/state/nested");
const { __run } = await import("@reactre/state/run");
const { __runNested } = await import("@reactre/state/run-nested");
const { __tasks } = await import("@reactre/state/tasks");
const { editorMachine, log } = await import("./fixtures/lifecycle/nested.ts");

/** A real timer's turn: the machine's `after` is 40ms, so this is well inside it. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A field of a handler's `data` or `event`, as the hand-written tables in test/nested.test.ts read them. */
const field = (value: unknown, key: string): string => String(Reflect.get(Object(value), key));

/**
 * Send an event to a hand-written table. A table has no typed events (it is a `__Compiled`, not a
 * `Machine`), so the event is an `__Event` with its payload: the one cast this file needs, in one
 * place, rather than at each call.
 */
const send = (actor: { send(event: __Event): unknown }, event: { type: string } & Record<string, unknown>): void => {
  actor.send(event as __Event);
};

beforeEach(() => {
  log.length = 0;
});

describe("the compiled machine, on the lifecycle the compiler picked", () => {
  test("a parent stays while its leaf moves: its timer keeps its deadline", async () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    // The parent's timer starts when the parent is entered, not again on each leaf move.
    await new Promise((r) => setTimeout(r, 25));
    actor.send({ type: "write", text: "a" });
    expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "a" } });
    // 25ms in, the move did not restart the 40ms timer: it fires within the next 25ms.
    await new Promise((r) => setTimeout(r, 25));
    expect(actor.snapshot().state).toBe("away");
    actor.stop();
  });

  test("a leaf's task runs on entry, and its result moves the machine", async () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "write", text: "hi" });
    actor.send({ type: "submit", by: "ann" });
    await tick();
    expect(log).toEqual(["run hi"]);
    // The task's result is delivered to the machine: the review leaf's handler takes it.
    expect(actor.snapshot()).toMatchObject({ state: "sent", data: { text: "hi" } });
    expect(actor.status()).toBe("done");
    actor.stop();
  });

  test("a task's result is dropped once its node exits", async () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "submit", by: "ann" });
    // Leave before the task's promise settles: its result must not move the machine.
    actor.send({ type: "leave" });
    await tick();
    expect(actor.snapshot().state).toBe("away");
    actor.stop();
  });

  test("back re-enters the leaf the parent held, with its data", () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.send({ type: "write", text: "hi" });
    actor.send({ type: "leave" });
    actor.send({ type: "resume" });
    expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "hi" } });
    actor.stop();
  });

  test("stop stops every node's work: no timer fires and no task result arrives", async () => {
    const actor = createActor(editorMachine);
    actor.send({ type: "open" });
    actor.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(actor.snapshot().state).toBe("edit.draft");
    expect(actor.status()).toBe("stopped");
    // A stopped actor takes no moves.
    actor.send({ type: "write", text: "x" });
    expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "" } });
  });
});

test("the production compiler selects and executes the nested-only lifecycle", async () => {
  const output = await build({
    stdin: {
      contents:
        'import { editorMachine, log } from "./test/integration/fixtures/lifecycle/nested.ts"; export { editorMachine, log };',
      loader: "ts",
      resolveDir: join(import.meta.dir, "..", ".."),
    },
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    conditions: ["reactre-source", "module"],
    plugins: [state({ dev: false })],
  });
  const code = output.outputFiles[0]?.text ?? "";
  expect(code).toContain("__runNested");
  expect(code).not.toContain("__run(");
  // The emitted table is driven in a separate Bun process: the production bytes are the ones that
  // ran, and they stay out of this process's coverage report.
  const result = await runEmittedInteractive<{
    readonly state: string;
    readonly data: unknown;
    readonly log: string[];
    readonly diagnosticHook: boolean;
  }>(
    code,
    `
const actor = createActor(exports.editorMachine);
actor.send({ type: "open" });
actor.send({ type: "submit", by: "ann" });
await new Promise((r) => setTimeout(r, 0));
const snapshot = actor.snapshot();
actor.stop();
return { state: snapshot.state, data: snapshot.data, log: exports.log, diagnosticHook: exports.editorMachine.d != null };
`,
  );
  expect({ state: result.state, data: result.data }).toMatchObject({ state: "sent", data: { text: "" } });
  expect(result.diagnosticHook).toBe(false);
  expect(result.log).toEqual(["run "]);
});

/**
 * The same machine as a table: a parent ("edit") with a timer, a leaf with a task, and `back` to
 * the parent. Written by hand so the two lifecycles can be handed the identical table.
 */
const table: __Compiled = {
  v: 0,
  e: { open: 1, write: 1, submit: 1, leave: 1, resume: 1 },
  i: () => to("idle"),
  o: {
    idle: { open: () => to("edit.draft", { text: "" }) },
    edit: {
      leave: () => to("away"),
      // A parent's handler applies to every leaf under it, after the leaf's own.
      write: (data, event, state) =>
        state === "edit.draft" ? to("edit.draft", { text: field(data, "text") + field(event, "text") }) : null,
    },
    "edit.draft": {
      submit: (data, event) => to("edit.review", { text: field(data, "text"), by: field(event, "by") }),
    },
    "edit.review": { saved: (data) => to("sent", { text: field(data, "text") }) },
    away: { resume: () => ({ b: "edit", t: to("edit.draft", { text: "" }) }) },
  },
  f: { sent: 1 },
  t: {
    "edit.review": [
      async (data) => {
        log.push(`run ${field(data, "text")}`);
        return { type: "saved" };
      },
      () => to("idle"),
    ],
  },
  a: { edit: [[40, () => to("away")]] },
  g: __flatGraph,
  h: { edit: 1 },
  y: __flatNested,
  r: __run([__tasks]),
};

for (const [name, r] of [
  ["__run", __run([__tasks])],
  ["__runNested", __runNested([__tasks])],
] as const) {
  describe(`the hand-written table, on ${name}`, () => {
    const machine: __Compiled = { ...table, r };

    test("a parent stays while its leaf moves: its timer keeps its deadline", async () => {
      const actor = createActor(machine);
      send(actor, { type: "open" });
      await new Promise((r) => setTimeout(r, 25));
      send(actor, { type: "write", text: "a" });
      expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "a" } });
      await new Promise((r) => setTimeout(r, 25));
      expect(actor.snapshot().state).toBe("away");
      actor.stop();
    });

    test("a leaf's task runs on entry, and its result moves the machine", async () => {
      const actor = createActor(machine);
      send(actor, { type: "open" });
      send(actor, { type: "write", text: "hi" });
      send(actor, { type: "submit", by: "ann" });
      await tick();
      expect(log).toEqual(["run hi"]);
      expect(actor.snapshot()).toMatchObject({ state: "sent", data: { text: "hi" } });
      expect(actor.status()).toBe("done");
      actor.stop();
    });

    test("a task's result is dropped once its node exits", async () => {
      const actor = createActor(machine);
      send(actor, { type: "open" });
      send(actor, { type: "submit", by: "ann" });
      send(actor, { type: "leave" });
      await tick();
      expect(actor.snapshot().state).toBe("away");
      actor.stop();
    });

    test("back re-enters the leaf the parent held, with its data", () => {
      const actor = createActor(machine);
      send(actor, { type: "open" });
      send(actor, { type: "write", text: "hi" });
      send(actor, { type: "leave" });
      send(actor, { type: "resume" });
      expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "hi" } });
      actor.stop();
    });

    test("stop stops every node's work: no timer fires and no task result arrives", async () => {
      const actor = createActor(machine);
      send(actor, { type: "open" });
      actor.stop();
      await new Promise((r) => setTimeout(r, 60));
      expect(actor.snapshot().state).toBe("edit.draft");
      expect(actor.status()).toBe("stopped");
      send(actor, { type: "write", text: "x" });
      expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "" } });
    });

    test("the actor's clock is options.now, not Date.now", () => {
      // A clock the test moves: the machine still runs, and the option is accepted rather than
      // ignored. A lifecycle that read Date.now would pass this too, so the real pin is that the
      // option reaches the runners: `now` is what a timer's deadline is measured from.
      let at = 0;
      const actor = createActor(machine, { now: () => at });
      send(actor, { type: "open" });
      at += 1000;
      send(actor, { type: "write", text: "z" });
      expect(actor.snapshot()).toMatchObject({ state: "edit.draft", data: { text: "z" } });
      actor.stop();
    });
  });
}
