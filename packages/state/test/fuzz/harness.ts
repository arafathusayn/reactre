// The differential harness: one spec, run four ways, compared step by step.
//
//   1. the reference (./reference.ts): the spec interpreted, with no compiler and no runtime;
//   2. the original TypeScript, accepted through the package's runtime plugin (`statePreload`), as
//      an app's build loads it. This is the accepted-source path, not an uncompiled interpreter:
//      the plugin compiles it, so it checks that the plugin and `compile` agree, not that the
//      source runs as written;
//   3. the compiler's development output (`compile(..., { dev: true })`);
//   4. the compiler's production output (`compile(..., { dev: false })`).
//
// The reference is the oracle: it says what each event must do. The other three must agree with it,
// and with each other, on every observable: whether the event moved, why it didn't, the state, the
// data, and the version. A disagreement is reported with the seed, the spec (the contract), the
// event sequence, and the first step that diverged.
//
// How the fixtures run. The generated source is written as a `.ts` file in a scratch folder inside
// the workspace, and a Bun plugin loads it: `-src.ts` through `statePreload` (the plugin an app
// uses), `-dev.ts` and `-prod.ts` through `compile` with `dev` on and off. The folder is outside
// `packages/state/`, so the package's own preload (which claims `/packages/state/*.ts`) doesn't take
// these files first. A `node_modules/@reactre/state` symlink in the folder lets the compiled code
// resolve the runtime, as an app's would. Each file's name carries a hash of its content, so Bun's
// module cache never hands back a machine compiled from a different spec.

import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile } from "../../compiler/index.ts";
import { statePreload } from "../../plugin/runtime.ts";
import { generate, render } from "./generate.ts";
import { rng } from "./random.ts";
import { arrivals, reference, type RefEvent, type RefSnapshot } from "./reference.ts";
import { type DataExpr, payloadOf, showSpec, type Spec, type ValueExpr } from "./spec.ts";

/** Where the generated fixtures are written: inside the workspace, outside `packages/state/`. */
export const SCRATCH = join(import.meta.dir, "..", "..", "..", "..", ".fuzz-out");

let installed = false;

/**
 * How many times each plugin's `onLoad` ran, by variant. A fixture that Bun serves from its module
 * cache never reaches `onLoad`, so a test asserts the count grew: a cached machine from an earlier
 * spec would otherwise pass silently.
 */
export const loads: { src: number; dev: number; prod: number } = { src: 0, dev: 0, prod: 0 };

/** The fixture paths this process has loaded, so a cache hit on a known path is told from a stale one. */
const loaded = new Set<string>();

/** Registers the plugin that compiles the scratch fixtures, and makes the folder resolvable. */
export function install(): void {
  if (installed) return;
  installed = true;
  mkdirSync(join(SCRATCH, "node_modules", "@reactre"), { recursive: true });
  const state = join(import.meta.dir, "..", "..");
  try {
    symlinkSync(state, join(SCRATCH, "node_modules", "@reactre", "state"));
  } catch {
    // Already there from an earlier run.
  }
  // The source run: the package's own runtime plugin, as an app loads a machine file. It is the
  // path a build takes, so a bug in the plugin (not only in `compile`) shows here.
  // The source run uses the package's own plugin, with its `onLoad` wrapped so a test can see it
  // ran (a module Bun serves from cache never reaches it).
  const source = statePreload({ filter: /\.fuzz-out\/.*-src-[0-9a-f]+\.ts$/ });
  Bun.plugin({
    name: source.name,
    setup(build) {
      const counting = {
        onLoad: (options: Parameters<typeof build.onLoad>[0], callback: Parameters<typeof build.onLoad>[1]) =>
          build.onLoad(options, async (args) => {
            loads.src++;
            return callback(args);
          }),
      } as typeof build;
      source.setup(counting);
    },
  });
  // The dev and production runs: `compile` called directly, with `dev` on and off.
  Bun.plugin({
    name: "@reactre/state (fuzz fixtures)",
    setup(build) {
      build.onLoad({ filter: /\.fuzz-out\/.*-(dev|prod)-[0-9a-f]+\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const dev = /-dev-[0-9a-f]+\.ts$/.test(path);
        loads[dev ? "dev" : "prod"]++;
        const out = compile(path, source, { dev });
        if (out === null) throw new Error(`the fuzz fixture ${path} didn't compile`);
        return { contents: out.code, loader: "ts" };
      });
    },
  });
}

