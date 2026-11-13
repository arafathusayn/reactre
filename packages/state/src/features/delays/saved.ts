// @reactre/state/delays/saved (prototype): the runner of the timers resolved at entry (`l`, delays's
// and timeout's) that saves their deadlines, for `persist`. The compiler lists it in place of the
// feature's own runner (`r: __run([__reactreStateLateSaved])`, an import of its own) only when persist
// is in use too, so an app that never persists ships none of the saving code.
//
// Each deadline is absolute (the actor's `now()` at entry plus the delay, null once it fired): a
// restored actor's timer fires with the time it had left, and a fired one doesn't fire again.

import type { __Runner } from "../../internal.ts";
import { __wait } from "../../wait.ts";

/** Internal: `l`'s timers, as ../delays's `__late` runs them, with `save` giving their deadlines. */
export const __lateSaved: __Runner = {
  id: "l",
  start(m, { node, state, data }, ctx) {
    const list = m.l?.[node];
    if (!list) return null;
    // What `save` below returned for this node (through JSON), on a restore.
    const saved = ctx.saved as readonly (number | null)[] | undefined;
    const pending: (number | null)[] = [];
    const timers = list.map(([delay, handler], i) => {
      const d = typeof delay === "string" ? m.w?.[delay] : delay;
      const was = saved?.[i];
      const at = (pending[i] =
        was === undefined ? ctx.now() + (typeof d === "function" ? d(data, state) : (d ?? 0)) : was);
      // However long it is: ../delays's `__wait` waits past setTimeout's limit in parts.
      return at === null
        ? undefined
        : __wait(at - ctx.now(), () => {
            pending[i] = null;
            const now = ctx.current();
            ctx.go(handler(now.data, now.state));
          });
    });
    return { stop: () => timers.forEach((cancel) => cancel?.()), save: () => [...pending] };
  },
};
