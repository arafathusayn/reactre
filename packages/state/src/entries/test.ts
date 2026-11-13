// @reactre/state/test (prototype): model-based testing (`@xstate/test`; docs:
// model-based-testing.md, testing.md). The machine is the model: event sequences are generated from
// it, sent to the machine and to the implementation under test, and after every step the
// implementation's state is compared with the machine's snapshot.
//
//   - `modelPaths(machine, { events })`: the paths through the machine, from `transition` alone:
//     `"shortest"` (the shortest path to each distinct snapshot, the default) or `"simple"` (every
//     path that visits no snapshot twice). Each is `{ snapshot, steps: [{ event, snapshot }] }`.
//   - `testPaths(machine, { events, sut })`: walks each path against the implementation.
//   - `propertyTest(machine, { events, sut, runs, seed })`: random sequences, from a seeded generator,
//     so a failure reruns with its seed.
//   - A divergence throws StateError S27, listing the steps from the start to the one that diverged,
//     with the model's and the implementation's state, and the seed for a random run.
//   - Coverage comes back: the states visited, out of the machine's leaves, and the transitions taken.
//
// Shaped differently from XState's:
//   - The paths are this module's own walk over the pure `transition` (the graph entry,
//     ../entries/graph.ts, was a stub when this was written); `testPaths` takes any paths of the same
//     shape (`paths`), so a graph entry's can replace them.
//   - Payloads are samples listed per event (`events: { add: [{ sku: "apple" }] }`), not fast-check
//     arbitraries: no dependency. The types require samples for every event with a payload, and an
//     event without one gets `{}`.
//   - A task's result is an event like any other here: list an internal event's samples and the walk
//     delivers it as the task would (`internal`), in whatever state handles it. Timers don't fire:
//     test them with an actor and `SimulatedClock` (@reactre/state/utils).
//   - Snapshots are told apart by `{ state, data, history }` as JSON. Data can grow without bound (a
//     counter), so `stopWhen` stops expanding a snapshot, and `depth` bounds every path (20 steps).

import type { ActorInput, EventName, EventOf, ExternalName, Machine, Shape, Snapshot } from "../index.ts";
import { __step, initial, StateError } from "../index.ts";
import type { __Compiled, __Event, __Snapshot } from "../internal.ts";

/** An event's payload, without `type`. */
type Payload<D extends Shape, E extends EventName<D>> = Omit<EventOf<D, E>, "type">;

/** Events whose payload has fields: they need samples. */
type WithFields<D extends Shape> = {
  [E in EventName<D>]: keyof Payload<D, E> extends never ? never : E;
}[EventName<D>];

/**
 * Payload samples by event: required for each event with fields (a sample is the payload without
 * `type`), optional for the others (`[{}]`). An internal event listed here is delivered as its task
 * would deliver it.
 */
export type EventSamples<D extends Shape> = {
  readonly [E in WithFields<D> & ExternalName<D>]: readonly Payload<D, E>[];
} & { readonly [E in EventName<D>]?: readonly Payload<D, E>[] };

/** One step of a path: the event sent, and the snapshot after it. */
export interface Step<D extends Shape> {
  readonly event: EventOf<D, EventName<D>>;
  readonly snapshot: Snapshot<D>;
}

/** A path through the machine: where it starts, and each step. */
export interface Path<D extends Shape> {
  readonly snapshot: Snapshot<D>;
  readonly steps: readonly Step<D>[];
}

/** How to walk the machine. */
export type WalkOptions<D extends Shape> = {
  readonly events: EventSamples<D>;
  /** `"shortest"` (default): one shortest path to each distinct snapshot. `"simple"`: every path that repeats none. */
  readonly paths?: "shortest" | "simple";
  /** Don't go on from a snapshot this says to stop at (a counter's bound). */
  readonly stopWhen?: (snapshot: Snapshot<D>) => boolean;
  /** The longest path, in steps (20). */
  readonly depth?: number;
} & ([ActorInput<D>] extends [undefined] ? { readonly input?: undefined } : { readonly input: ActorInput<D> });

/** The implementation under test: a fresh one per path, an event at a time, and what to compare. */
export interface Sut<D extends Shape, R> {
  readonly create: () => {
    readonly send: (event: EventOf<D, EventName<D>>) => void | Promise<void>;
    readonly read: () => R | Promise<R>;
  };
  /** The part of the machine's snapshot `read` must equal (as JSON). */
  readonly project: (snapshot: Snapshot<D>) => R;
}

/** What a test run covered. */
export interface Coverage {
  /** The leaves (and parallel nodes) visited, out of the machine's. */
  readonly states: { readonly covered: readonly string[]; readonly uncovered: readonly string[] };
  /** Each transition taken, as `state --event--> state`. */
  readonly transitions: readonly string[];
}

