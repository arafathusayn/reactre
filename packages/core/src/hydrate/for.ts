// @reactre/core/hydrate/for: @reactre/core/features/for in a hydrate build, where @reactre/compiler's
// hydrate mode imports the list from. While hydrating, the list renders between the pair of the
// page's markers at the cursor (the server writes its rows in one pair), and its first render's
// rows claim the nodes between them, in order: a row's content is made its nodes by the `__frag`
// that claims. From the first row that does not match the page, the rest are built afresh, and
// what the page has that no row claimed goes. Elsewhere it is features/for's own.
//
// A module of its own, as hydrate/async and hydrate/errors are, so that features/hydrate stays as
// it was, byte for byte, for an app whose lists are all the core's.

import { __each as each, type EachSpec } from "@reactre/core/features/for";
import { __claim, __close, __cursor, __frag, __seek } from "@reactre/core/features/hydrate";

/**
 * Internal (@reactre/compiler's hydrate mode): features/for's `__each`, which while hydrating
 * claims the page's pair of markers at the cursor and the rows between them.
 */
export function __each<T>(spec: EachSpec<T>): Node[] {
  const s = __cursor();
  if (s === null) return each(spec);
  // Where the page has no pair, it does not match: `__frag` throws that for a function child (any
  // function: it throws before it calls it), as it does for a slot that finds none.
  if (s.nodeType !== 8 || (s as Comment).data !== "[") __frag([each]);
  const e = __close(s);
  __seek(s.nextSibling);
  let on = true;
  const out = each(spec, [s, e], __frag, (fn) => {
    // After a row that did not match, the rest are built afresh.
    if (!on) return __claim(null, fn, "");
    let calls = 0,
      next: Node | null = null;
    // `__claim` runs `fn` again, afresh, where it does not match, and puts the cursor back: a
    // row that matched moves it past its nodes.
    const v = __claim(
      __cursor(),
      () => {
        const first = calls++ === 0,
          r = fn();
        if (first) next = __cursor();
        return r;
      },
      "a <For> row",
    );
    if (calls > 1) on = false;
    else __seek(next);
    return v;
  });
  __seek(e.nextSibling);
  return out;
}
