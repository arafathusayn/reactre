// @reactre/state/output (prototype): final states' output and a parent's completion,
// `setup({ use: [nested, output], ... })`, then `done: ({ state, data, to }) => to(...)` on a parent.
//
// Design decisions:
//   - XState's final state has an `output` mapper, and its parent's `onDone` reads `event.output`.
//     Here every state has its own data, so a final leaf's output is its data: no mapper to write,
//     and nothing a final state could compute that the transition into it couldn't (one way).
//   - A parent's `done` (parallel's word for a parallel node's completion, the same here) runs when a
//     leaf under it is final, with that leaf's `{ state, data }`: the leaf is never a snapshot, so the
//     machine ends only in a final leaf no parent with a done is over. It needs nested (a parent).
//   - The actor's output is its last snapshot once `status()` is "done", typed `Output<typeof machine>`:
//     a snapshot is already `{ state, data }`, so XState's `snapshot.output` needs no field of its own.
//   - It runs where always does (../always/settle.ts): every move settles, innermost parent first.

import type { Feature } from "../../index.ts";
import type { __Graph } from "../../internal.ts";
import { __settle } from "../always/settle.ts";

export type { Output } from "./types.ts";

/** Internal: the graph that takes a parent's done (`od`) when the leaf under it is final. */
export const __done: (inner?: __Graph) => __Graph = __settle((m, active) => {
  for (const n of active) {
    const done = m.od?.[n.node];
    if (done && m.f?.[n.state] === 1) return done(n.data, n.state);
  }
  return null;
});

/** The output opt-in (with nested): `done: ({ state, data, to }) => to(...)` on a parent. */
export const output: OutputFeature = { g: __done };

/** The output opt-in's type: an interface, so a type error names it. */
export interface OutputFeature extends Feature<"output"> {
  /** Internal: wraps the node graph (`g` in the table). */
  readonly g: (inner?: __Graph) => __Graph;
}
