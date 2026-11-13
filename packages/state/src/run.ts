// @reactre/state/run (prototype): the general lifecycle. It starts and stops the runners (tasks and
// timers, children, a feature's) of each node an actor enters and exits, and runs a transition's
// effects after the move. The compiler puts it in `r` (`r: __run([__tasks, ...], dispatch?)`) for a
// machine with a hierarchy (`nested`), children, `persist` or effects. A flat machine with tasks or
// timers only gets the lean lifecycle instead (./tasks.ts's `__lean`), and a machine of plain
// transitions gets none.
//
// Design decisions:
//   - One path for flat and nested machines: a flat snapshot's active nodes are its leaf alone, so
//     the same diff (exit what's gone, update what stays, start what's new) is the flat route too,
//     with no hierarchy code. A machine with parents gets its nodes from `m.g` (nested).
//   - A node that stays (a move to the same leaf, or a parent over both leaves) keeps its runners:
//     they get `update` with the leaf under it now, only when that leaf changed.
//   - Effects run after the move, through the dispatcher the effects feature builds from the
//     registered runners (./internal.ts, "The effect registry"): this module only hands them over.
//   - A move that isn't a step (a timer's, a task's error, a child's `done`) is settled before it
//     reaches the actor by effects's wrap of this lifecycle (`effects.l(__run(...))`), so a machine
//     without effects pays nothing here.
//     The dispatcher sees every move (the start too: its entries), and keeps the actor's own work
//     (delayed events, effects to clean up) in `works` under `""`, which `stop` stops last.

import { __snap, __step } from "./index.ts";
import type {
  __Changes,
  __Compiled,
  __Dispatch,
  __Effect,
  __Event,
  __Leaf,
  __Lifecycle,
  __Live,
  __Node,
  __Runner,
  __Running,
  __Step,
  __Works,
} from "./internal.ts";

/**
 * Internal: the active nodes of a snapshot, outermost first: each parent of the leaf, then the
 * leaf (for a parallel node, each region's chain). A machine with parents or parallel nodes has
 * `m.g` (nested), which knows its nodes.
 */
export function __nodes(m: __Compiled, s: __Leaf): __Node[] {
  return m.g ? m.g.nodes(m, s) : [{ node: s.state, state: s.state, data: s.data }];
}

/**
 * Internal: what a move from `before` to `after` does to the active nodes. A node in both stays
 * (its runners get `update`, when the leaf under it changed); a move to the same leaf stays in it,
 * so its task, timers and children keep running. The rest exit (innermost first) and enter
 * (outermost first). One path for flat and nested machines: a flat machine's nodes are its leaf.
 */
export function __changes(m: __Compiled, before: __Leaf | null, after: __Leaf): __Changes {
  const was = before ? __nodes(m, before) : [];
  const now = __nodes(m, after);
  const old = (n: __Node) => was.find((x) => x.node === n.node);
  return {
    exit: was.filter((n) => !now.some((x) => x.node === n.node)).reverse(),
    enter: now.filter((n) => !old(n)),
    stay: now.filter((n) => {
      const o = old(n);
      return o && (o.state !== n.state || o.data !== n.data);
    }),
  };
}

/**
 * Internal: the general lifecycle of a machine's runners, for the compiled table's `r`. `dispatch`
 * runs each move's effects (`result.fx`) after it: only a machine with `effects` in use has it
 * (@reactre/state/effects's `__dispatcher`).
 */
export function __run(runners: readonly __Runner[], dispatch?: __Dispatch): __Lifecycle {
  return (m, move, current, options) => {
    const now = options?.now ?? Date.now;
    let saved = options?.run;
    const works: __Works = new Map();
    // Each active node, with the leaf under it now (outermost first, in the order entered). The
    // same diff as `__changes`, kept here in one map: it is also what `current` reads.
    const at = new Map<string, __Node>();
    const exit = (node: string): void => {
      for (const { work } of works.get(node) ?? []) work.stop();
      works.delete(node);
      at.delete(node);
    };
    // A delivery or a move from work that is still live: a node's work stops when the node exits.
    const deliver = (on: () => boolean) => (event: __Event) => (on() ? move(__step(m, current(), event, true)) : null);
    // wave1-effects: a move a runner (or the dispatcher) decided, from work that is still live.
    const go = (on: () => boolean) => (step: __Step) =>
      on() ? move({ ok: true, snapshot: __snap(m, step, current()) }) : null;
    const live: __Live = {
      works,
      m,
      enter(next, active, result) {
        const is = __nodes(m, next);
        // wave1-statecharts: a node the move re-entered (reenter's `re`) exits, to be entered again.
        for (const node of [...at.keys()].reverse())
          if (!is.some((n) => n.node === node) || m.re?.(next, node)) exit(node);
        for (const n of is) {
          const old = at.get(n.node);
          at.set(n.node, n);
          if (old) {
            if (old.state !== n.state || old.data !== n.data)
              for (const { work } of works.get(n.node) ?? []) work.update?.(n);
          } else if (active) {
            const list: { id: string; work: __Running }[] = [];
            const on = () => works.get(n.node) === list;
            works.set(n.node, list);
            for (const runner of runners) {
              const work = runner.start(m, n, {
                deliver: deliver(on),
                go: go(on),
                now,
                // The leaf under this node now: for a node in a parallel region, that region's leaf.
                current: () => at.get(n.node) ?? n,
                saved: saved?.[n.node]?.[runner.id],
                // wave1-actors: the actor's options, which children inherit (inspect, system).
                options,
              });
              if (work) list.push({ id: runner.id, work });
            }
          }
        }
        saved = undefined;
        if (dispatch && result.ok)
          dispatch(result.fx ?? [], {
            deliver: deliver(() => active),
            go: go(() => active),
            now,
            snapshot: next,
            live,
          });
      },
      stop() {
        // Every node's work, and the actor's own (`""`, effects').
        for (const node of [...works.keys()].reverse()) exit(node);
      },
    };
    return live;
  };
}
