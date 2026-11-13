// @reactre/state/run-nested (internal): the general lifecycle for a machine whose only reason for
// one is its hierarchy (`nested`): no children, effects, persist, inspect or spawn. The
// compiler picks it (`r: __runNested([...runners])`) for exactly that machine, so an app with
// parents and tasks or timers ships none of the general lifecycle's other paths.
//
// It is ./run.ts's lifecycle minus what such a machine cannot use:
//   - no `dispatch`: nothing records effects, so no move has `fx` to run;
//   - no `saved`/`options.run`: nothing persists a node's work, so no runner reads `saved`;
//   - no `options` in a runner's context: no runner of such a machine reads it (children and
//     inspect do, and neither is in use);
//   - no `m` on `__Live`: only `persist` reads it, and it is not in use.
// It keeps the `m.re` check (reenter's): a machine that uses reenter has no hierarchy, so this is
// the lifecycle it gets, and the check is a property read on a table without `re`.
// What it keeps is what the hierarchy needs: the node diff (exit, enter, stay), `update` on a node
// that stays while the leaf under it changed, `deliver`/`go` that drop once their node exits,
// `current()`, `stop`, and the actor's clock (`options.now`, so a test's clock and `delays` work).

import { __snap, __step } from "./index.ts";
import type {
  __Compiled,
  __Event,
  __Leaf,
  __Lifecycle,
  __Live,
  __Node,
  __Runner,
  __Running,
  __Step,
} from "./internal.ts";

/** The active nodes of a snapshot, outermost first: `m.g`'s (nested), or the leaf alone. */
const nodes = (m: __Compiled, s: __Leaf): __Node[] =>
  m.g?.nodes(m, s) ?? [{ node: s.state, state: s.state, data: s.data }];

/**
 * Internal: the lifecycle of a machine with a hierarchy and nothing else, for the compiled table's
 * `r`. `runners` are the machine's (its tasks and timers), as `__run` takes them.
 */
export function __runNested(runners: readonly __Runner[]): __Lifecycle {
  return (m, move, current, options) => {
    const now = options?.now ?? Date.now;
    // Each active node, with the leaf under it now (outermost first, in the order entered) and its
    // runners' work: one map, so a node's exit drops both.
    const at = new Map<string, { node: __Node; list: __Running[] }>();
    const exit = (node: string): void => {
      at.get(node)?.list.forEach((work) => work.stop());
      at.delete(node);
    };
    const live: __Live = {
      enter(next, active) {
        const is = nodes(m, next);
        // A node the move re-entered (reenter's `re`) exits, to be entered again.
        for (const node of [...at.keys()].reverse())
          if (!is.some((n) => n.node === node) || m.re?.(next, node)) exit(node);
        for (const n of is) {
          const old = at.get(n.node);
          if (old) {
            if (old.node.state !== n.state || old.node.data !== n.data) for (const work of old.list) work.update?.(n);
            old.node = n;
          } else if (active) {
            const list: __Running[] = [];
            const entry = { node: n, list };
            const on = () => at.get(n.node) === entry;
            at.set(n.node, entry);
            for (const runner of runners) {
              const work = runner.start(m, n, {
                // A delivery or a move from work that is still live: a node's work stops when the
                // node exits.
                deliver: (event) => (on() ? move(__step(m, current(), event, true)) : null),
                go: (step) => on() && move({ ok: true, snapshot: __snap(m, step, current()) }),
                now,
                // The leaf under this node now: for a node in a parallel region, that region's leaf.
                current: () => entry.node,
                saved: undefined,
              });
              work && list.push(work);
            }
          }
        }
      },
      stop() {
        for (const node of [...at.keys()].reverse()) exit(node);
      },
    };
    return live;
  };
}
