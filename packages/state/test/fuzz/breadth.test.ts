// The fuzz breadth lane: hand-written traces for the shapes the generated differentials don't
// reach, run through all three variants (source via the runtime plugin, dev, prod) and compared
// with the expectation a person computed. Also here: the import and version contract each variant
// must share, a restore of a mismatched version refused, and a seeded decision/loop walk with a
// bounded shrink against a hand-written model.
//
// The expectations live in ./breadth-cases.ts and never call the runtime; the shrink in the last
// test uses the model there, so it holds the machine to the contract rather than to a copy of the
// machine's own code. The same cases run in real V8 in ./breadth-browser.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile } from "../../compiler/index.ts";
import { statePreload } from "../../plugin/runtime.ts";
import {
  type ExpectedTrace,
  LOOP_CORRUPT,
  LOOP_EVENTS,
  LOOP_EXPECTED,
  LOOP_SOURCE,
  loopModel,
  NESTED_PARALLEL_EVENTS,
  NESTED_PARALLEL_EXPECTED,
  NESTED_PARALLEL_SOURCE,
} from "./breadth-cases.ts";

const SCRATCH = join(import.meta.dir, "..", "..", "..", "..", ".fuzz-out", "breadth");

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

let installed = false;
function install(): void {
  if (installed) return;
  installed = true;
  mkdirSync(join(SCRATCH, "node_modules", "@reactre"), { recursive: true });
  try {
    symlinkSync(join(import.meta.dir, "..", ".."), join(SCRATCH, "node_modules", "@reactre", "state"));
  } catch {
    // Already there from an earlier run.
  }
  const source = statePreload({ filter: /\.fuzz-out\/breadth\/.*-src-[0-9a-f]+\.ts$/ });
  Bun.plugin({ name: source.name, setup: (build) => source.setup(build) });
  Bun.plugin({
    name: "@reactre/state (fuzz breadth)",
    setup(build) {
      build.onLoad({ filter: /\.fuzz-out\/breadth\/.*-(dev|prod)-[0-9a-f]+\.ts$/ }, async ({ path }) => {
        const text = await Bun.file(path).text();
        const dev = /-dev-[0-9a-f]+\.ts$/.test(path);
        const out = compile(path, text, { dev });
        if (out === null) throw new Error(`the breadth fixture ${path} didn't compile`);
        return { contents: out.code, loader: "ts" };
      });
    },
  });
}

/** A short, stable hash of `text` (FNV-1a), for a fixture's file name. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

type Compiled = Parameters<typeof import("@reactre/state").createActor>[0];

/** Loads `source` in one variant: the plugin for `src`, `compile` for `dev` and `prod`. */
async function load(source: string, variant: "src" | "dev" | "prod"): Promise<Compiled> {
  install();
  const file = join(SCRATCH, `case-${variant}-${hash(source)}.ts`);
  mkdirSync(SCRATCH, { recursive: true });
  const link = join(SCRATCH, "node_modules", "@reactre", "state");
  try {
    symlinkSync(join(import.meta.dir, "..", ".."), link);
  } catch {
    // Already there.
  }
  writeFileSync(file, source);
  const module: { machine: Compiled } = await import(file);
  return module.machine;
}

/** A machine's trace for `events`, through an actor: the same shape as the hand-written trace. */
async function trace(
  machine: Compiled,
  events: readonly { readonly type: string; readonly [field: string]: number | string }[],
): Promise<ExpectedTrace> {
  const { createActor } = await import("@reactre/state");
  const actor = createActor(machine);
  const start = actor.snapshot() as ExpectedTrace["start"];
  const steps = events.map((event) => {
    const result = actor.send(event as never) as { ok: boolean; reason?: string; snapshot: ExpectedTrace["start"] };
    return {
      event,
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
      state: result.snapshot.state,
      data: result.snapshot.data,
      version: result.snapshot.version,
    };
  });
  actor.stop();
  return { start, steps };
}

const VARIANTS = ["src", "dev", "prod"] as const;

/** The little of an actor this lane uses (a table's actor is untyped to the test). */
interface LooseActor {
  snapshot: () => { state: string; data: unknown; version: number };
  send: (event: never) => { ok: boolean; reason?: string };
  stop: () => void;
}

/**
 * `restoreActor` as a compiled table and a hand-written snapshot call it. The public overload takes
 * a `Machine` and an app's `Persisted`; a test that holds a table (as a store's JSON does) needs the
 * implementation's shape, so the cast is here, once, rather than at each call.
 */