/**
 * Removes the fixtures this file wrote (they are regenerated from their seeds). Not the whole
 * scratch folder: Bun runs the fuzz files in one process, and fuzz.test.ts's `afterAll` can run
 * while children.test.ts or children-lifecycle.test.ts is still loading from it. Deleting their
 * files under them was the "child is not defined" failure: a module read after its file was gone.
 */
export function cleanup(): void {
  if (!existsSync(SCRATCH)) return;
  for (const name of readdirSync(SCRATCH))
    if (name.startsWith("seed-") || name.startsWith("corrupt-") || name === "check")
      rmSync(join(SCRATCH, name), { recursive: true, force: true });
}

/** A compiled machine, as the runtime holds it (the table the compiler wrote). */
type Compiled = Parameters<typeof import("@reactre/state").createActor>[0];

/** Which of the three runs a fixture is: the original source, the dev output, the production output. */
export type Variant = "src" | "dev" | "prod";

/**
 * The `shape` hash a persisted machine's setup must carry. The compiler computes it from the
 * contracts and reports it in the problem it raises when it is missing, so the harness asks the
 * compiler once and reads the hash out of the message: the generator never reimplements the hash,
 * and a change to it can't make the fixtures silently wrong.
 */
function shapeOf(spec: Spec): string {
  try {
    compile("machine.ts", render(spec, "machine", { persist: true }));
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    const found = /add shape: "([0-9a-z]+)"/.exec(said);
    if (found !== null) return found[1]!;
    throw new Error(`fuzz: seed ${spec.seed}'s persisted fixture has no shape hash to read: ${said}`);
  }
  throw new Error(`fuzz: seed ${spec.seed}'s persisted fixture compiled without a shape hash`);
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

/**
 * The machine for `spec` in one variant. `src` is the original TypeScript, loaded through the
 * package's runtime plugin (as an app's build loads it); `dev` and `prod` are `compile`'s output
 * with `dev` on and off. A module that throws on load (a missing import, a bad table) is reported
 * with the seed and the variant, so a failure names what to rerun.
 */
export async function load(spec: Spec, variant: Variant, options: { persist?: boolean } = {}): Promise<Compiled> {
  install();
  const source = render(spec, "machine", {
    ...(options.persist === true ? { persist: true, shape: shapeOf(spec) } : {}),
  });
  // The file's name carries a hash of its content, so two specs (or a spec and a later edit of it)
  // never share a module specifier: Bun caches a module by its path, and a reused path would hand
  // back the machine compiled from the earlier content.
  const file = join(SCRATCH, `seed-${spec.seed}-${variant}-${hash(source)}.ts`);
  // Another test file's `cleanup` may have removed the folder (Bun runs the files in one process):
  // recreate it, so a file's tests don't depend on which file ran first.
  mkdirSync(SCRATCH, { recursive: true });
  const link = join(SCRATCH, "node_modules", "@reactre", "state");
  if (!existsSync(link)) {
    mkdirSync(join(SCRATCH, "node_modules", "@reactre"), { recursive: true });
    symlinkSync(join(import.meta.dir, "..", ".."), link);
  }
  writeFileSync(file, source);
  const before = loads[variant];
  try {
    const module: { machine: Compiled } = await import(file);
    // A module Bun served from its cache never reached the plugin. That is safe only when this
    // exact path was loaded before (the name carries the content's hash, so the same path is the
    // same source and the same machine). A path that is new but cached would be a stale machine.
    if (loads[variant] === before && !loaded.has(file))
      throw new Error(`the ${variant} fixture ${file} was served from Bun's module cache, not loaded`);
    loaded.add(file);
    return module.machine;
  } catch (error) {
    throw new Error(
      `fuzz: seed ${spec.seed}'s ${variant} fixture threw on load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** One step of a trace: the event, and what the machine did with it. */
export interface Step {
  readonly event: RefEvent;
  readonly ok: boolean;
  readonly reason?: string;
  readonly state: string;
  readonly data: unknown;
  readonly version: number;
}

/** A trace: the start snapshot, then a step per event. */
export interface Trace {
  readonly start: RefSnapshot;
  readonly steps: readonly Step[];
}

/** The runtime's result, as a step (the fields a trace compares). */
function stepOf(event: RefEvent, result: { ok: boolean; reason?: string; snapshot: RefSnapshot }): Step {
  return {
    event,
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason }),
    state: result.snapshot.state,
    data: result.snapshot.data,
    version: result.snapshot.version,
  };
}

/** The reference's trace for `events`. */
export function traceReference(spec: Spec, events: readonly RefEvent[]): Trace {
  const ref = reference(spec);
  const start = ref.initial();
  let at = start;
  const steps: Step[] = [];
  for (const event of events) {
    const result = ref.transition(at, event);
    steps.push(stepOf(event, result));
    at = result.snapshot;
  }
  return { start, steps };
}

/**
 * The reference's trace for `events`, with the same clock discipline as `traceCompiledAsync`: after
 * each event, the clock advances by `step` ms, and each arrival (a task's result, a timer) that
 * comes due while the machine is still in the state that scheduled it is applied, in time order.
 * A task's result is applied on the microtask after the event (its `ms` is 0 in the model), and a
 * timer at its `ms`. The reference computes arrivals from the spec, never from the machine.
 */
export function traceReferenceAsync(spec: Spec, events: readonly RefEvent[], step: number, restartAt?: number): Trace {
  const ref = reference(spec);
  const start = ref.initial();
  let at = start;
  let now = 0;
  const steps: Step[] = [];
  /** The arrivals scheduled by entering `state` at `now`, as `{ at, kind, apply }`. */
  const schedule = (state: string, from: number): { at: number; kind: "task" | "timer"; apply: () => void }[] =>
    arrivals(spec, state, from).map((a) => ({
      at: a.at,
      kind: a.kind,
      apply: () => {
        // A task's result is an internal event; a timer is a step. Both are dropped if the machine
        // has left the state that scheduled them.
        if (at.state !== a.state) return;
        if (a.kind === "task" && a.event !== undefined) {
          if (a.event.type === "__error") {
            // A failure moves to `onError` with no data: the generated `error` handler is
            // `({ to }) => to(onError)`, and a `to` with no data builds `{}` (the target's data is
            // the handler's, not the old state's).
            at = { state: a.event.to as string, data: {}, version: spec.version };
          } else {
            // A task's event is the machine's own, not one of setup's: `internal`, not `transition`.
            const r = ref.internal(at, a.event);
            if (r.ok) at = r.snapshot;
          }
        } else if (a.kind === "timer" && a.to !== undefined) {
          at = { state: a.to, data: buildData(a.data, at.data), version: spec.version };
          // A timer that moves to the same leaf doesn't exit it: the task and other timers keep
          // their original arrivals. A new leaf cancels the rest and starts its own work.
        }
      },
    }));
  let pending = schedule(start.state, 0);
  /** Promise results pending at the current host time. A task is not a timer callback: its result
   * lands on a host yield, after every timer callback due by then. A timer which enters a state
   * starts its task, but that result cannot move the machine during the same synchronous advance. */
  const tasks = (): void => {
    for (;;) {
      const due = pending.filter((p) => p.kind === "task" && p.at <= now)[0];
      if (due === undefined) return;
      pending = pending.filter((p) => p !== due);
      const was = at.state;
      due.apply();
      if (at.state !== was) pending = schedule(at.state, now);
    }
  };
  for (const [i, event] of events.entries()) {
    const before = at.state;
    const result = ref.transition(at, event);
    steps.push(stepOf(event, result));
    if (result.ok) {
      at = result.snapshot;
      // A move to a *different* state drops the old arrivals and schedules the new state's. A move
      // to the same leaf stays: its task and timers keep running, as the runtime's `__changes` says.
      if (at.state !== before) pending = schedule(at.state, now);
    }
    // The driver yields on the real host timer before moving the simulated clock. Start-state and
    // event-created tasks can land now, at the *old* clock time, and schedule their own timers from
    // that time. A promise settled by a later timer cannot land until the phase after its advance.
    tasks();
    // Advance the clock: timer callbacks first, then a host yield for the promises they settled.
    // In particular, if a due timer starts a 0ms task and another due timer, the latter can move
    // away first. The task's result is then cancelled: it is not applied synchronously here.
    const until = now + step;
    for (;;) {
      const due = pending.filter((p) => p.kind === "timer" && p.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      pending = pending.filter((p) => p !== due);
      now = Math.max(now, due.at);
      const was = at.state;
      due.apply();
      // A move from an arrival schedules the new state's arrivals from `now`. An arrival that
      // leaves the machine in the same state is consumed, not rescheduled: a 0ms task would
      // otherwise re-fire forever, and the runtime's `__changes` only reschedules on a move.
      if (at.state !== was) pending = schedule(at.state, now);
    }
    now = until;
    tasks();
    // A host restart: the runtime's contract is that a timer keeps only the time it had left (its
    // deadline is absolute, saved in `run`), and a task restarts (it isn't saved). So the pending
    // timers keep their `at`, and the state's task is scheduled again from `now`.
    if (restartAt !== undefined && i + 1 === restartAt) {
      const timers = pending.filter((p) => p.kind === "timer");
      const task = schedule(at.state, now).filter((p) => p.kind === "task");
      pending = [...timers, ...task];
    }
  }
  return { start, steps };
}

/** The data a timer's step builds, from the state's data (a fresh object, as the machine builds it). */
function buildData(d: DataExpr | undefined, data: RefSnapshot["data"]): RefSnapshot["data"] {
  if (d === undefined) return {};
  switch (d.kind) {
    case "none":
      return {};
    case "set":
      return { ...data, [d.field]: valueOf(d.value, data) };
    case "fresh": {
      const out: { [field: string]: number | string } = {};
      for (const f of d.fields) out[f.name] = valueOf(f.value, data);
      return out;
    }
  }
}

/** A value expression's value, from data only (a timer's handler has no event). */
function valueOf(v: ValueExpr, data: RefSnapshot["data"]): number | string {
  // A timer's handler reads a leaf's data, never a parallel node's regions: the generator only puts
  // timers on leaves, so a field here is a number or a string.
  const field = (name: string): number | string => data[name] as number | string;
  switch (v.kind) {
    case "literal":
      return v.value;
    case "data":
      return field(v.field);
    case "plus":
      return (field(v.field) as number) + v.by;
    case "event":
      return 0; // a timer's handler has no event: the generator never builds one from it
  }
}

/** The compiled machine's trace for `events`, through an actor (so `inactive` and listeners count). */
export async function traceCompiled(machine: Compiled, events: readonly RefEvent[]): Promise<Trace> {
  const { createActor } = await import("@reactre/state");
  const actor = createActor(machine);
  const start = actor.snapshot() as RefSnapshot;
  const steps: Step[] = [];
  for (const event of events) {
    const result = actor.send(event) as { ok: boolean; reason?: string; snapshot: RefSnapshot };
    steps.push(stepOf(event, result));
  }
  actor.stop();
  return { start, steps };
}

/**
 * The compiled machine's trace for `events`, with a simulated clock: each event is sent, then the
 * clock advances by `step` ms so a timer or a task that comes due fires before the next event. A
 * task's promise settles on the microtask queue, so a `tick` (a real `setTimeout(0)`) lets it land
 * before the clock moves. The clock is uninstalled at the end.
 */
export async function traceCompiledAsync(machine: Compiled, events: readonly RefEvent[], step: number): Promise<Trace> {
  const { createActor } = await import("@reactre/state");
  const { SimulatedClock } = await import("@reactre/state/utils");
  // The real timer, captured before the clock replaces the global one: the clock's `setTimeout`
  // only fires when the clock advances, so a tick on it would never resolve.
  const realSetTimeout = globalThis.setTimeout;
  const tick = (): Promise<void> => new Promise((r) => realSetTimeout(r, 0));
  const clock = new SimulatedClock(0);
  try {
    const actor = createActor(machine, { now: clock.now });
    const start = actor.snapshot() as RefSnapshot;
    const steps: Step[] = [];
    for (const event of events) {
      const result = actor.send(event) as { ok: boolean; reason?: string; snapshot: RefSnapshot };
      steps.push(stepOf(event, result));
      // Let a task's microtask land, then move the clock so a timer or a task's delay fires.
      await tick();
      clock.advance(step);
      await tick();
    }
    actor.stop();
    return { start, steps };
  } finally {
    clock.uninstall();
  }
}

/**
 * The compiled machine's trace for `events`, with a host restart after `restartAt` events: the
 * actor is persisted (`persist(actor)`), stopped, its snapshot goes through JSON, and a new actor is
 * restored from it (`restoreActor`) on the same clock. The trace is the concatenation, so a correct
 * persistence is observationally transparent: the restarted run must equal the reference's
 * single-actor run, which never persists. A timer that was pending keeps only the time it had left,
 * and a task restarts (the runtime's contract), so the reference's arrivals are the same either way.
 */
export async function traceCompiledRestart(
  machine: Compiled,
  events: readonly RefEvent[],
  step: number,
  restartAt: number,
  options: { dropRun?: boolean } = {},
): Promise<Trace> {
  const { createActor, restoreActor } = await import("@reactre/state");
  const { persist } = await import("@reactre/state/persist");
  const { SimulatedClock } = await import("@reactre/state/utils");
  const realSetTimeout = globalThis.setTimeout;
  const tick = (): Promise<void> => new Promise((r) => realSetTimeout(r, 0));
  const clock = new SimulatedClock(0);
  try {
    let actor = createActor(machine, { now: clock.now });
    const start = actor.snapshot() as RefSnapshot;
    const steps: Step[] = [];
    for (const [i, event] of events.entries()) {
      const result = actor.send(event) as { ok: boolean; reason?: string; snapshot: RefSnapshot };
      steps.push(stepOf(event, result));
      await tick();
      clock.advance(step);
      await tick();
      if (i + 1 === restartAt) {
        // The host restarts: save, stop, and restore from the JSON a store would hold. `dropRun`
        // corrupts the save (a store that kept only the plain snapshot), for the non-vacuity check.
        const saved = JSON.parse(JSON.stringify(persist(actor as never))) as Parameters<typeof restoreActor>[1] & {
          run?: unknown;
        };
        if (options.dropRun === true) delete saved.run;
        actor.stop();
        actor = restoreActor(machine, saved, { now: clock.now });
      }
    }
    actor.stop();
    return { start, steps };
  } finally {
    clock.uninstall();
  }
}

/** A payload sample for each event, from the spec's fields, seeded so a run is reproducible. */
export function samples(spec: Spec, seed: number, count: number): RefEvent[] {
  const r = rng(seed ^ 0x9e3779b9);
  const out: RefEvent[] = [];
  for (let i = 0; i < count; i++) {
    const event = r.pick(spec.events);
    const payload: { [field: string]: number | string } = {};
    for (const f of payloadOf(spec, event.name))
      payload[f.name] = f.kind === "number" ? r.int(5) : r.pick(["a", "b", "c"]);
    out.push({ type: event.name, ...payload });
  }
  return out;
}

/** The first step where two traces differ, or null when they agree. */
export function firstDifference(a: Trace, b: Trace): number | null {
  if (JSON.stringify(a.start) !== JSON.stringify(b.start)) return 0;
  const n = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) if (JSON.stringify(a.steps[i]) !== JSON.stringify(b.steps[i])) return i + 1;
  return null;
}

/** A trace as lines, for a failure message. */
export function showTrace(trace: Trace): string {
  const lines = [`start ${JSON.stringify(trace.start)}`];
  for (const [i, s] of trace.steps.entries())
    lines.push(
      `${i + 1}. ${JSON.stringify(s.event)} -> ${s.ok ? "" : `${s.reason} `}${JSON.stringify({ state: s.state, data: s.data, version: s.version })}`,
    );
  return lines.join("\n");
}

/** What a differential run found: the traces, and the first step any two disagree on. */
export interface Divergence {
  readonly seed: number;
  readonly step: number;
  readonly reference: Trace;
  readonly src: Trace;
  readonly dev: Trace;
  readonly prod: Trace;
  readonly spec: Spec;
  readonly events: readonly RefEvent[];
}

/**
 * Runs `spec`'s events four ways and returns the first divergence, or null when all agree: the
 * reference (the oracle), the original source through the runtime plugin, and the compiler's dev
 * and production output. The reference is compared with each of the other three, and the three with
 * each other, so a bug in the plugin, in `compile`, or in the runtime shows.
 */
export async function differential(spec: Spec, events: readonly RefEvent[]): Promise<Divergence | null> {
  const referenceTrace = traceReference(spec, events);
  const srcTrace = await traceCompiled(await load(spec, "src"), events);
  const devTrace = await traceCompiled(await load(spec, "dev"), events);
  const prodTrace = await traceCompiled(await load(spec, "prod"), events);
  const step =
    firstDifference(referenceTrace, srcTrace) ??
    firstDifference(referenceTrace, devTrace) ??
    firstDifference(referenceTrace, prodTrace) ??
    firstDifference(srcTrace, devTrace) ??
    firstDifference(srcTrace, prodTrace) ??
    firstDifference(devTrace, prodTrace);
  return step === null
    ? null
    : { seed: spec.seed, step, reference: referenceTrace, src: srcTrace, dev: devTrace, prod: prodTrace, spec, events };
}

/**
 * The async differential: the same four-way comparison, but with a simulated clock, so a task's
 * result and a timer's move are exercised. `step` is how far the clock moves after each event. The
 * reference computes arrivals from the spec; the machine schedules them from its table.
 */
export async function differentialAsync(
  spec: Spec,
  events: readonly RefEvent[],
  step: number,
): Promise<Divergence | null> {
  const referenceTrace = traceReferenceAsync(spec, events, step);
  const srcTrace = await traceCompiledAsync(await load(spec, "src"), events, step);
  const devTrace = await traceCompiledAsync(await load(spec, "dev"), events, step);
  const prodTrace = await traceCompiledAsync(await load(spec, "prod"), events, step);
  const at =
    firstDifference(referenceTrace, srcTrace) ??
    firstDifference(referenceTrace, devTrace) ??
    firstDifference(referenceTrace, prodTrace) ??
    firstDifference(srcTrace, devTrace) ??
    firstDifference(srcTrace, prodTrace) ??
    firstDifference(devTrace, prodTrace);
  return at === null
    ? null
    : {
        seed: spec.seed,
        step: at,
        reference: referenceTrace,
        src: srcTrace,
        dev: devTrace,
        prod: prodTrace,
        spec,
        events,
      };
}

/**
 * Shrinks a failing event sequence: drops events while `fails` still holds, so the reported sequence
 * is a minimal one that still fails. `fails` is the differential's own check by default (a spec
 * against its compiled machine); a test that corrupts the source passes its own. Returns the
 * shortest sequence found (single-event removal, which is enough for a linear trace).
 */
export async function shrink(
  spec: Spec,
  events: readonly RefEvent[],
  fails: (events: readonly RefEvent[]) => Promise<boolean> = async (e) => (await differential(spec, e)) !== null,
): Promise<readonly RefEvent[]> {
  let best = [...events];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < best.length; i++) {
      const candidate = [...best.slice(0, i), ...best.slice(i + 1)];
      if (await fails(candidate)) {
        best = candidate;
        changed = true;
        break;
      }
    }
  }
  return best;
}

/** A failure message: the seed, the contract, the minimal steps, and the three traces. */
export function describe(d: Divergence): string {
  return [
    `fuzz: seed ${d.seed} diverged at step ${d.step}`,
    `events: ${JSON.stringify(d.events)}`,
    "",
    "reference:",
    showTrace(d.reference),
    "",
    "source:",
    showTrace(d.src),
    "",
    "dev:",
    showTrace(d.dev),
    "",
    "prod:",
    showTrace(d.prod),
    "",
    "contract (the spec the seed stands for):",
    showSpec(d.spec),
  ].join("\n");
}

/** A spec from a seed, with the default size. */
export { generate };