/** What `testPaths` and `propertyTest` return when the implementation kept to the model. */
export interface TestResult {
  /** How many paths (or random runs) were walked, and steps taken. */
  readonly paths: number;
  readonly steps: number;
  readonly coverage: Coverage;
}

// The runtime's view: a compiled machine, untyped snapshots and events.
interface __Step {
  readonly event: __Event;
  readonly snapshot: __Snapshot;
}
interface __Path {
  readonly snapshot: __Snapshot;
  readonly steps: readonly __Step[];
}
interface __Walk {
  readonly events: { readonly [event: string]: readonly object[] | undefined };
  readonly paths?: "shortest" | "simple";
  readonly stopWhen?: (snapshot: __Snapshot) => boolean;
  readonly depth?: number;
  readonly input?: unknown;
}
interface __Sut {
  readonly create: () => { readonly send: (event: __Event) => unknown; readonly read: () => unknown };
  readonly project: (snapshot: __Snapshot) => unknown;
}

/** A snapshot's identity: its state, data and history, as JSON. */
const key = (s: __Snapshot): string => JSON.stringify([s.state, s.data, s.history ?? null]);

/** Every event to try from any snapshot: each sendable event's samples, and each listed internal event's. */
function candidates(
  m: __Compiled,
  samples: __Walk["events"],
): readonly (readonly [event: __Event, internal: boolean])[] {
  const names = new Set([...Object.keys(m.e), ...Object.keys(samples)]);
  return [...names].flatMap((type) =>
    (samples[type] ?? [{}]).map((payload) => [{ ...payload, type }, m.e[type] !== 1] as const),
  );
}

/** The moves out of `s`: each candidate event that the machine takes. */
function moves(m: __Compiled, s: __Snapshot, events: ReturnType<typeof candidates>): __Step[] {
  if (m.f?.[s.state] === 1) return [];
  const out: __Step[] = [];
  for (const [event, internal] of events) {
    const r = __step(m, s, event, internal);
    if (r.ok) out.push({ event, snapshot: r.snapshot });
  }
  return out;
}

function walk(m: __Compiled, options: __Walk): __Path[] {
  const start = initial(m as Machine<Shape>, options.input as never) as __Snapshot;
  const events = candidates(m, options.events);
  const depth = options.depth ?? 20;
  const stop = (s: __Snapshot): boolean => options.stopWhen?.(s) === true;
  if (options.paths === "simple") {
    const out: __Path[] = [];
    const go = (s: __Snapshot, steps: __Step[], seen: Set<string>): void => {
      out.push({ snapshot: start, steps });
      if (steps.length >= depth || stop(s)) return;
      for (const step of moves(m, s, events)) {
        const k = key(step.snapshot);
        if (seen.has(k)) continue;
        go(step.snapshot, [...steps, step], new Set([...seen, k]));
      }
    };
    go(start, [], new Set([key(start)]));
    return out;
  }
  // Shortest: breadth first, the first path to each snapshot.
  const found = new Map<string, __Path>([[key(start), { snapshot: start, steps: [] }]]);
  let frontier: { readonly s: __Snapshot; readonly steps: __Step[] }[] = [{ s: start, steps: [] }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { s, steps } of frontier) {
      if (steps.length >= depth || stop(s)) continue;
      for (const step of moves(m, s, events)) {
        const k = key(step.snapshot);
        if (found.has(k)) continue;
        const path = [...steps, step];
        found.set(k, { snapshot: start, steps: path });
        next.push({ s: step.snapshot, steps: path });
      }
    }
    frontier = next;
  }
  return [...found.values()];
}

/** The paths through a machine, from `transition` alone: nothing runs. */
export function modelPaths<D extends Shape>(machine: Machine<D>, options: WalkOptions<D>): readonly Path<D>[];
export function modelPaths(m: __Compiled, options: __Walk): readonly __Path[] {
  return walk(m, options);
}

