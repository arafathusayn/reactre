// @reactre/state/nested (prototype): the hierarchy, for a machine with parents, parallel nodes or
// `back`: `setup({ use: [nested], ... })`. The compiler puts its hooks in the table
// (`g: nested.g, y: nested.y`) only for such a machine, so a flat machine ships none of it. The
// parallel and history features' runtime is here too (regions in the snapshot, history kept on
// exit): they need nested, and their own values carry no code.
//
// Design decisions:
//   - The table stays flat. A parent is a prefix of its leaves' names ("edit" of "edit.draft"),
//     so the hierarchy is read from the names: no tree is built, and a node's handlers are found
//     by name in `o`, as a leaf's are.
//   - The snapshot is a unit: a leaf with its data, or a parallel node with its regions'
//     units as its data. A region's unit is a leaf, or a parallel node inside the region with its own
//     regions, all the way down. History is part of it, so it stays JSON.
//   - Bubbling: an event goes to the leaf's handler, then its parents', innermost first. `null`
//     bubbles on; the first step found decides. In a parallel node, each region's unit is asked in
//     order (a nested parallel node's regions first, then its own chain up to the region), then the
//     node and its parents if no region moved. A step that leaves a parallel node drops its other
//     regions.
//   - Each move is settled by the whole graph (`m.g`, which features like always and choice wrap)
//     before the next region sees the event.
//   - A parallel node whose regions are all in final leaves goes where its `done` says, in the
//     same step: the all-final state is never a snapshot, so no runner starts or stops for it.
//   - Shallow history (`back(parent, fallback, { child: to(...) })`) re-enters the parent's last
//     direct child: a leaf child comes back whole, a parent child through the step given for it.

import type { Feature } from "../../index.ts";
import type { __Compiled, __Graph, __Leaf, __Node, __Snapshot, __Step, __StepHook } from "../../internal.ts";
import { __flatGraph, __flatGraphShallow, __flatNested } from "./flat.ts";

// The flat graph and step, for the compiler to import by name (a machine with no parallel node):
// re-exported here so the app's own import of `nested` is the only one it writes.
export { __flatGraph, __flatGraphShallow, __flatNested };

type Regions = { readonly [region: string]: __Leaf };

/** The nodes from the root down to `name`: "a.b.c" is ["a", "a.b", "a.b.c"]. */
function chain(name: string): string[] {
  const parts = name.split(".");
  return parts.map((_, i) => parts.slice(0, i + 1).join("."));
}

/** `state` is `node`, or under it. */
const within = (state: string, node: string): boolean => state === node || state.startsWith(`${node}.`);

/** The unit named `name` in `s`: `s` itself, or a unit in its regions, all the way down. */
const unitOf = (m: __Compiled, s: __Leaf, name: string): __Leaf | undefined => {
  if (s.state === name) return s;
  if (!m.p?.[s.state] || !name.startsWith(`${s.state}.`)) return undefined;
  const v = (s.data as Regions)[regionOf(s.state, name)];
  return v && unitOf(m, v, name);
};

/** The active nodes of unit `u` from `depth`, outermost first, then its regions' (all the way down). */
const collect = (m: __Compiled, u: __Leaf, depth: number, out: __Node[]): __Node[] => {
  const names = chain(u.state);
  for (const node of names.slice(depth)) out.push({ node, state: u.state, data: u.data });
  for (const r of m.p?.[u.state] ?? []) {
    const v = (u.data as Regions)[r];
    if (v !== undefined) collect(m, v, names.length, out);
  }
  return out;
};

const nodes: __Graph["nodes"] = (m, s) => collect(m, s, 0, []);

/**
 * The unit a step's target enters: a leaf, or a parallel node with a step (or, restored, a unit) per
 * region. Each region's unit is built as `{ state, data }`: a region's step is a `to`, whose
 * `version` belongs to snapshots, not regions.
 */
const enter = (m: __Compiled, state: string, data: unknown): __Leaf => {
  const regions = m.p?.[state];
  if (!regions) return { state, data };
  const given = data as Regions;
  const entered: { [region: string]: __Leaf } = {};
  for (const r of regions) {
    const v = given[r];
    if (v !== undefined) entered[r] = enter(m, v.state, v.data);
  }
  return { state, data: entered };
};

/** The region of parallel node `p` that `name` is in. */
const regionOf = (p: string, name: string): string => name.slice(p.length + 1).split(".")[0] ?? "";

/** `t` put where it goes in `u`: into the region of `u` (all the way down) that it is in, or in place of `u`. */
const place = (m: __Compiled, u: __Leaf, t: __Leaf): __Leaf => {
  if (!m.p?.[u.state] || !t.state.startsWith(`${u.state}.`)) return t;
  const r = regionOf(u.state, t.state);
  const at = (u.data as Regions)[r];
  return { state: u.state, data: { ...(u.data as Regions), [r]: at === undefined ? t : place(m, at, t) } };
};

