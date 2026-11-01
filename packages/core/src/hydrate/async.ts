// @reactre/core/hydrate/async: @reactre/core/features/async in a hydrate build, where an app's
// imports of that module point (@reactre/compiler's hydrate mode). Everything is the module's own
// but `<Loading>`, which takes over what the server rendered of it:
//
//   - Its children, when the server rendered them: they are claimed, and shown at once. The
//     client computes its async memos again, and until a value comes, what reads it keeps the
//     server's nodes (a hole its text, a slot its content, which it claims once the value has
//     come): the runs that wait for a value do not count for the boundary while it hydrates, so
//     it never shows its fallback over the server's content, and the page does not flash.
//   - Its fallback, when the server rendered that (`<!--rr:b-->`, `renderToString`): the client
//     builds the boundary afresh, which shows its own fallback until the children are ready.
//   - A boundary a stream has not sent yet (`<!--rr:bN-->`): the server's fallback stays, and the
//     boundary hydrates when the stream swaps its content in, as the swap script calls
//     `self.$rrh` (set here), so each boundary hydrates on its own.
//
// Design decisions:
//   - No data goes from the server to the client: the client reads the same data again (see
//     plans/core-hydration.md), and the boundary keeps the server's nodes meanwhile.
//   - Built on features/async's `<Loading>`, which builds its children off the page and puts them
//     in: hydrating, the nodes it puts in are the page's own, claimed.

import { __Owned, __owner, onCleanup } from "@reactre/core";
import { __hooks, Loading as loading } from "@reactre/core/features/async";
import { __claim, __cursor, __open, __seek } from "@reactre/core/features/hydrate";
import type { Child } from "@reactre/core/jsx-runtime";

export * from "@reactre/core/features/async";

/** Whether the runs that wait for a value count for their boundary: not while one hydrates. */
let quiet = false;
const wait = __hooks.wait;
__hooks.wait = (o, list) => (quiet ? true : wait(o, list));

/** `<Loading>`'s props. */
type Props = { fallback?: Child; on?: unknown; children?: Child | (() => Child) };

/** `<Loading>` with `props`, its waits counted (`count`) or not. */
function build(props: Props, count: boolean): unknown {
  const q = quiet;
  quiet = !count;
  try {
    return loading(props);
  } finally {
    quiet = q;
  }
}

/** The boundaries a stream has yet to send, by id: what hydrates each once it is swapped in. */
const streamed = new Map<string, () => void>();
(globalThis as { $rrh?: (id: number) => void }).$rrh = (id) => streamed.get("" + id)?.();

/** The server's marker of a boundary that showed its fallback: `rr:b`, or `rr:bN` in a stream. */
const BOUNDARY = /^rr:b(\d*)$/;

/**
 * `<Loading>` in a hydrate build: features/async's own, taking over what the server rendered (see
 * the module's comment).
 */
export function Loading(props: Props): unknown {
  const c = __cursor();
  const m = c !== null && c.nodeType === 8 ? BOUNDARY.exec((c as Comment).data) : null;
  if (c === null) return loading(props);
  if (m === null) return build(props, false);
  // The server showed the fallback, between this marker and its closing one.
  let end = c.nextSibling!;
  while (end.nodeType !== 8 || (end as Comment).data !== "/" + (c as Comment).data) end = end.nextSibling!;
  __seek(end.nextSibling);
  if (m[1] === "") return __claim(null, () => build(props, true), "");
  // Still streaming: the server's nodes stay, before an anchor of the boundary's own.
  const id = m[1]!,
    own = __owner,
    anchor = document.createTextNode(""),
    nodes: Node[] = [];
  for (let n: Node = c; ; n = n.nextSibling!) {
    nodes.push(n);
    if (n === end) break;
  }
  nodes.push(anchor);
  // Gone before its content comes, the boundary is not hydrated.
  onCleanup(() => streamed.delete(id));
  streamed.set(id, () => {
    streamed.delete(id);
    // The swap put the content, a slot's pair, where the fallback was: just before the anchor.
    const p = anchor.parentNode!,
      sent: Node[] = [];
    for (let n = __open(anchor.previousSibling!); n !== anchor; n = n.nextSibling!) sent.push(n);
    const got = __claim(sent[0]!, () => __Owned.within(own, () => build(props, false)), "a <Loading>") as Node[];
    for (const n of got) p.insertBefore(n, anchor);
    // What the swap put in and the boundary did not claim (all of it, after a mismatch) goes.
    for (const n of sent) if (!got.includes(n) && n.parentNode === p) p.removeChild(n);
  });
  return nodes;
}
