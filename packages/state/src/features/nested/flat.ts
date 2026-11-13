// @reactre/state/nested's flat graph (internal): the hierarchy for a machine with parents but no
// parallel node. The compiler picks it (`g: __flatGraph, y: __flatNested`) when setup's `parallel`
// is absent, so an app with a hierarchy and no parallel node ships none of the region code (regions
// in the snapshot, `place`, `unitOf`, `finished`'s region walk): the snapshot is always one leaf,
// and a move is always that leaf.
//
// The semantics are the full graph's, for a machine without parallel nodes:
//   - Bubbling: the leaf's handler, then its parents', innermost first; `null` bubbles on.
//   - History: `back(parent, fallback)` re-enters the parent's last direct child, or the fallback.
//     A shallow `back` (a third argument) needs `__flatGraphShallow`, which the compiler picks only
//     for a machine that writes one, so deep history alone ships none of it.
//   - A parent's `done` (output's `od`) runs when the leaf under it is final, through the graph
//     that wraps this one (always, choice, output, reenter), as in the full graph.
//   - The snapshot is `{ state, data, version, history? }`, as the full graph's is for a leaf.

import type { __Graph, __Leaf, __Snapshot, __Step, __StepHook } from "../../internal.ts";

/** The nodes from the root down to `name`: "a.b.c" is ["a", "a.b", "a.b.c"]. */
function chain(name: string): string[] {
  const out: string[] = [];
  for (let i = name.indexOf("."); i !== -1; i = name.indexOf(".", i + 1)) out.push(name.slice(0, i));
  out.push(name);
  return out;
}

/** The active nodes of a leaf: its chain, outermost first. */
const nodes: __Graph["nodes"] = (_m, s) => chain(s.state).map((node) => ({ node, state: s.state, data: s.data }));

const snap: __Graph["snap"] = (m, step, from) => {
  let unit: __Leaf;
  if ("b" in step) {
    // back(parent, fallback): the leaf the parent held when it was last left, or the fallback.
    const kept = from?.history?.[step.b];
    if (!kept) return snap(m, step.t, from);
    unit = kept;
  } else {
    // A reentering step (`{ r }`, from reenter) is placed like any other: it is the leaf.
    const to = "r" in step ? step.r : step;
    unit = { state: to.state, data: to.data };
  }
  // A parent left by this move keeps the leaf it held: a parent's name is a proper prefix of its
  // leaves' names, so "under it" is the dotted prefix.
  let history = from?.history;
  if (m.h && from)
    for (const parent in m.h)
      if (from.state.startsWith(`${parent}.`) && !unit.state.startsWith(`${parent}.`))
        history = { ...history, [parent]: { state: from.state, data: from.data } };
  return {
    state: unit.state,
    data: m.d ? m.d(unit.data) : unit.data,
    version: m.v,
    ...(m.h && { history: history ?? {} }),
  };
};

/** Internal: the graph for a machine with parents and no parallel node (`g`). */
export const __flatGraph: __Graph = { nodes, snap };

/**
 * Internal: the graph for a machine whose `back` has shallow steps (`s`): the parent's last direct
 * child, re-entered through the step given for it. The compiler picks it only then.
 */
export const __flatGraphShallow: __Graph = {
  nodes,
  snap: (m, step, from) => {
    if ("b" in step && step.s !== undefined) {
      const kept = from?.history?.[step.b];
      const shallow = kept && step.s[kept.state.slice(step.b.length + 1).split(".")[0] ?? ""];
      if (shallow !== undefined) return __flatGraphShallow.snap(m, shallow, from);
    }
    return snap(m, step, from);
  },
};

/** Internal: the step for a machine with parents and no parallel node (`y`). */
export const __flatNested: __StepHook = (m, from, event) => {
  let declined = false;
  for (const name of chain(from.state).reverse()) {
    const handler = m.o[name]?.[event.type];
    if (handler === undefined) continue;
    const next = handler(from.data, event, from.state);
    if (next !== null) return { ok: true, snapshot: (m.g ?? __flatGraph).snap(m, next, from) };
    declined = true;
  }
  return { ok: false, reason: declined ? "declined" : "unhandled", snapshot: from };
};