/**
 * The `done` step of the deepest parallel node in `u` whose regions have all ended (each in a final
 * leaf that no parent with its own `done`, from output, is over), if any.
 */
const finished = (m: __Compiled, u: __Leaf): __Step | undefined => {
  const regions = m.p?.[u.state];
  if (!regions) return undefined;
  let all = true;
  for (const r of regions) {
    const v = (u.data as Regions)[r];
    const inner = v && finished(m, v);
    if (inner !== undefined) return inner;
    if (v === undefined || m.f?.[v.state] !== 1 || chain(v.state).some((n) => n.length > u.state.length && m.od?.[n]))
      all = false;
  }
  const done = m.n?.[u.state];
  return all && done ? done(u.data) : undefined;
};

const snap: __Graph["snap"] = (m, step, from) => {
  let unit: __Leaf;
  if ("b" in step) {
    // back(parent, fallback, shallow?): the unit the parent held when it was last left, or the
    // fallback; with shallow history, the step given for the parent's direct child it held.
    const kept = from?.history?.[step.b];
    if (!kept) return snap(m, step.t, from);
    const shallow = step.s?.[regionOf(step.b, kept.state)];
    if (shallow) return snap(m, shallow, from);
    unit = kept;
  } else {
    // A reentering step (`{ r }`, from reenter) is placed like any other.
    const to = "r" in step ? step.r : step;
    const entered = enter(m, to.state, to.data);
    unit = from && m.p ? place(m, from, entered) : entered;
  }
  let history = from?.history;
  if (m.h && from)
    for (const parent in m.h)
      if (within(from.state, parent) && !within(unit.state, parent))
        history = { ...history, [parent]: { state: from.state, data: from.data } };
  const next: __Snapshot = {
    state: unit.state,
    data: m.d ? m.d(unit.data) : unit.data,
    version: m.v,
    ...(m.h && { history: history ?? {} }),
  };
  const done = finished(m, next);
  return done === undefined ? next : snap(m, done, next);
};

/** Internal: the node graph, for the compiled table's `g`. */
export const __graph: __Graph = { nodes, snap };

/** Internal: the step for a machine with a hierarchy, for the compiled table's `y`. */
export const __nested: __StepHook = (m, from, event) => {
  let declined = false;
  let at = from;
  let moves = 0;
  /** The first step the handlers of `names` (innermost first) give for `leaf`. */
  const find = (names: readonly string[], leaf: __Leaf): __Step | null => {
    for (const name of names) {
      const next = m.o[name]?.[event.type]?.(leaf.data, event, leaf.state);
      if (next) return next;
      if (next === null) declined = true;
    }
    return null;
  };
  /**
   * Offer the event to the unit `name` in `at`: its regions' units first, then its own nodes from
   * the unit up to `depth`. Returns the target of a step that left the unit (or entered it again),
   * which drops its other regions; null otherwise.
   */
  const offer = (name: string, depth: number): string | null => {
    const own = chain(name);
    const before = moves;
    // The unit is the same for every region and for the node's own handlers: found once.
    const u = unitOf(m, at, name);
    for (const r of m.p?.[name] ?? []) {
      const v = u && (u.data as Regions)[r];
      // A region in a final leaf has ended: it takes no events.
      if (v === undefined || m.f?.[v.state] === 1) continue;
      const left = offer(v.state, own.length);
      if (left !== null && !within(left, name)) return left;
    }
    if (moves !== before) return null;
    const next = u && find(own.slice(depth).reverse(), u);
    if (!next) return null;
    // Through the whole graph, so what wraps it (always, choice) settles each move.
    at = (m.g ?? __graph).snap(m, next, at);
    moves++;
    return "b" in next ? "" : "r" in next ? next.r.state : next.state;
  };
  offer(from.state, 0);
  return moves > 0
    ? { ok: true, snapshot: at }
    : { ok: false, reason: declined ? "declined" : "unhandled", snapshot: from };
};

/**
 * The nested opt-in: parents, by dotted names (`"edit.draft"` is under `"edit"`).
 * `setup({ use: [nested], states: { idle: types<{}>(), "edit.draft": types<{ text: string }>() } })`.
 *
 * The compiler imports the small non-parallel graph and step by name; a machine with a parallel
 * node uses this value's `g` and `y`. An app with a hierarchy and no parallel node ships none of the
 * region code (./flat.ts); shallow history gets its own small graph.
 */
export const nested: Nested = { g: __graph, y: __nested };

/** The nested opt-in's type: an interface, so a type error names it `Nested`, not its hooks. */
export interface Nested extends Feature<"nested"> {
  /** Internal: the node graph (`g` in the table). */
  readonly g: __Graph;
  /** Internal: the hierarchy's step (`y`). */
  readonly y: __StepHook;
}
