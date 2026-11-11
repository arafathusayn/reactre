// @reactre/state/children/saved (prototype): the children runner of a machine that also persists.
// The compiler puts it in the table in place of children's own runner (`r: __run([__reactreStateChildrenSaved])`,
// an import of its own) only when persist is in use: an app that never persists ships neither
// `restoreActor` for its children nor the save path (`__persisted` is in ../spawn's import too).

import { type __Actor, restoreActor } from "../../index.ts";
import type { __Child, __Options, __Persisted, __Runner } from "../../internal.ts";
import { __actorsOf } from "./index.ts";
import { __persisted } from "./persisted.ts";

// The overloads type a machine by its shape, which a compiled child's table doesn't carry.
// (`restoreActor` checks the saved child's version and state, so a stale one throws, not misleads.)
const restore = restoreActor as unknown as (m: __Child["m"], saved: __Persisted, options: __Options) => __Actor;

/** Internal: the children runner of a machine that persists: it restores and saves its children. */
export const __actorsSaved: __Runner = __actorsOf(restore, __persisted);
