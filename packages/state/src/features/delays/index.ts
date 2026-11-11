// @reactre/state/delays (prototype): named delays, delays from data, and ISO 8601 durations in
// `after`. `setup({ use: [delays], delays: { retry: "PT2S" } })`, then `after: { retry: ({ to }) =>
// to("loading") }` or `after: { PT1M30S: ... }`. The compiler parses durations to milliseconds and
// lists the timers whose delay is resolved at entry in `l`, with setup's delays in `w`; this value's
// runner runs them (`r: __run([delays.r])`). A machine that uses none ships none of it.
//
// Design decisions:
//   - ISO 8601 of fixed length only: weeks, days, hours, minutes, seconds ("P1W", "P1DT12H",
//     "PT1M30S"). A year or a month has no fixed length, so it is a type error naming days.
//   - A delay is read once, when its state is entered, from the data then: later data doesn't move
//     it (XState's rule). A named delay is looked up at entry, so `provide(machine, { delays })`
//     replaces it.
//   - `persist` saves each timer's deadline (absolute: the actor's `now()` at entry plus the delay,
//     null once it fired), as persist's own tasks runner does (../persist): a restored actor's timer
//     fires with the time it had left, and a fired one doesn't fire again. Timeout's timers are these.
//     The saving runner is ./saved.ts, which the compiler lists only when persist is in use: an app
//     that never persists ships none of it.
//   - A delay is waited out however long it is (llm:B2, llm:B3, apps:C24). setTimeout takes at most
//     2^31 − 1 ms (about 24.8 days) and fires a longer one at once, so a computed 30-day delay (a
//     token's lifetime, an uncapped backoff) is waited in parts of at most that (`__wait`). Not a
//     clamp to the limit, which would fire days early, nor a refusal: a StateError thrown at entry
//     would come out of the `send` (or the timer, or the task) that made the move, after it moved.
//     An infinite delay never fires; a negative one (a deadline already past) fires at once.

import type { Feature } from "../../index.ts";
import type { __Runner } from "../../internal.ts";
import { __wait } from "../../wait.ts";

export { __wait };

/**
 * Internal: the timers of `l`, for the general lifecycle. Each delay is resolved when the node is
 * entered (a name in `w`, milliseconds, or a function of the data), and its handler runs on the
 * leaf under the node then. Leaving the node cancels them. Nothing is saved: with persist in use,
 * the compiler lists ./saved.ts's runner instead, which saves their deadlines.
 */
export const __late: __Runner = {
  id: "l",
  start(m, { node, state, data }, ctx) {
    const timers = m.l?.[node]?.map(([delay, handler]) => {
      const d = typeof delay === "string" ? m.w?.[delay] : delay;
      return __wait(typeof d === "function" ? d(data, state) : (d ?? 0), () => {
        const now = ctx.current();
        ctx.go(handler(now.data, now.state));
      });
    });
    return timers ? { stop: () => timers.forEach((cancel) => cancel()) } : null;
  },
};

/** The delays opt-in: named delays and ISO durations in `after`. `setup({ use: [delays], delays: { ... } })`. */
export const delays: Delays = { r: __late };

/** The delays opt-in's type: an interface, so a type error names it `Delays`, not its hooks. */
export interface Delays extends Feature<"delays"> {
  /** Internal: the runner of the timers resolved at entry (`l`). */
  readonly r: __Runner;
}
