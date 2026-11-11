// Pure transitions of a whole actor system (xstate docs: system-transitions.md): a machine and its
// children, at any depth, as one JSON snapshot, stepped without running anything. Each call returns
// `[snapshot, effects]`: the next snapshot (the one given is unchanged), and the work a host does,
// as data: tasks to start (`runSystemTask` runs one; its result comes back through
// `systemTransition` with the task's id), tasks to cancel, and the effects a step recorded (`enq`).
//
// Design decisions:
//   - The same pure core as an actor: a step is `__step`, a move's node changes are run.ts's
//     `__changes`, a child's report runs its parent's `done` or `update`. Entering a node schedules
//     its timers at the virtual time, starts its task (an effect), and starts its children (their
//     start, at once); leaving it cancels all three. Messages (a child's report) go in FIFO order.
//   - Actors are addressed by path: "root", a child "root/upload", a keyed one "root/files:a".
//   - Virtual time: `advanceSystemTime(machine, snapshot, { time })` fires each due timer in order of
//     its deadline (then of scheduling), each at its own time, including timers scheduled meanwhile.
//   - Machines only: actor logic's work runs in a live actor, so a logic child throws S33 here, as
//     does a spawned child (spawn's runtime). Delayed effects aren't scheduled: they are in `effects`.

import { __snap, __step, type ActorInput, type Machine, type Shape, type Snapshot, StateError } from "../../index.ts";
import type {
  __Child,
  __Compiled,
  __Effect,
  __Event,
  __Leaf,
  __Node,
  __Result,
  __Snapshot,
  __Step,
} from "../../internal.ts";
import { __changes, __nodes } from "../../run.ts";

/** An actor in a system snapshot: its snapshot, and where it runs (none for the root). */
export interface SystemActor<S extends __Snapshot = __Snapshot> {
  readonly snapshot: S;
  /** The parent's path, the node that runs this child, its name in the node's children, its key. */
  readonly parent?: string;
  readonly node?: string;
  readonly name?: string;
  readonly key?: string;
}

/** A pending timer: the actor, the node whose `after` it is (by index), and when it fires. */
export interface SystemTimer {
  readonly actor: string;
  readonly node: string;
  readonly index: number;
  readonly due: number;
  readonly seq: number;
}

/** A system, as JSON. */
export interface SystemSnapshot<D extends Shape = Shape> {
  /** Virtual time, in milliseconds. */
  readonly time: number;
  /** Every actor by path: "root", then its children ("root/upload"). */
  readonly actors: { readonly [path: string]: SystemActor | undefined };
  /** The root's snapshot type, for `rootOf` (types only). */
  readonly "~root"?: Snapshot<D>;
  /** Timers not yet fired, in the order they were scheduled. */
  readonly timers: readonly SystemTimer[];
  /** Tasks started and not yet settled, by id: their actor and node. */
  readonly tasks: { readonly [id: string]: { readonly actor: string; readonly node: string } | undefined };
  /** The registry: each child's `registryKey`, and its path. */
  readonly registry: { readonly [key: string]: string | undefined };
  /** Orders timers and names tasks. */
  readonly seq: number;
}

/** Work for the host, as data. */
export type SystemEffect =
  | {
      /** Start a task: `runSystemTask(machine, effect, signal)`; send its event back with this id. */
      readonly type: "task";
      readonly id: string;
      readonly actor: string;
      readonly node: string;
      readonly state: string;
      readonly data: unknown;
    }
  | { /** Abort a task: its node exited. */ readonly type: "cancel"; readonly id: string }
  | {
      /** An effect a step recorded (`enq`), unrun. */ readonly type: "effect";
      readonly actor: string;
      readonly effect: __Effect;
    };

/** The step's bound: a chain of messages and timers longer than this throws S36. */
const MAX = 10_000;

/** A system snapshot being built: copies of the given one's parts, changed in place. */
interface Draft {
  time: number;
  readonly actors: { [path: string]: SystemActor | undefined };
  timers: SystemTimer[];
  readonly tasks: { [id: string]: { readonly actor: string; readonly node: string } | undefined };
  readonly registry: { [key: string]: string | undefined };
  seq: number;
  readonly fx: SystemEffect[];
  readonly queue: (() => void)[];
}

