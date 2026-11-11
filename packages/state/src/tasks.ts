// @reactre/state/tasks (prototype): runs a node's task and timers. Core: a machine with a task or a
// timer gets it with no opt-in, and a machine of plain transitions ships none of it.
//
// Two ways in, so a flat machine pays for no hierarchy:
//   - `__lean`, the whole lifecycle of a flat machine with tasks or timers only (`r: __lean`): one
//     active leaf, its work started on entry and stopped on exit. No node diff, no `update`.
//   - `__tasks`, a runner for the general lifecycle (`r: __run([__tasks, ...])`, ./run.ts), for a
//     machine with a hierarchy, children, `persist` or effects.
//
// Design decisions:
//   - Leaving the node aborts the task's signal and clears its timers, and a result that arrives
//     after that is dropped: the stale-response race can't happen.
//   - Durations are milliseconds already: the compiler parsed "10s".
//   - Timers here are relative (`setTimeout(ms)`) and nothing is saved. Deadlines that survive a
//     restore are the `persist` feature's runner (./features/persist), so an app that never
//     persists ships none of that.
//   - A task's event that its schema refuses goes to the task's `error`, as the StateError S6 that
//     the validate feature's step puts on the refusal.
//   - A move to the same leaf stays: its task and timers keep running, as in the general lifecycle.

import { __snap, __step } from "./index.ts";
import type { __Compiled, __Event, __Leaf, __Lifecycle, __Result, __Runner, __Step } from "./internal.ts";
import { __wait } from "./wait.ts";

/** A single timer: calls `fire` after `ms`, and the returned cancel clears it. */
type Timer = (ms: number, fire: () => void) => () => void;

/**
 * Internal: the plain timer, for a machine whose every ordinary `after` the compiler read as a
 * literal millisecond count within `setTimeout`'s range. It is `setTimeout` itself, so such a
 * machine ships none of `__wait`'s split. The compiler picks it only from the emitted `a` table's
 * own numbers (compiler/index.ts): a delay it can't read (persist's restored deadlines, delays's
 * and timeout's computed ones) keeps `__wait`, whose parts are what makes those safe.
 */
const quick: Timer = (ms, fire) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

/**
 * Starts the task and timers of node `node` (entered at leaf `state` with `data`), or returns
 * undefined when it has none. Its result and its failure reach `deliver` and `go` only until the
 * returned stop runs (the signal it aborts is the liveness check); `now` is the leaf under the node
 * when a handler runs.
 */
function begin(
  m: __Compiled,
  node: string,
  state: string,
  data: __Leaf["data"],
  deliver: (event: __Event) => __Result | null,
  go: (step: __Step) => unknown,
  now: () => __Leaf,
  wait: Timer,
): (() => void) | undefined {
  const task = m.t?.[node];
  const after = m.a?.[node];
  if (!task && !after) return undefined;
  const controller = new AbortController();
  const { signal } = controller;
  if (task) {
    const fail = (error: unknown): void => {
      const at = now();
      if (!signal.aborted) go(task[1](at.data, error, at.state));
    };
    task[0](data, signal, state).then((event) => {
      const r = signal.aborted ? null : deliver(event);
      if (r?.ok === false && r.error) fail(r.error);
    }, fail);
  }
  // `wait`, not setTimeout: a delay past 2^31 − 1 ms (about 24.8 days) fires at once with
  // setTimeout, and a NaN one fires at once too (an accidental retry). `quick` when the compiler
  // read every ordinary `after` as a literal within range, so the split has nothing to do.
  const timers = after?.map(([ms, handler]) =>
    wait(ms, () => {
      const at = now();
      go(handler(at.data, at.state));
    }),
  );
  return () => {
    controller.abort();
    for (const cancel of timers ?? []) cancel();
  };
}

/** Internal: the runner of tasks and timers, for the general lifecycle (`__run([__tasks])`). */
export const __tasks: __Runner = {
  id: "t",
  start(m, { node, state, data }, ctx) {
    const stop = begin(m, node, state, data, ctx.deliver, ctx.go, ctx.current, __wait);
    return stop ? { stop } : null;
  },
};

/** Internal: `__tasks` with the plain timer, for a machine whose ordinary delays are short. */
export const __tasksQuick: __Runner = {
  id: "t",
  start(m, { node, state, data }, ctx) {
    const stop = begin(m, node, state, data, ctx.deliver, ctx.go, ctx.current, quick);
    return stop ? { stop } : null;
  },
};

/**
 * The lean lifecycle over a timer. Its own code, not `begin`'s: in a flat machine the node is the
 * leaf, whose name a stay keeps, so a handler's state is the node's; and it is the smallest code
 * that runs a task and timers.
 */
const lean =
  (wait: Timer): __Lifecycle =>
  (m, move, current) => {
    let at: string | undefined;
    let stop: (() => void) | undefined;
    return {
      enter({ state, data }, active) {
        // The same leaf stays. Otherwise the last leaf's work stops (idempotent: a later entry with no
        // work runs it again), and an active actor starts this one's.
        if (state !== at && ((at = state), stop?.(), active)) {
          const task = m.t?.[state];
          const controller = new AbortController();
          const signal = controller.signal;
          // A step from a handler, while the node is active: a result after it exited is dropped.
          const go = (step: __Step): unknown => signal.aborted || move({ ok: true, snapshot: __snap(m, step) });
          const fail = (error: unknown): unknown => go(task![1](current().data, error, state));
          task?.[0](data, signal, state).then((event) => {
            if (!signal.aborted) {
              // A result's error: an event its schema refused (validate in use), for the task's handler.
              // fixups: a block, not a conditional expression: fewer bytes.
              const r: { readonly ok: boolean; readonly error?: unknown } = move(__step(m, current(), event, true));
              if (r.error) fail(r.error);
            }
          }, fail);
          // `wait`, not setTimeout: a delay past 2^31 − 1 ms fires at once with setTimeout.
          const timers = m.a?.[state]?.map(([ms, handler]) => wait(ms, () => go(handler(current().data, state))));
          stop = () => {
            controller.abort();
            timers?.forEach((cancel) => cancel());
          };
        }
      },
      stop: () => stop?.(),
    };
  };

/**
 * Internal: the lifecycle of a flat machine whose only runners are tasks and timers (`r: __lean`).
 */
export const __lean: __Lifecycle = /* @__PURE__ */ lean(__wait);

/** Internal: `__lean` with the plain timer, for a machine whose ordinary delays the compiler read. */
export const __leanQuick: __Lifecycle = (m, move, current) => {
  let at: string | undefined;
  let stop: (() => void) | undefined;
  return {
    enter({ state, data }, active) {
      if (state !== at && ((at = state), stop?.(), active)) {
        const task = m.t?.[state];
        const controller = new AbortController();
        const signal = controller.signal;
        const go = (step: __Step): unknown => signal.aborted || move({ ok: true, snapshot: __snap(m, step) });
        const fail = (error: unknown): unknown => go(task![1](current().data, error, state));
        task?.[0](data, signal, state).then((event) => {
          if (!signal.aborted) {
            const r: { readonly ok: boolean; readonly error?: unknown } = move(__step(m, current(), event, true));
            r.error && fail(r.error);
          }
        }, fail);
        const timers = m.a?.[state]?.map(([ms, handler]) => setTimeout(() => go(handler(current().data, state)), ms));
        stop = () => {
          controller.abort();
          timers?.forEach(clearTimeout);
        };
      }
    },
    stop: () => stop?.(),
  };
};
