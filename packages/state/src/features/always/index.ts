// @reactre/state/always (prototype): eventless transitions, `setup({ use: [always], ... })`, then
// `always: ({ data, to }) => (data.left === 0 ? to("empty") : null)` on any node that isn't final.
//
// Design decisions:
//   - XState's `always` is a transition taken without an event whenever its guard passes. Here it
//     is a function like any handler, returning `to(...)` or `null` (rest): the guard is the code.
//   - It runs after every move that leaves its node active, its node's entry included, innermost
//     node first, until no always moves: the in-between states are never snapshots, so no task,
//     timer or child starts in them. The table's graph does it (`g: always.g(nested.g)`), so a
//     start, an event, a timer and a task's error all settle the same way, flat or nested.
//   - A loop (an always that keeps moving) throws StateError S50 after 100 moves, as XState's
//     InfiniteTransitionError does: return null once the move is made.

import type { Feature } from "../../index.ts";
import type { __Graph } from "../../internal.ts";
import { __settle } from "./settle.ts";

/** Internal: the graph that takes each active node's `always` (`al`), innermost first. */
export const __always: (inner?: __Graph) => __Graph = __settle((m, active) => {
  for (const n of active) {
    const step = m.al?.[n.node]?.(n.data, n.state);
    if (step) return step;
  }
  return null;
});

/** The always opt-in: `setup({ use: [always] })`, then `always: ({ data, to }) => ...` on a node. */
export const always: Always = { g: __always };

/** The always opt-in's type: an interface, so a type error names it `Always`. */
export interface Always extends Feature<"always"> {
  /** Internal: wraps the node graph (`g` in the table). */
  readonly g: (inner?: __Graph) => __Graph;
}