function draft(s: SystemSnapshot): Draft {
  return {
    time: s.time,
    actors: { ...s.actors },
    timers: [...s.timers],
    tasks: { ...s.tasks },
    registry: { ...s.registry },
    seq: s.seq,
    fx: [],
    queue: [],
  };
}

function done(d: Draft): [SystemSnapshot, SystemEffect[]] {
  for (let n = 0; d.queue.length > 0; n++) {
    if (n > MAX)
      throw new StateError(
        "S36",
        `the system kept moving after ${MAX} steps: a child and its parent keep reporting to each other. Stop the loop with a condition.`,
      );
    d.queue.shift()?.();
  }
  const { fx, queue: _, ...snapshot } = d;
  return [snapshot, fx];
}

/** The root actor's snapshot, typed by its machine. */
export function rootOf<D extends Shape>(snapshot: SystemSnapshot<D>): Snapshot<D>;
export function rootOf(snapshot: SystemSnapshot): __Snapshot | undefined {
  return snapshot.actors["root"]?.snapshot;
}

/** An actor by path, or S34 naming the paths there are. */
function at(d: Draft, path: string): SystemActor {
  const a = d.actors[path];
  if (a === undefined)
    throw new StateError(
      "S34",
      `the system has no actor "${path}": its actors are ${Object.keys(d.actors).join(", ")}.`,
    );
  return a;
}

/** A child's spec in its parent's table. */
function specOf(m: __Compiled, d: Draft, path: string): __Child | undefined {
  const a = at(d, path);
  if (a.parent === undefined || a.node === undefined || a.name === undefined) return undefined;
  return (a.parent === "root" ? m : specOf(m, d, a.parent)?.m)?.c?.[a.node]?.[a.name];
}

/** An actor's table: the root's, or its spec's machine. */
function tableOf(m: __Compiled, d: Draft, path: string): __Compiled {
  return path === "root" ? m : (specOf(m, d, path)?.m ?? m);
}

/** The leaf under `node` in an actor's snapshot now (its handlers read it). */
function leafAt(t: __Compiled, s: __Snapshot, node: string): __Leaf {
  return __nodes(t, s).find((n) => n.node === node) ?? s;
}

function enter(m: __Compiled, d: Draft, path: string, t: __Compiled, n: __Node): void {
  for (const [i, [ms]] of (t.a?.[n.node] ?? []).entries())
    d.timers.push({ actor: path, node: n.node, index: i, due: d.time + ms, seq: d.seq++ });
  if (t.t?.[n.node]) {
    const id = `task:${d.seq++}`;
    d.tasks[id] = { actor: path, node: n.node };
    d.fx.push({ type: "task", id, actor: path, node: n.node, state: n.state, data: n.data });
  }
  for (const [name, def] of Object.entries(t.c?.[n.node] ?? {})) {
    if (def.k === undefined) start(m, d, path, n.node, name, undefined, def, def.i?.(n.data, n.state));
    else for (const [key, input] of def.k(n.data, n.state)) start(m, d, path, n.node, name, key, def, input);
  }
}

/** Keyed children: new keys start, and keys that are gone stop. */
function stay(m: __Compiled, d: Draft, path: string, t: __Compiled, n: __Node): void {
  for (const [name, def] of Object.entries(t.c?.[n.node] ?? {})) {
    if (def.k === undefined) continue;
    const want = new Map(def.k(n.data, n.state));
    for (const [child, a] of Object.entries(d.actors))
      if (a?.parent === path && a.node === n.node && a.name === name && !want.has(a.key ?? "")) remove(d, child);
    for (const [key, input] of want)
      if (d.actors[`${path}/${name}:${key}`] === undefined) start(m, d, path, n.node, name, key, def, input);
  }
}

function exit(d: Draft, path: string, node: string): void {
  d.timers = d.timers.filter((t) => !(t.actor === path && t.node === node));
  for (const [id, task] of Object.entries(d.tasks))
    if (task?.actor === path && task.node === node) {
      delete d.tasks[id];
      d.fx.push({ type: "cancel", id });
    }
  for (const [child, a] of Object.entries(d.actors)) if (a?.parent === path && a.node === node) remove(d, child);
}

