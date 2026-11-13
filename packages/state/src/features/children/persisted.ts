// @reactre/state/children/persisted (prototype): a child's snapshot with what its own runners
// saved. Its own module, with no `restoreActor`: spawn's save reads it, and an app that spawns
// without persisting ships this and not the restore path (./saved.ts).

import type { __Actor } from "../../index.ts";
import type { __Persisted } from "../../internal.ts";

/** Internal: a child's snapshot with what its own runners saved (its timers, its children); spawn's too. */
export function __persisted(a: __Actor): __Persisted {
  const run: { [node: string]: { [runner: string]: unknown } } = {};
  for (const [node, list] of a["~r"]?.works ?? [])
    for (const { id, work } of list) {
      const part = work.save?.();
      if (part !== undefined) (run[node] ??= {})[id] = part;
    }
  return { ...a.snapshot(), run };
}
