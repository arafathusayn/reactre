// @reactre/state/graph (prototype): paths through a machine's graph (xstate/graph): shortest and
// simple paths, paths from a list of events, the adjacency map, and a directed graph. Each walks
// the pure `initial` and `transition`, so nothing runs: no task, timer or child.
//
// Design decisions:
//   - Like XState v6, traversal sends sample events: an event with payload fields needs samples
//     (`events: { push: [{ by: "ann" }] }`, a type error when missing), and one without gets `{ type }`.
//     A sample may be a function of the snapshot. The route event (`route`) is an event like any other.
//   - A state is identified by its snapshot's JSON (`state`, `data`, `history`): two snapshots with
//     the same leaf and different data are different states, since a handler may read the data.
//     `serialize` changes that, and `stopWhen` and `limit` bound a graph whose data grows.
//   - `toDirectedGraph` is the node tree (parents, leaves, parallel nodes) with the edges the
//     traversal found, from unit to unit, labelled by event type: handlers are functions, so their
//     targets are known by taking them (XState's static graph leaves them out and says so).
//   - Final states end a path: an actor there is done.

import {
  type ActorInput,
  initial,
  type Machine,
  type SendEvent,
  type Shape,
  type Snapshot,
  transition,
} from "../index.ts";
import type { __Compiled, __Event, __Snapshot } from "../internal.ts";

/** An event's payload, without its `type`. */
type Payload<D extends Shape, E> = Omit<Extract<SendEvent<D>, { readonly type: E }>, "type">;

/** The events whose payload has a required field: traversal needs samples of them. */
type NeedsSamples<D extends Shape> = {
  [E in SendEvent<D>["type"]]: {} extends Payload<D, E> ? never : E;
}[SendEvent<D>["type"]];

/** Samples of an event's payload: a list, or a function of the snapshot giving one. */
type Samples<D extends Shape, E> =
  readonly [Payload<D, E>, ...Payload<D, E>[]] | ((snapshot: Snapshot<D>) => readonly Payload<D, E>[]);

/** Payload samples by event type: required for an event whose payload has a required field. */
export type EventCases<D extends Shape> = { readonly [E in SendEvent<D>["type"]]?: Samples<D, E> } & {
  readonly [E in NeedsSamples<D>]-?: Samples<D, E>;
};

/** How to walk a machine. */
export type TraversalOptions<D extends Shape> = ([ActorInput<D>] extends [undefined]
  ? { readonly input?: undefined }
  : { readonly input: ActorInput<D> }) &
  ([NeedsSamples<D>] extends [never] ? { readonly events?: EventCases<D> } : { readonly events: EventCases<D> }) & {
    /** A state's identity: its snapshot's JSON by default. */
    readonly serialize?: (snapshot: Snapshot<D>) => string;
    /** Don't go on from a state where this is true. */
    readonly stopWhen?: (snapshot: Snapshot<D>) => boolean;
    /** Only paths to states where this is true. */
    readonly toState?: (snapshot: Snapshot<D>) => boolean;
    /** Start here instead of `initial`. */
    readonly fromState?: Snapshot<D>;
    /** At most this many states. */
    readonly limit?: number;
  };

/** One step of a path: the event sent, and the state it led to. */
export interface Step<D extends Shape> {
  readonly event: SendEvent<D>;
  readonly state: Snapshot<D>;
}

/** A path: where it ends, the steps that get there, and how many. */
export interface StatePath<D extends Shape> {
  readonly state: Snapshot<D>;
  readonly steps: readonly Step<D>[];
  readonly weight: number;
}

/** For each state (by its key): the state, and each event's step from it (by the event's JSON). */
export type AdjacencyMap<D extends Shape> = {
  readonly [state: string]: {
    readonly state: Snapshot<D>;
    readonly transitions: { readonly [event: string]: Step<D> };
  };
};

/** A node of the directed graph: its name, the nodes under it, and the edges from it. */
export interface DirectedGraphNode {
  readonly id: string;
  readonly children: readonly DirectedGraphNode[];
  readonly edges: readonly { readonly source: string; readonly target: string; readonly label: string }[];
}

