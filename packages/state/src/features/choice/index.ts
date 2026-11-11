// @reactre/state/choice (prototype): choice states, `setup({ use: [choice], ... })`, then
// `routing: { choice: ({ data, to }) => (data.vip ? to("vip", data) : to("standard", data)) }`.
//
// Design decisions:
//   - XState's `type: "choice"` with a `choice` function returning `{ target }`. Here the key alone
//     says it (`choice: ...`), and it returns `to(...)` like any handler. A choice must resolve: its
//     type has no null, so "must resolve to a target" is a type error, not a throw at entry.
//   - A choice state is a leaf with data, like every state: the transition into it gives what the
//     choice reads (XState's state input). It takes nothing else (a type error says so), and the
//     machine's `Snapshot` leaves it out: the machine never rests there.
//   - It runs where always does (../always/settle.ts): every move into it, the start's included,
//     goes on to where it says in the same move, and a loop throws S50.

import type { Feature } from "../../index.ts";
import type { __Graph } from "../../internal.ts";
import { __settle } from "../always/settle.ts";

/** Internal: the graph that takes an active choice leaf's decision (`ch`). */
export const __choice: (inner?: __Graph) => __Graph = __settle((m, active) => {
  for (const n of active) {
    const step = m.ch?.[n.node]?.(n.data, n.state);
    if (step) return step;
  }
  return null;
});

/** The choice opt-in: `setup({ use: [choice] })`, then `choice: ({ data, to }) => to(...)` on a leaf. */
export const choice: Choice = { g: __choice };

/** The choice opt-in's type: an interface, so a type error names it `Choice`. */
export interface Choice extends Feature<"choice"> {
  /** Internal: wraps the node graph (`g` in the table). */
  readonly g: (inner?: __Graph) => __Graph;
}
