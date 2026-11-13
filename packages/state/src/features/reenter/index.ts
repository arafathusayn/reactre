// @reactre/state/reenter (prototype): `setup({ use: [reenter], ... })`, then
// `retry: ({ data, reenter }) => reenter("loading", { ...data, attempt: data.attempt + 1 })`.
//
// Design decisions:
//   - XState's `reenter: true` is a transition property. Here a move is a function call, so it is
//     its own move beside `to`: `reenter(state, data)` takes what `to` takes, for a leaf. A move to the
//     current leaf with `to` stays in it (its task, timers and children keep running, XState's
//     default); `reenter` exits it and enters it again, so they restart.
//   - It compiles to `{ r: <to's step> }`. This graph (`g: reenter.g(...)`) builds the snapshot of
//     the `to` inside, as `to` would, and marks it; the general lifecycle asks the table's `re`
//     whether a move re-entered a node, and restarts that node's runners. A machine that uses it
//     gets the general lifecycle.

import type { Feature } from "../../index.ts";
import type { __Graph, __Snapshot } from "../../internal.ts";
import { __flatGraph } from "../always/settle.ts";

/** The snapshots made by a reentering move, with the leaf they re-entered. */
const marks = new WeakMap<__Snapshot, string>();

/** Internal: the graph that builds a reentering step's snapshot (`{ r: to }`) and marks it. */
export const __reentering = (inner: __Graph = __flatGraph): __Graph => ({
  nodes: inner.nodes,
  snap(m, step, from) {
    const re = "r" in step ? step.r : undefined;
    const s = inner.snap(m, re ?? step, from);
    if (re) marks.set(s, re.state);
    return s;
  },
});

/** The reenter opt-in: handlers get `reenter(state, data)`. */
export const reenter: ReenterFeature = { g: __reentering, re: (next, node) => marks.get(next) === node };

/** The reenter opt-in's type: an interface, so a type error names it. */
export interface ReenterFeature extends Feature<"reenter"> {
  /** Internal: wraps the node graph (`g` in the table). */
  readonly g: (inner?: __Graph) => __Graph;
  /** Internal: whether a move re-entered a node (`re` in the table). */
  readonly re: (next: __Snapshot, node: string) => boolean;
}
