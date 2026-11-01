// @reactre/core/hydrate/errors: @reactre/core/features/errors in a hydrate build, where an app's
// imports of that module point (@reactre/compiler's hydrate mode). Everything is the module's own
// but `<Errored>`: where the server showed its fallback (@reactre/core/server/errors writes a
// marker with the error before it), hydration shows the fallback too, claiming the server's
// nodes, with an error of that name and message; `reset` builds the children afresh. Elsewhere
// it is features/errors' own.

import { Errored as errored, type ErroredFallback } from "@reactre/core/features/errors";
import { __claim, __close, __cursor } from "@reactre/core/features/hydrate";
import type { Child } from "@reactre/core/jsx-runtime";

export * from "@reactre/core/features/errors";

/** The marker the server writes before a fallback it showed: the error's name and message. */
const MARK = /^rr:e:([^:]*):(.*)$/;

/**
 * `<Errored>` in a hydrate build. Hydrating where the server showed the fallback, its first build
 * of the children throws the server's error, so the boundary shows its fallback, which claims
 * the server's: they are kept apart, and an empty pair of markers stands for the children.
 */
export function Errored(props: { fallback: ErroredFallback; children?: Child | (() => Child) }): unknown {
  const c = __cursor(),
    marker = c !== null && c.nodeType === 8 && (c as Comment).data === "[" ? c.nextSibling : null,
    m = marker !== null && marker.nodeType === 8 ? MARK.exec((marker as Comment).data) : null;
  if (m === null) return errored(props);
  const err = new Error(decodeURIComponent(m[2]!));
  err.name = decodeURIComponent(m[1]!);
  // The server's fallback, out of the boundary's pair until the fallback claims it.
  const p = marker!.parentNode!,
    end = __close(c!),
    held = document.createDocumentFragment();
  while (marker!.nextSibling !== end) held.appendChild(marker!.nextSibling!);
  p.insertBefore(document.createComment("["), end);
  p.insertBefore(document.createComment("]"), end);
  p.removeChild(marker!);
  let thrown = false,
    claimed = false;
  return errored({
    get children() {
      if (thrown) return props.children;
      thrown = true;
      throw err;
    },
    fallback: (e: unknown, reset: () => void) => {
      const f = props.fallback;
      const make = (): Child => (typeof f === "function" ? f(e, reset) : f);
      if (claimed) return make();
      claimed = true;
      return __claim(held.firstChild, make, "an <Errored>'s fallback");
    },
  });
}
