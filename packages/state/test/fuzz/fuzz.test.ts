// The differential fuzz: seeded machines, run three ways (the independent reference, the compiler's
// development output, its production output), compared on every observable. A failure names the
// seed, the contract and the minimal event sequence, so it reruns from the seed alone.
//
// The reference (./reference.ts) is the oracle: it interprets the spec with no compiler and no
// runtime, so agreement is evidence the compiled machine is right, not that two compiled outputs
// agree with each other. The generated source is valid TypeScript (./generate.ts), and a batch of it
// is held to `bun check` here, so a generated machine is one a person could write.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generate, render } from "./generate.ts";
import {
  cleanup,
  describe as describeDivergence,
  differential,
  differentialAsync,
  firstDifference,
  load,
  samples,
  SCRATCH,
  shrink,
  traceCompiled,
  traceCompiledAsync,
  traceReference,
  traceReferenceAsync,
} from "./harness.ts";
import type { RefEvent } from "./reference.ts";
import type { Spec } from "./spec.ts";

afterAll(cleanup);

/** How many seeds the flat differential runs (each with a walk of events). */
const SEEDS = 40;
/** How many events each seed's walk sends. */
const STEPS = 12;

describe("flat machines: reference vs dev vs prod", () => {
  test(`${SEEDS} seeds, ${STEPS} events each, agree on every step`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const spec = generate(seed);
      const events = samples(spec, seed, STEPS);
      const divergence = await differential(spec, events);
      if (divergence === null) continue;
      // Shrink to a minimal failing sequence, then report it.
      const minimal = await shrink(spec, events);
      const shrunk = await differential(spec, minimal);
      failures.push(describeDivergence(shrunk ?? divergence));
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

describe("nested machines: a parent's handlers apply to its leaves", () => {
  test(`${SEEDS} seeds with a parent, ${STEPS} events each, agree on every step`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const spec = generate(seed, { nested: true });
      const events = samples(spec, seed, STEPS);
      const divergence = await differential(spec, events);
      if (divergence === null) continue;
      const minimal = await shrink(spec, events);
      failures.push(describeDivergence((await differential(spec, minimal)) ?? divergence));
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

describe("async machines: tasks and timers, on a simulated clock", () => {
  // The same walks as browser-fuzz: an original browser counterexample (seed 5, a timer to its own
  // leaf) showed the model restarting work a stay must keep. A corrected model is not a runtime change.
  const ASYNC_SEEDS = 8;
  const ASYNC_STEPS = 12;
  test(`${ASYNC_SEEDS} seeds with tasks and timers, ${ASYNC_STEPS} events each, agree on every step`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= ASYNC_SEEDS; seed++) {
      const spec = generate(seed, { nested: seed % 2 === 0, async: true, states: 4, events: 3 });
      const events = samples(spec, seed, ASYNC_STEPS);
      // The clock moves 3ms after each event: a task (a microtask) and a timer of 1–5ms both fire.
      const divergence = await differentialAsync(spec, events, 3);
      if (divergence === null) continue;
      failures.push(describeDivergence(divergence));
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe("async arrival boundaries: a hand-computed trace pins every host phase", () => {
  type ArrivalCase = {
    name: string;
    spec: Spec;
    events: RefEvent[];
    states: string[];
    accepted: boolean[];
    refused: (string | null)[];
  };
  const cases: ArrivalCase[] = [
    {
      name: "the start task lands before the first clock advance",
      spec: {
        seed: 10_001,
        version: 0,
        states: ["busy", "idle", "ready", "done"].map((name) => ({ name, fields: [] })),
        events: [{ name: "go", fields: [] }],
        start: { state: "busy", data: [] },
        final: ["done"],
        transitions: [
          { from: "busy", event: "loaded", guard: { kind: "always" }, to: "idle", data: { kind: "none" } },
          { from: "idle", event: "go", guard: { kind: "always" }, to: "ready", data: { kind: "none" } },
          { from: "ready", event: "go", guard: { kind: "always" }, to: "done", data: { kind: "none" } },
          { from: "done", event: "go", guard: { kind: "always" }, to: "done", data: { kind: "none" } },
        ],
        tasks: [{ state: "busy", event: "loaded", payload: [], ms: 0, fails: false, onError: "done" }],
        timers: [{ state: "idle", ms: 3, to: "ready", data: { kind: "none" } }],
      },
      events: [{ type: "go" }, { type: "go" }],
      // Event 0 is sent synchronously, while the start task's result is still pending: busy declines.
      // After its first yield the machine is idle; after advancing to 3ms it is ready, so go finishes.
      // The final event is inert: no late busy result can revive the finished machine.
      states: ["busy", "done"],
      accepted: [false, true],
      refused: ["unhandled", null],
    },
    {
      name: "a same-leaf timer is consumed, not used to restart its sibling timer",
      spec: {
        seed: 10_002,
        version: 0,
        states: ["working", "done"].map((name) => ({ name, fields: [] })),
        events: [{ name: "go", fields: [] }],
        start: { state: "working", data: [] },
        final: ["done"],
        transitions: [{ from: "working", event: "go", guard: { kind: "always" }, to: "done", data: { kind: "none" } }],
        timers: [
          { state: "working", ms: 1, to: "working", data: { kind: "none" } },
          { state: "working", ms: 3, to: "done", data: { kind: "none" } },
        ],
      },
      events: [{ type: "wait" }, { type: "go" }],
      // Event 0 is an unknown observation event: its send does not move. By event 1 the 1ms
      // self-move has happened and the original 3ms exit has fired, rather than starting again then.
      // The final actor is inactive, so that observation rejects in done.
      states: ["working", "done"],
      accepted: [false, false],
      refused: ["unknown", "inactive"],
    },
    {
      name: "a timer-created task waits for the later host yield",
      spec: {
        seed: 10_003,
        version: 0,
        states: ["waiting", "running", "ready", "done"].map((name) => ({ name, fields: [] })),
        events: [{ name: "stop", fields: [] }],
        start: { state: "waiting", data: [] },
        final: ["done"],
        transitions: [
          { from: "waiting", event: "stop", guard: { kind: "always" }, to: "done", data: { kind: "none" } },
          { from: "running", event: "finished", guard: { kind: "always" }, to: "ready", data: { kind: "none" } },
          { from: "running", event: "stop", guard: { kind: "always" }, to: "done", data: { kind: "none" } },
          { from: "ready", event: "stop", guard: { kind: "always" }, to: "done", data: { kind: "none" } },
        ],
        tasks: [{ state: "running", event: "finished", payload: [], ms: 0, fails: false, onError: "done" }],
        timers: [{ state: "waiting", ms: 3, to: "running", data: { kind: "none" } }],
      },
      events: [{ type: "wait" }, { type: "stop" }, { type: "stop" }],
      // Event 0 is an unknown observation event. The advance enters running and the later host
      // yield delivers its task: event 1 sees ready, not running. It finishes before event 2.
      states: ["waiting", "done", "done"],
      accepted: [false, true, false],
      refused: ["unknown", null, "inactive"],
    },
    {
      name: "a competing timer cancels the task a just-entered leaf started",
      spec: {
        seed: 10_004,
        version: 0,
        states: ["waiting", "running", "ready", "away", "done"].map((name) => ({ name, fields: [] })),
        events: [{ name: "go", fields: [] }],
        start: { state: "waiting", data: [] },
        final: ["done"],
        transitions: [
          { from: "running", event: "finished", guard: { kind: "always" }, to: "ready", data: { kind: "none" } },
          { from: "away", event: "go", guard: { kind: "always" }, to: "done", data: { kind: "none" } },
        ],
        tasks: [{ state: "running", event: "finished", payload: [], ms: 0, fails: false, onError: "done" }],
        timers: [
          { state: "waiting", ms: 3, to: "running", data: { kind: "none" } },
          { state: "running", ms: 0, to: "away", data: { kind: "none" } },
        ],
      },
      events: [{ type: "go" }, { type: "go" }, { type: "go" }],
      // Event 0 is an unknown observation event. Both callbacks are due in its following advance:
      // running's 0ms timer exits before the task delivers. Event 1 sees away, not ready, and go
      // accepts exactly once; if the stale task delivered ready, that go would be unhandled.
      states: ["waiting", "done", "done"],
      accepted: [false, true, false],
      refused: ["unhandled", null, "inactive"],
    },
  ];

  for (const { name, spec, events, states, accepted, refused } of cases) {
    test(name, async () => {
      const expected = traceReferenceAsync(spec, events, 3);
      expect(expected.steps.map(({ state }) => state)).toEqual(states);
      expect(expected.steps.map(({ ok }) => ok)).toEqual(accepted);
      // Pin the rejection cause too: the trace must distinguish a too-early event from a finished
      // actor, rather than simply agreeing that both returned `ok: false`.
      expect(expected.steps.map(({ reason }) => reason ?? null)).toEqual(refused);
      expect(expected.start).toEqual({ state: spec.start.state, data: {}, version: 0 });
      for (const [variant, machine] of await Promise.all(
        (["src", "dev", "prod"] as const).map(async (variant) => [variant, await load(spec, variant)] as const),
      )) {
        expect(await traceCompiledAsync(machine, events, 3), `${spec.seed}: ${variant}`).toEqual(expected);
      }
    });
  }
});

describe("parallel machines: each region takes the event, then the node's own handlers", () => {
  test(`${SEEDS} seeds with a parallel node, ${STEPS} events each, agree on every step`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const spec = generate(seed, { parallel: true });
      const events = samples(spec, seed, STEPS);
      const divergence = await differential(spec, events);
      if (divergence === null) continue;
      const minimal = await shrink(spec, events);
      failures.push(describeDivergence((await differential(spec, minimal)) ?? divergence));
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

describe("the differential is not vacuous", () => {
  test("a reference that disagrees with the machine is caught, at the step it diverges", async () => {
    // The same spec, but the reference is told the start state is a different one: the traces must
    // differ at step 0, so a harness that always passes would fail this.
    const spec = generate(3);
    const events = samples(spec, 3, 6);
    const machine = await load(spec, "prod");
    const actual = await traceCompiled(machine, events);
    const wrong = traceReference({ ...spec, start: { ...spec.start, state: spec.states.at(-1)!.name } }, events);
    expect(firstDifference(wrong, actual)).toBe(0);
    // And the real reference agrees with the same machine, so the check above isn't a broken trace.
    expect(firstDifference(traceReference(spec, events), actual)).toBeNull();
  });

  test("a reference that moves on a declined event is caught", async () => {
    // A spec whose every guard is `always` moves where the real one declines: the first event that
    // the real machine refuses is where the two part.
    const spec = generate(5);
    const events = samples(spec, 5, 8);
    const machine = await load(spec, "prod");
    const actual = await traceCompiled(machine, events);
    const permissive = traceReference(
      { ...spec, transitions: spec.transitions.map((t) => ({ ...t, guard: { kind: "always" as const } })) },
      events,
    );
    const step = firstDifference(permissive, actual);
    // Either the machine never declines (the two agree) or it does, and the step is found.
    if (step !== null) expect(step).toBeGreaterThan(0);
  });

  test("a wrong source is caught, and the minimizer shrinks it to the step that fails", async () => {
    // A spec whose source is edited to move to the wrong state on one event: the differential must
    // find it, and `shrink` must cut the sequence down to the events that still show it.
    const spec = generate(7);
    const events = samples(spec, 7, 10);
    // The first transition that moves: its target is changed in the source only.
    const moving = spec.transitions.find((t) => t.guard.kind === "always");
    if (moving === undefined) return; // this seed has no unguarded move: nothing to corrupt
    const wrong = spec.states.find((s) => s.name !== moving.to && s.fields.length === 0)?.name;
    if (wrong === undefined) return;
    const corrupted = render(spec).replace(`to(${JSON.stringify(moving.to)})`, `to(${JSON.stringify(wrong)})`);
    expect(corrupted).not.toBe(render(spec));
    // Write the corrupted source as a prod fixture and compare it with the reference.
    const file = join(SCRATCH, `corrupt-${spec.seed}.ts`);
    writeFileSync(file, corrupted);
    const module: { machine: Parameters<typeof traceCompiled>[0] } = await import(file);
    const actual = await traceCompiled(module.machine, events);
    const step = firstDifference(traceReference(spec, events), actual);
    expect(step).not.toBeNull();
    // The minimizer, given the corrupted machine's own failure check, keeps only the events that
    // still show it: a shorter sequence that still diverges, and one event fewer that doesn't.
    const fails = async (candidate: readonly RefEvent[]): Promise<boolean> =>
      firstDifference(traceReference(spec, candidate), await traceCompiled(module.machine, candidate)) !== null;
    const minimal = await shrink(spec, events, fails);
    expect(minimal.length).toBeLessThan(events.length);
    expect(await fails(minimal)).toBe(true);
  });
});

describe("the generated source is valid TypeScript", () => {
  test("a batch of seeds type-checks with bun check", () => {
    // A folder of its own, with the workspace's tsconfig and the runtime resolvable, so the
    // generated machines are checked as an app's would be.
    const dir = join(SCRATCH, "check");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "node_modules", "@reactre"), { recursive: true });
    const root = join(import.meta.dir, "..", "..", "..", "..");
    symlinkSync(join(import.meta.dir, "..", ".."), join(dir, "node_modules", "@reactre", "state"));
    symlinkSync(join(root, "node_modules", "bun-types"), join(dir, "node_modules", "bun-types"));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.json"), include: ["."] }));
    for (let seed = 1; seed <= 10; seed++) writeFileSync(join(dir, `seed-${seed}.ts`), render(generate(seed)));
    // A parallel machine's source too: its regions' steps are the form the type layer requires.
    for (let seed = 1; seed <= 5; seed++)
      writeFileSync(join(dir, `parallel-${seed}.ts`), render(generate(seed, { parallel: true })));
    const run = Bun.spawnSync(["bun", "check", "-p", join(dir, "tsconfig.json"), "--no-pretty"], { cwd: dir });
    const said = run.stdout.toString() + run.stderr.toString();
    expect(said).toMatch(/No type errors|checked \d+ files/);
    expect(said).not.toMatch(/error TS/);
  }, 60_000);
});