/** What the walks share, untyped. */
interface Walk {
  readonly start: __Snapshot;
  readonly key: (s: __Snapshot) => string;
  readonly next: (s: __Snapshot) => { readonly event: __Event; readonly state: __Snapshot }[];
  readonly stop: (s: __Snapshot) => boolean;
  readonly to: (s: __Snapshot) => boolean;
  readonly limit: number;
}

/** A cast: the typed options, read untyped (the types checked them where they were written). */
interface Untyped {
  readonly input?: unknown;
  readonly events?: { readonly [type: string]: readonly object[] | ((s: __Snapshot) => readonly object[]) | undefined };
  readonly serialize?: (s: __Snapshot) => string;
  readonly stopWhen?: (s: __Snapshot) => boolean;
  readonly toState?: (s: __Snapshot) => boolean;
  readonly fromState?: __Snapshot;
  readonly limit?: number;
}

function walk(m: __Compiled, o: Untyped = {}): Walk {
  return {
    start: o.fromState ?? initial(m as Machine<Shape>, o.input as never),
    key: o.serialize ?? ((s) => JSON.stringify([s.state, s.data, s.history])),
    next(s) {
      if (m.f?.[s.state] === 1) return [];
      const out: { event: __Event; state: __Snapshot }[] = [];
      for (const type of Object.keys(m.e)) {
        const cases = o.events?.[type];
        const payloads = cases === undefined ? [{}] : typeof cases === "function" ? cases(s) : cases;
        for (const payload of payloads) {
          const event = { ...payload, type };
          const r = transition(m as Machine<Shape>, s as never, event as never);
          if (r.ok) out.push({ event, state: r.snapshot });
        }
      }
      return out;
    },
    stop: o.stopWhen ?? (() => false),
    to: o.toState ?? (() => true),
    limit: o.limit ?? Infinity,
  };
}

/** Every state's shortest path, breadth first. */
function shortest(w: Walk): StatePath<Shape>[] {
  const paths = new Map<string, { state: __Snapshot; steps: { event: __Event; state: __Snapshot }[] }>();
  paths.set(w.key(w.start), { state: w.start, steps: [] });
  const queue = [w.start];
  for (let i = 0; i < queue.length && paths.size < w.limit; i++) {
    const s = queue[i]!;
    if (w.stop(s)) continue;
    const here = paths.get(w.key(s))!;
    for (const step of w.next(s)) {
      const k = w.key(step.state);
      if (paths.has(k) || paths.size >= w.limit) continue;
      paths.set(k, { state: step.state, steps: [...here.steps, step] });
      queue.push(step.state);
    }
  }
  return done([...paths.values()], w);
}

/** Every simple path (no state twice) to every state, depth first. */
function simple(w: Walk): StatePath<Shape>[] {
  const out: { state: __Snapshot; steps: { event: __Event; state: __Snapshot }[] }[] = [];
  const seen = new Set<string>();
  const visit = (s: __Snapshot, steps: { event: __Event; state: __Snapshot }[]): void => {
    if (out.length >= w.limit) return;
    seen.add(w.key(s));
    out.push({ state: s, steps });
    if (!w.stop(s)) for (const step of w.next(s)) if (!seen.has(w.key(step.state))) visit(step.state, [...steps, step]);
    seen.delete(w.key(s));
  };
  visit(w.start, []);
  return done(out, w);
}

/** A cast: the paths, typed as the machine's (they were made by its own `transition`). */
const done = (
  paths: { state: __Snapshot; steps: { event: __Event; state: __Snapshot }[] }[],
  w: Walk,
): StatePath<Shape>[] =>
  paths.filter((p) => w.to(p.state)).map((p) => ({ ...p, weight: p.steps.length }) as unknown as StatePath<Shape>);

/** The shortest path to every state the machine can reach with the sample events. */
export function getShortestPaths<D extends Shape>(machine: Machine<D>, ...options: Options<D>): StatePath<D>[];
export function getShortestPaths(m: __Compiled, options?: Untyped): StatePath<Shape>[] {
  return shortest(walk(m, options));
}

