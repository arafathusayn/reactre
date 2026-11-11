// @reactre/state/spawn/restore (prototype): restoring a persisted actor's spawned children. The
// compiler wraps the lifecycle with it in place of spawn's own wrap (`r: __reactreStateSpawnRestore(inner)`,
// an import of its own) only when persist is in use too: an app that never persists ships no
// `restoreActor` for spawn. A restored child gets its saved snapshot and subscriptions back, and the
// options a spawned child inherits (../spawn's `__inherited`).

import { type __Actor, __step, restoreActor } from "../../index.ts";
import type { __Compiled, __Lifecycle, __Options, __Persisted } from "../../internal.ts";
import { __inherited, __inheriting, __listen, __of, __start, type Saved } from "./index.ts";

// The overloads type a machine by its shape, which a compiled child's table doesn't carry.
const restore = restoreActor as unknown as (m: __Compiled, saved: __Persisted, options: __Options) => __Actor;

/** Internal: spawn's lifecycle wrap, which also restores the spawned children `persist` saved. */
export function __restoring(inner: __Lifecycle): __Lifecycle {
  const keeping = __inheriting(inner);
  return (m, move, current, options) => {
    const live = keeping(m, move, current, options);
    const saved = options?.run?.[""]?.["s"] as readonly Saved[] | undefined;
    if (saved) {
      const s = __of(live, (event) => move(__step(m, current(), event, true)));
      for (const k of saved) {
        const kid = __start(s, m, k.name, k.key, (cm) =>
          restore(cm, k.snapshot, __inherited(live, k.name, k.key, undefined)),
        );
        kid.subs = k.subs;
        for (const l of k.listens) {
          kid.listens.push(l);
          __listen(s, kid, l);
        }
      }
    }
    return live;
  };
}