/** An actor stops: its timers, tasks and children with it, and its registry key. */
function remove(d: Draft, path: string): void {
  const a = d.actors[path];
  if (a === undefined) return;
  for (const node of new Set(
    [...d.timers, ...Object.values(d.tasks)].flatMap((x) => (x?.actor === path ? [x.node] : [])),
  ))
    exit(d, path, node);
  for (const [child, c] of Object.entries(d.actors)) if (c?.parent === path) remove(d, child);
  for (const [key, p] of Object.entries(d.registry)) if (p === path) delete d.registry[key];
  delete d.actors[path];
}

function start(
  m: __Compiled,
  d: Draft,
  parent: string,
  node: string,
  name: string,
  key: string | undefined,
  def: __Child,
  input: unknown,
): void {
  if (def.m.lg !== undefined)
    throw new StateError(
      "S33",
      `the pure system steps machines, and child "${name}" is actor logic (${def.m.lg}), whose work runs only in a live actor: run it with createActor, or make it a machine with a task.`,
    );
  const path = `${parent}/${key === undefined ? name : `${name}:${key}`}`;
  const snapshot = __snap(def.m, def.m.i(input));
  d.actors[path] = { snapshot, parent, node, name, ...(key === undefined ? {} : { key }) };
  if (def.g !== undefined) d.registry[def.g] = path;
  if (def.m.f?.[snapshot.state]) d.queue.push(() => report(m, d, path));
  else for (const n of __nodes(def.m, snapshot)) enter(m, d, path, def.m, n);
}

/** A move of the actor at `path`: its node changes, then its report to its parent. */
function apply(m: __Compiled, d: Draft, path: string, r: __Result): void {
  if (!r.ok) return;
  const a = at(d, path);
  const t = tableOf(m, d, path);
  d.actors[path] = { ...a, snapshot: r.snapshot };
  for (const effect of r.fx ?? []) d.fx.push({ type: "effect", actor: path, effect });
  const ended = t.f?.[r.snapshot.state] === 1;
  const changes = __changes(t, a.snapshot, r.snapshot);
  for (const n of changes.exit) exit(d, path, n.node);
  if (ended) for (const n of __nodes(t, r.snapshot)) exit(d, path, n.node);
  else {
    for (const n of changes.enter) enter(m, d, path, t, n);
    for (const n of changes.stay) stay(m, d, path, t, n);
  }
  if (a.parent !== undefined) d.queue.push(() => report(m, d, path));
}

/** A child moved: its parent's `done` (it ended) or `update`, read from the leaf under its node now. */
function report(m: __Compiled, d: Draft, path: string): void {
  const a = d.actors[path];
  const def = a && specOf(m, d, path);
  if (a?.parent === undefined || a.node === undefined || def === undefined) return;
  const parent = at(d, a.parent);
  const leaf = leafAt(tableOf(m, d, a.parent), parent.snapshot, a.node);
  const { state, data } = a.snapshot;
  const step = def.m.f?.[state]
    ? def.d?.(leaf.data, { state, data }, leaf.state, a.key)
    : def.u?.(leaf.data, { state, data }, leaf.state, a.key);
  if (step) go(m, d, a.parent, step);
}

function go(m: __Compiled, d: Draft, path: string, step: __Step): void {
  apply(m, d, path, { ok: true, snapshot: __snap(tableOf(m, d, path), step, at(d, path).snapshot) });
}

/** The system a machine starts: its root's start, and every node it enters (timers, tasks, children). */
export function initialSystem<D extends Shape>(
  machine: Machine<D>,
  ...options: [ActorInput<D>] extends [undefined]
    ? [options?: { readonly time?: number }]
    : [options: { readonly input: ActorInput<D>; readonly time?: number }]
): [SystemSnapshot<D>, SystemEffect[]];
export function initialSystem(
  m: __Compiled,
  options?: { readonly input?: unknown; readonly time?: number },
): [SystemSnapshot, SystemEffect[]] {
  const snapshot = __snap(m, m.i(options?.input));
  const d = draft({
    time: options?.time ?? 0,
    actors: { root: { snapshot } },
    timers: [],
    tasks: {},
    registry: {},
    seq: 0,
  });
  for (const n of __nodes(m, snapshot)) enter(m, d, "root", m, n);
  return done(d);
}