/** JSON-equal: what a model and an implementation are compared with. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => Reflect.get(a, k) !== undefined);
  const kb = Object.keys(b).filter((k) => Reflect.get(b, k) !== undefined);
  return ka.length === kb.length && ka.every((k) => same(Reflect.get(a, k), Reflect.get(b, k)));
}

const show = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** Walks one path against a fresh implementation; throws S27 where it diverges. */
async function check(
  sut: __Sut,
  path: __Path,
  how: string,
  covered: Coverage & { states: { covered: string[] } },
): Promise<number> {
  const impl = sut.create();
  const lines = [`start ${show({ state: path.snapshot.state, data: path.snapshot.data })}`];
  const compare = async (s: __Snapshot, step: number): Promise<void> => {
    const model = sut.project(s);
    const observed = await impl.read();
    if (!same(model, observed))
      throw new StateError(
        "S27",
        `the implementation diverged from the machine at step ${step} (${how}):\n${lines.join("\n")}\n   diverged\n     model:    ${show(model)}\n     observed: ${show(observed)}\nFix the implementation, or the machine if it is the one that's wrong.`,
      );
  };
  await compare(path.snapshot, 0);
  let from = path.snapshot;
  for (const [i, { event, snapshot }] of path.steps.entries()) {
    await impl.send(event);
    lines.push(`${i + 1}. ${show(event)} -> ${show({ state: snapshot.state, data: snapshot.data })}`);
    if (!covered.states.covered.includes(snapshot.state)) covered.states.covered.push(snapshot.state);
    const t = `${from.state} --${event.type}--> ${snapshot.state}`;
    if (!covered.transitions.includes(t)) (covered.transitions as string[]).push(t);
    await compare(snapshot, i + 1);
    from = snapshot;
  }
  return path.steps.length;
}

function report(
  m: __Compiled,
  covered: { states: { covered: string[] }; transitions: readonly string[] },
  paths: number,
  steps: number,
): TestResult {
  const names = [...Object.keys(m.o), ...Object.keys(m.f ?? {})];
  // The leaves: names no other name is under; and the parallel nodes, which are a snapshot's state too.
  const states = [
    ...new Set([...names.filter((n) => !names.some((x) => x.startsWith(`${n}.`))), ...Object.keys(m.p ?? {})]),
  ];
  const visited = covered.states.covered.filter((s) => states.includes(s));
  return {
    paths,
    steps,
    coverage: {
      states: { covered: visited, uncovered: states.filter((s) => !visited.includes(s)) },
      transitions: covered.transitions,
    },
  };
}

/**
 * Walks each path through the machine (`modelPaths`', or `paths` given) against the implementation,
 * comparing `sut.read()` with `sut.project(snapshot)` at the start and after every step.
 *
 * @throws StateError S27 at the first divergence, listing the path to it.
 */
export function testPaths<D extends Shape, R>(
  machine: Machine<D>,
  options: WalkOptions<D> & { readonly sut: Sut<D, R>; readonly paths?: "shortest" | "simple" | readonly Path<D>[] },
): Promise<TestResult>;
export async function testPaths(
  m: __Compiled,
  options: Omit<__Walk, "paths"> & { readonly sut: __Sut; readonly paths?: "shortest" | "simple" | readonly __Path[] },
): Promise<TestResult> {
  const paths =
    typeof options.paths === "object" ? options.paths : walk(m, { ...options, paths: options.paths ?? "shortest" });
  const covered = { states: { covered: [] as string[], uncovered: [] }, transitions: [] as string[] };
  let steps = 0;
  for (const [i, path] of paths.entries()) {
    if (!covered.states.covered.includes(path.snapshot.state)) covered.states.covered.push(path.snapshot.state);
    steps += await check(options.sut, path, `path ${i + 1} of ${paths.length}`, covered);
  }
  return report(m, covered, paths.length, steps);
}

/** A seeded generator (mulberry32): the same seed, the same runs. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random event sequences from the machine (each step one of the moves it takes, chosen by a seeded
 * generator), each run against a fresh implementation, compared after every step.
 *
 * @throws StateError S27 at the first divergence, with the seed and run that reproduce it.
 */
export function propertyTest<D extends Shape, R>(
  machine: Machine<D>,
  options: Omit<WalkOptions<D>, "paths"> & {
    readonly sut: Sut<D, R>;
    /** How many sequences (100). */
    readonly runs?: number;
    /** The generator's seed (1): a failure says which to rerun with. */
    readonly seed?: number;
  },
): Promise<TestResult>;
export async function propertyTest(
  m: __Compiled,
  options: Omit<__Walk, "paths"> & { readonly sut: __Sut; readonly runs?: number; readonly seed?: number },
): Promise<TestResult> {
  const seed = options.seed ?? 1;
  const next = random(seed);
  const events = candidates(m, options.events);
  const start = initial(m as Machine<Shape>, options.input as never) as __Snapshot;
  const runs = options.runs ?? 100;
  const covered = { states: { covered: [start.state], uncovered: [] }, transitions: [] as string[] };
  let steps = 0;
  for (let run = 1; run <= runs; run++) {
    const path: __Step[] = [];
    let s = start;
    while (path.length < (options.depth ?? 20) && options.stopWhen?.(s) !== true) {
      const out = moves(m, s, events);
      const step = out[Math.floor(next() * out.length)];
      if (step === undefined) break;
      path.push(step);
      s = step.snapshot;
    }
    steps += await check(options.sut, { snapshot: start, steps: path }, `run ${run} of ${runs}, seed ${seed}`, covered);
  }
  return report(m, covered, runs, steps);
}
