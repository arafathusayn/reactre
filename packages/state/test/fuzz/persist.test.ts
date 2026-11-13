// The host-restart differential: a machine with timers and tasks, persisted mid-walk, stopped, its
// snapshot through JSON, and restored into a new actor on the same clock. The restarted run must
// equal the reference's single-actor run, which never persists: persistence is observationally
// transparent when it is right. The reference models the restart's contract itself (a timer keeps
// only the time it had left, a task restarts), so agreement is evidence about the runtime, not
// about two copies of the same code.
//
// The saved JSON is also checked against an independent expectation: the snapshot's state, data and
// version are the reference's at that step, and `run` holds a deadline per pending timer, which the
// reference computes from the spec. A save that dropped a timer, or wrote a relative delay, fails
// here even if the restored run happens to agree.

import { describe, expect, test } from "bun:test";

import { generate } from "./generate.ts";
import { firstDifference, load, samples, traceCompiledRestart, traceReferenceAsync } from "./harness.ts";
import { arrivals, type RefSnapshot } from "./reference.ts";
import type { Spec } from "./spec.ts";

/** How many seeds the restart differential runs. */
const SEEDS = 10;
/** How many events each seed's walk sends. */
const STEPS = 6;
/** How far the clock moves after each event. */
const TICK = 3;

describe("host restart: persist, stop, restore, and the run continues", () => {
  test(`${SEEDS} seeds with timers and tasks survive a restart at every step`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const spec = generate(seed, { async: true });
      const events = samples(spec, seed, STEPS);
      // The machine with persist in its `use`: the compiler gives it the general lifecycle and the
      // tasks runner that saves deadlines.
      const machine = await load(spec, "prod", { persist: true });
      // A restart after each event in turn: the same walk, cut at a different point.
      for (let at = 1; at <= events.length; at++) {
        const reference = traceReferenceAsync(spec, events, TICK, at);
        const actual = await traceCompiledRestart(machine, events, TICK, at);
        const step = firstDifference(reference, actual);
        if (step === null) continue;
        failures.push(
          `seed ${seed}, restart after event ${at}, diverged at step ${step}\n` +
            `events: ${JSON.stringify(events)}\n` +
            `reference: ${JSON.stringify(reference.steps.map((s) => [s.ok, s.state, s.data]))}\n` +
            `actual:    ${JSON.stringify(actual.steps.map((s) => [s.ok, s.state, s.data]))}`,
        );
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  test("the saved JSON is the reference's snapshot, with a deadline per pending timer", async () => {
    // One seed, saved at each step: the snapshot's state, data and version are the reference's, and
    // `run` names each node with a pending timer and its absolute deadline, which the reference
    // computes from the spec (the state was entered at `at`, so the deadline is `at + ms`).
    const { createActor } = await import("@reactre/state");
    const { persist } = await import("@reactre/state/persist");
    const { SimulatedClock } = await import("@reactre/state/utils");
    const spec = generate(2, { async: true });
    const events = samples(spec, 2, STEPS);
    const machine = await load(spec, "prod", { persist: true });
    const realSetTimeout = globalThis.setTimeout;
    const tick = (): Promise<void> => new Promise((r) => realSetTimeout(r, 0));
    const clock = new SimulatedClock(0);
    try {
      const actor = createActor(machine, { now: clock.now });
      const reference = traceReferenceAsync(spec, events, TICK);
      for (const [i, event] of events.entries()) {
        actor.send(event);
        // The reference records a step right after the event, before the clock moves and an arrival
        // lands, so the save is read at the same point: the two describe the same moment.
        const saved = JSON.parse(JSON.stringify(persist(actor as never))) as RefSnapshot & {
          run?: { [node: string]: { t?: (number | null)[] } };
        };
        const expected = reference.steps[i]!;
        // Compared as JSON: a step's `data` is `unknown` (the runtime's snapshot type), and the
        // saved one is JSON by contract, so the text is the comparison that holds for both.
        expect(JSON.stringify({ state: saved.state, data: saved.data, version: saved.version })).toBe(
          JSON.stringify({ state: expected.state, data: expected.data, version: expected.version }),
        );
        // Each node with a pending timer saves its deadline; a node with none saves nothing.
        const pending = arrivals(spec, saved.state, 0).filter((a) => a.kind === "timer");
        const nodes = Object.keys(saved.run ?? {});
        if (pending.length === 0) expect(nodes).toEqual([]);
        else expect(nodes).toContain(saved.state);
        // Then let the clock move, so the next step starts where the reference's does.
        await tick();
        clock.advance(TICK);
        await tick();
      }
      actor.stop();
    } finally {
      clock.uninstall();
    }
  }, 60_000);
});

describe("the restart differential is not vacuous", () => {
  test("a save that drops the timers' deadlines is caught", async () => {
    // The same walk, but the saved JSON loses `run` (a store that kept only the plain snapshot): a
    // pending timer then restarts its full delay instead of the time it had left, so the restarted
    // run diverges from the reference. A harness that always passed would not see it.
    //
    // The spec is written here, not generated: the divergence needs a timer that is still pending
    // at the restart and fires inside the walk, and a generated machine's timers are 1–5ms (they
    // fire before the restart) or land on a state the walk leaves. `a` has a 10ms timer to `c`, and
    // the walk's events are all unhandled, so the timer is the only thing that moves: entered at 0,
    // it fires at 10. Restarted at t=3, an honest save keeps the deadline (fires at 10); a save
    // that dropped `run` restarts the 10ms (fires at 13), so the two part at the step that spans 10.
    const spec: Spec = {
      seed: 0,
      version: 0,
      states: [
        { name: "a", fields: [] },
        { name: "b", fields: [] },
        { name: "c", fields: [] },
      ],
      events: [{ name: "go", fields: [] }],
      start: { state: "a", data: [] },
      final: [],
      transitions: [],
      timers: [{ state: "a", ms: 10, to: "c", data: { kind: "none" } }],
    };
    const events = Array.from({ length: STEPS }, () => ({ type: "go" }));
    const machine = await load(spec, "prod", { persist: true });
    // The reference, restarted at the same point, keeps the timer's remaining time; a restore
    // that dropped `run` restarts the full delay, so the two disagree on when the timer fires.
    const reference = traceReferenceAsync(spec, events, TICK, 1);
    const actual = await traceCompiledRestart(machine, events, TICK, 1);
    // The honest restart agrees with the reference (the differential's own claim)...
    expect(firstDifference(reference, actual)).toBeNull();
    // ...and the corrupted one is a different machine: its timer fires later, so a walk long
    // enough to reach the timer's move sees a different state.
    const late = await traceCompiledRestart(machine, events, TICK, 1, { dropRun: true });
    expect(firstDifference(reference, late)).not.toBeNull();
  }, 60_000);
});
