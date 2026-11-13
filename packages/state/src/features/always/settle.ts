// What always, choice and output share: a node graph that settles after every move. Each wraps the
// graph before it in the table (`g: always.g(choice.g(nested.g))`), or, on a flat machine, the flat
// one: after the inner graph builds a snapshot, it takes the eventless step its feature picks from
// the active nodes (innermost first), again and again, until none does. Every move passes through
// `g` (`__snap`), so a start, an event, a timer and a task's error all settle the same way, and no
// in-between state is ever a snapshot.

import { StateError } from "../../index.ts";
import type { __Compiled, __Graph, __Node, __Step, __To } from "../../internal.ts";

/** Internal: the eventless step to take from the active nodes (innermost first), or none: rest. */
export type __Pick = (m: __Compiled, active: readonly __Node[]) => __Step | null | undefined;

/**
 * Internal: the graph of a flat machine: its leaf is its only node, and a `to` step is its snapshot,
 * as in the core's `__snap` (back needs nested). A reentering step that reaches it (an eventless
 * one, settled under reenter's graph) moves as its `to` does.
 */
export const __flatGraph: __Graph = {
  nodes: (_, s) => [{ node: s.state, state: s.state, data: s.data }],
  snap(m, step) {
    const s = ("r" in step ? step.r : step) as __To;
    m.d?.(s.data);
    return s;
  },
};

/** How many eventless moves one move may take before it is a loop (XState's InfiniteTransitionError). */
const LIMIT = 100;

/** Internal: a graph that settles `inner`'s snapshots with the steps `pick` gives. */
export const __settle =
  (pick: __Pick) =>
  (inner: __Graph = __flatGraph): __Graph => ({
    nodes: inner.nodes,
    snap(m, step, from) {
      let s = inner.snap(m, step, from);
      for (let moved = 0; ; moved++) {
        const next = pick(m, inner.nodes(m, s).reverse());
        if (!next) return s;
        if (moved === LIMIT)
          throw new StateError(
            "S50",
            `eventless transitions moved ${LIMIT} times without resting, last into "${s.state}": an always must rest once it moved (check its data); a choice or a parent's done must not loop`,
          );
        s = inner.snap(m, next, s);
      }
    },
  });