/** Every simple path (no state twice) to every state the machine can reach with the sample events. */
export function getSimplePaths<D extends Shape>(machine: Machine<D>, ...options: Options<D>): StatePath<D>[];
export function getSimplePaths(m: __Compiled, options?: Untyped): StatePath<Shape>[] {
  return simple(walk(m, options));
}

/** The path `events` take from the start, to each state it passes through (an event that doesn't move is skipped). */
export function getPathsFromEvents<D extends Shape>(
  machine: Machine<D>,
  events: readonly SendEvent<D>[],
  ...options: Options<D>
): StatePath<D>[];
export function getPathsFromEvents(m: __Compiled, events: readonly __Event[], options?: Untyped): StatePath<Shape>[] {
  const w = walk(m, options);
  const paths = new Map<string, { state: __Snapshot; steps: { event: __Event; state: __Snapshot }[] }>();
  let s = w.start;
  let steps: { event: __Event; state: __Snapshot }[] = [];
  paths.set(w.key(s), { state: s, steps });
  for (const event of events) {
    const r = transition(m as Machine<Shape>, s as never, event as never);
    if (!r.ok) continue;
    s = r.snapshot;
    steps = [...steps, { event, state: s }];
    if (!paths.has(w.key(s))) paths.set(w.key(s), { state: s, steps });
  }
  return done([...paths.values()], w);
}

/** Every state the machine can reach with the sample events, with each event's step from it. */
export function getAdjacencyMap<D extends Shape>(machine: Machine<D>, ...options: Options<D>): AdjacencyMap<D>;
export function getAdjacencyMap(m: __Compiled, options?: Untyped): AdjacencyMap<Shape> {
  const w = walk(m, options);
  const out: { [state: string]: { state: __Snapshot; transitions: { [event: string]: unknown } } } = {};
  const queue = [w.start];
  out[w.key(w.start)] = { state: w.start, transitions: {} };
  // At most `limit` states, each with its steps to the states in the map.
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i]!;
    if (w.stop(s)) continue;
    for (const step of w.next(s)) {
      const k = w.key(step.state);
      if (out[k] === undefined) {
        if (Object.keys(out).length >= w.limit) continue;
        out[k] = { state: step.state, transitions: {} };
        queue.push(step.state);
      }
      out[w.key(s)]!.transitions[JSON.stringify(step.event)] = step;
    }
  }
  // A cast: the map, typed as the machine's (its own `transition` made it).
  return out as unknown as AdjacencyMap<Shape>;
}

/** The node tree (parents, leaves, parallel nodes), with the edges the traversal found from each unit. */
export function toDirectedGraph<D extends Shape>(machine: Machine<D>, ...options: Options<D>): DirectedGraphNode;
export function toDirectedGraph(m: __Compiled, options?: Untyped): DirectedGraphNode {
  const names = new Set<string>();
  for (const name of [...Object.keys(m.o), ...Object.keys(m.f ?? {}), ...Object.keys(m.p ?? {})]) {
    const parts = name.split(".");
    parts.forEach((_, i) => names.add(parts.slice(0, i + 1).join(".")));
  }
  const edges = new Map<string, { source: string; target: string; label: string }[]>();
  const map = getAdjacencyMap(m as Machine<Shape>, ...([options] as Options<Shape>));
  for (const { state, transitions } of Object.values(map))
    for (const step of Object.values(transitions)) {
      const list = edges.get(state.state) ?? [];
      const edge = { source: state.state, target: step.state.state, label: step.event.type };
      if (!list.some((e) => e.target === edge.target && e.label === edge.label)) list.push(edge);
      edges.set(state.state, list);
    }
  const node = (id: string): DirectedGraphNode => ({
    id,
    children: [...names]
      .filter((n) => (id === "" ? !n.includes(".") : n.startsWith(`${id}.`) && !n.slice(id.length + 1).includes(".")))
      .map(node),
    edges: edges.get(id) ?? [],
  });
  return node("");
}

/** The options' argument: required when the machine takes input or an event needs samples. */
type Options<D extends Shape> = [ActorInput<D>] extends [undefined]
  ? [NeedsSamples<D>] extends [never]
    ? [options?: TraversalOptions<D>]
    : [options: TraversalOptions<D>]
  : [options: TraversalOptions<D>];