async function restoreActorOf(): Promise<
  (machine: Compiled, saved: { state: string; data: unknown; version: number }) => LooseActor
> {
  const { restoreActor } = await import("@reactre/state");
  return restoreActor as unknown as (
    machine: Compiled,
    saved: { state: string; data: unknown; version: number },
  ) => LooseActor;
}

describe("hand-written breadth: a nested parent inside a parallel region", () => {
  test("the three variants agree with the hand-computed trace at every step", async () => {
    const failures: string[] = [];
    for (const variant of VARIANTS) {
      const actual = await trace(await load(NESTED_PARALLEL_SOURCE, variant), NESTED_PARALLEL_EVENTS);
      if (JSON.stringify(actual) !== JSON.stringify(NESTED_PARALLEL_EXPECTED))
        failures.push(
          `${variant}:\nexpected ${JSON.stringify(NESTED_PARALLEL_EXPECTED)}\nactual   ${JSON.stringify(actual)}`,
        );
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test("a snapshot keeps its version through every move, in all three variants", async () => {
    // Version is setup's `version` (2), so a snapshot read back knows which shape's data it holds.
    for (const variant of VARIANTS) {
      const actual = await trace(await load(NESTED_PARALLEL_SOURCE, variant), NESTED_PARALLEL_EVENTS);
      expect(actual.start.version).toBe(2);
      expect(actual.steps.every((s) => s.version === 2)).toBe(true);
    }
  }, 60_000);
});

describe("hand-written breadth: a counting loop with a decision beside it", () => {
  test("the three variants agree with the hand-computed trace at every step", async () => {
    const failures: string[] = [];
    for (const variant of VARIANTS) {
      const actual = await trace(await load(LOOP_SOURCE, variant), LOOP_EVENTS);
      if (JSON.stringify(actual) !== JSON.stringify(LOOP_EXPECTED))
        failures.push(`${variant}:\nexpected ${JSON.stringify(LOOP_EXPECTED)}\nactual   ${JSON.stringify(actual)}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  test("a restore of a snapshot from another version is refused, naming both versions", async () => {
    // `restoreActor` checks the version because the build never saw the saved snapshot (S2). The
    // machine is at version 1, so a saved version 0 (or 2) must throw, whichever variant runs.
    // The public overload is typed for a `Machine` and an app's `Persisted`; a compiled table and a
    // hand-written snapshot are what a store holds, so the call goes through the implementation's
    // shape (a test-only cast, as the other hand-written-table tests here do).
    const restore = await restoreActorOf();
    for (const variant of VARIANTS) {
      const machine = await load(LOOP_SOURCE, variant);
      expect(() => restore(machine, { state: "idle", data: {}, version: 0 })).toThrow(/S2\].*version 0.*version 1/);
      expect(() => restore(machine, { state: "idle", data: {}, version: 2 })).toThrow(/S2\].*version 2.*version 1/);
    }
  }, 60_000);

  test("a restore of the same version starts the machine where the snapshot left it", async () => {
    // The honest counterpart: a version 1 snapshot restores, so the refusal above is the version
    // check and not a machine that never restores at all.
    const restore = await restoreActorOf();
    for (const variant of VARIANTS) {
      const machine = await load(LOOP_SOURCE, variant);
      const actor = restore(machine, { state: "odd", data: { n: 3 }, version: 1 });
      expect(actor.snapshot()).toEqual({ state: "odd", data: { n: 3 }, version: 1 });
      const moved = actor.send({ type: "poke", n: 7 } as never) as { ok: boolean };
      expect(moved.ok).toBe(true);
      expect(actor.snapshot()).toMatchObject({ state: "idle" });
      actor.stop();
    }
  }, 60_000);
});

describe("hand-written breadth: the import shape each variant compiles to", () => {
  test("dev imports the freeze, prod doesn't; both keep the features the source uses", () => {
    const dev = compile("case.ts", NESTED_PARALLEL_SOURCE, { dev: true });
    const prod = compile("case.ts", NESTED_PARALLEL_SOURCE, { dev: false });
    if (dev === null || prod === null) throw new Error("the breadth source didn't compile");
    // The features the source opted into are imported by name from the app's own specifiers.
    for (const code of [dev.code, prod.code]) {
      expect(code).toContain('from "@reactre/state/nested"');
      expect(code).toContain('from "@reactre/state/parallel"');
    }
    // Only the development build imports the freeze: the production build ships none of it.
    expect(dev.code).toContain('from "@reactre/state/dev"');
    expect(prod.code).not.toContain("@reactre/state/dev");
    expect(prod.code).not.toContain("__reactreStateFreeze");
  });

  test("the table a variant builds carries the same version, regions and done as the source", () => {
    const prod = compile("case.ts", NESTED_PARALLEL_SOURCE, { dev: false });
    if (prod === null) throw new Error("the breadth source didn't compile");
    // The version, the regions of `on` (a then b), and `on`'s done are all data the table holds:
    // the source's `setup({ version: 2 })`, `parallel: ["on"]` with two regions, and the `done`.
    expect(prod.code).toContain("v: 2");
    expect(prod.code).toContain('p: { "on": ["a","b"] }');
    expect(prod.code).toContain('n: { "on":');
  });
});

describe("hand-written breadth: a seeded decision walk, shrunk against the model", () => {
  test("a wrong decision arm is caught, and the shrink keeps only the events that show it", async () => {
    // The corrupted source sends an odd `poke` to `even` instead of `odd`, and is otherwise the
    // same. The model in ./breadth-cases.ts is the contract (it never runs the machine), so a
    // difference is the source's bug. The minimizer drops events while the difference holds, so the
    // reported walk is the shortest one that still fails, not the full seeded walk.
    type Event = (typeof LOOP_EVENTS)[number];
    const actual = await trace(await load(LOOP_CORRUPT, "prod"), LOOP_EVENTS);
    const modelTrace = { start: LOOP_EXPECTED.start, steps: loopModel(LOOP_EVENTS) };
    // The hand-written model and the corrupted machine part at the first odd `poke` taken in
    // `counting`. The walk's first odd poke (n: 1, index 2) is taken in `even`, where both sources
    // decline it; the walk loops through `idle` and `counting` again, and the poke with n: 3 at
    // index 6 is the first odd one decided in `counting`: step 7.
    const at = firstStep(modelTrace, actual);
    expect(at).toBe(7);
    // The model agrees on the events before the split, so the split is the decision's fault and not
    // an earlier step's.
    const before = LOOP_EVENTS.slice(0, (at ?? 1) - 1);
    expect(
      firstStep(
        { start: LOOP_EXPECTED.start, steps: loopModel(before) },
        await trace(await load(LOOP_CORRUPT, "prod"), before),
      ),
    ).toBeNull();

    // Shrink with the failure predicate being "the model disagrees with the machine": drop events
    // while the disagreement holds, so the result is the shortest walk that still shows it.
    const fails = async (events: readonly Event[]): Promise<boolean> => {
      const t = await trace(await load(LOOP_CORRUPT, "prod"), events);
      return firstStep({ start: LOOP_EXPECTED.start, steps: loopModel(events) }, t) !== null;
    };
    const minimal = [...LOOP_EVENTS];
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < minimal.length; i++) {
        const candidate = [...minimal.slice(0, i), ...minimal.slice(i + 1)];
        if (await fails(candidate)) {
          minimal.length = 0;
          minimal.push(...candidate);
          changed = true;
          break;
        }
      }
    }
    expect(minimal.length).toBeLessThan(LOOP_EVENTS.length);
    expect(await fails(minimal)).toBe(true);
    // The honest machine agrees with the model on the full walk and on the shrunk walk, so the
    // shrink above isn't running against a model that always disagrees.
    expect(firstStep(modelTrace, await trace(await load(LOOP_SOURCE, "prod"), LOOP_EVENTS))).toBeNull();
    expect(
      firstStep(
        { start: LOOP_EXPECTED.start, steps: loopModel(minimal) },
        await trace(await load(LOOP_SOURCE, "prod"), minimal),
      ),
    ).toBeNull();
  }, 60_000);
});

/** A trace as either side spells it: a machine's steps carry `event` and `version`, a model's don't. */
type AnyTrace = { start: { state: string; data: unknown; version: number }; steps: readonly unknown[] };

/** The first step where two traces differ (1-based), or null. */
function firstStep(a: AnyTrace, b: AnyTrace): number | null {
  if (JSON.stringify(a.start) !== JSON.stringify(b.start)) return 0;
  const n = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    // A step is compared on what it decides, not on fields only one side carries: the move, the
    // reason, the state and the data. The version is pinned by its own tests.
    const pick = (s: unknown): unknown => {
      const step = s as { ok?: boolean; reason?: string; state?: string; data?: unknown };
      return { ok: step.ok, reason: step.reason, state: step.state, data: step.data };
    };
    if (JSON.stringify(pick(a.steps[i])) !== JSON.stringify(pick(b.steps[i]))) return i + 1;
  }
  return null;
}