/**
 * The system after `event` reaches `target`: an actor's path ("root", "root/upload"), or a task's
 * id from a "task" effect, with its result (a dropped one, when its node exited), or with
 * `{ type: "@error", error }` when it failed (its node's task `error` decides).
 */
export function systemTransition<D extends Shape>(
  machine: Machine<D>,
  snapshot: SystemSnapshot<D>,
  target: string,
  event: __Event,
): [SystemSnapshot<D>, SystemEffect[]];
export function systemTransition(
  m: __Compiled,
  snapshot: SystemSnapshot,
  target: string,
  event: __Event & { readonly error?: unknown },
): [SystemSnapshot, SystemEffect[]] {
  const d = draft(snapshot);
  if (target.startsWith("task:")) {
    const task = d.tasks[target];
    if (task === undefined) return done(d);
    delete d.tasks[target];
    const t = tableOf(m, d, task.actor);
    const s = at(d, task.actor).snapshot;
    const leaf = leafAt(t, s, task.node);
    const fail = t.t?.[task.node]?.[1];
    if (event.type === "@error" && fail) go(m, d, task.actor, fail(leaf.data, event.error, leaf.state));
    else apply(m, d, task.actor, __step(t, s, event, true));
  } else {
    const a = at(d, target);
    const t = tableOf(m, d, target);
    if (t.f?.[a.snapshot.state] !== 1) apply(m, d, target, __step(t, a.snapshot, event, false));
  }
  return done(d);
}

/** The system at virtual time `time`: each timer due by then fires at its own deadline, in order. */
export function advanceSystemTime<D extends Shape>(
  machine: Machine<D>,
  snapshot: SystemSnapshot<D>,
  to: { readonly time: number },
): [SystemSnapshot<D>, SystemEffect[]];
export function advanceSystemTime(
  m: __Compiled,
  snapshot: SystemSnapshot,
  to: { readonly time: number },
): [SystemSnapshot, SystemEffect[]] {
  if (!(to.time >= snapshot.time))
    throw new StateError(
      "S35",
      `time ${to.time} is before the system's time, ${snapshot.time}: time only moves forward.`,
    );
  const d = draft(snapshot);
  for (let n = 0; ; n++) {
    if (n > MAX)
      throw new StateError(
        "S36",
        `the system kept moving after ${MAX} timers: a timer keeps scheduling itself. Stop the loop with a condition.`,
      );
    let next: SystemTimer | undefined;
    for (const t of d.timers)
      if (t.due <= to.time && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
    if (next === undefined) break;
    const timer = next;
    d.timers = d.timers.filter((t) => t !== timer);
    d.time = timer.due;
    const t = tableOf(m, d, timer.actor);
    const leaf = leafAt(t, at(d, timer.actor).snapshot, timer.node);
    const handler = t.a?.[timer.node]?.[timer.index]?.[1];
    if (handler) go(m, d, timer.actor, handler(leaf.data, leaf.state));
    // Each timer's chain of reports settles before the next timer fires.
    done(d);
  }
  d.time = to.time;
  return done(d);
}

/** Runs a "task" effect's task, for a host: its event goes back with `systemTransition(machine, s, effect.id, event)`. */
export function runSystemTask<D extends Shape>(
  machine: Machine<D>,
  snapshot: SystemSnapshot<D>,
  effect: Extract<SystemEffect, { readonly type: "task" }>,
  signal: AbortSignal,
): Promise<__Event>;
export function runSystemTask(
  m: __Compiled,
  snapshot: SystemSnapshot,
  effect: Extract<SystemEffect, { readonly type: "task" }>,
  signal: AbortSignal,
): Promise<__Event> {
  const run = tableOf(m, draft(snapshot), effect.actor).t?.[effect.node]?.[0];
  if (run === undefined)
    throw new StateError("S34", `the system has no task at "${effect.actor}" in "${effect.node}".`);
  return run(effect.data, signal, effect.state);
}
