// @reactre/state/timeout (prototype): a state's deadline. `setup({ use: [timeout], ... })`, then
// `waiting: { timeout: "30s", onTimeout: ({ to }) => to("escalated"), on: { ... } }`. The compiler
// puts it with delays's timers resolved at entry (`l`), and this value carries their runner
// (../delays's, shared: a bundle with both holds it once).
//
// Design decisions:
//   - A timeout is a timer like `after`'s, with XState's distinction kept: `after` says "then",
//     `timeout` says "by then". Both are cancelled when the state exits, and can be used together.
//   - It may be a function of the state's data (`timeout: ({ data }) => data.slaMs`), typed by the
//     state: unlike setup's delays, it is written where its state is known.
//   - With `persist` in use, its deadline is saved as delays's are (../delays/saved.ts, listed by the
//     compiler only then): a restored actor waits what was left.
//   - An invocation's timeout belongs to the invoked child (`logic`, `children`), not here.

import type { Feature } from "../../index.ts";
import type { __Runner } from "../../internal.ts";
import { __late } from "../delays/index.ts";

/** The timeout opt-in: `timeout` and `onTimeout` on a state. `setup({ use: [timeout], ... })`. */
export const timeout: Timeout = { r: __late };

/** The timeout opt-in's type: an interface, so a type error names it `Timeout`, not its hooks. */
export interface Timeout extends Feature<"timeout"> {
  /** Internal: the runner of the timers resolved at entry (`l`), delays's. */
  readonly r: __Runner;
}
