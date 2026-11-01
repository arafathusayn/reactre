// @reactre/core/hydrate/async: @reactre/core/features/async in a hydrate build, where an app's
// imports of that module point (@reactre/compiler's hydrate mode). Everything is the module's own
// but `<Loading>`, which takes over what the server rendered of it:
//
//   - Its children, when the server rendered them: they are claimed, and shown at once. The
//     client computes its async memos again (but those with an `id`, below), and until a value
//     comes, what reads it keeps the server's nodes (a hole its text, a slot its content, which
//     it claims once the value has come): the runs that wait for a value do not count for the
//     boundary while it hydrates, so it never shows its fallback over the server's content, and
//     the page does not flash.
//   - Its fallback, when the server rendered that (`<!--rr:b-->`, `renderToString`): the client
//     builds the boundary afresh, which shows its own fallback until the children are ready.
//   - A boundary a stream has not sent yet (`<!--rr:bN-->`): the server's fallback stays, and the
//     boundary hydrates when the stream swaps its content in, as the swap script calls
//     `self.$rrh` (set here), so each boundary hydrates on its own.
//
// And `memo`, which takes what the server sent for it while the page hydrates (see `MemoOptions`):
// with an `id`, the value the server wrote under it, which is its first value, so it does not
// compute that one (`fn` runs once only to learn what it reads, with `fetch` sending nothing);
// with `ssrSource: "client"`, nothing, and it computes once the page has hydrated; with
// `transparent`, nothing either, and it computes as it would rendering afresh.
//
// Design decisions:
//   - An async memo gets the server's value only by an `id` the app gives it (see
//     plans/core-hydration.md): without one, the client reads the same data again, and the
//     boundary keeps the server's nodes meanwhile.
//   - Built on features/async's `<Loading>`, which builds its children off the page and puts them
//     in: hydrating, the nodes it puts in are the page's own, claimed.

import { __Owned, __owner, onCleanup, signal } from "@reactre/core";
import {
  __hooks,
  __LIVE,
  Loading as loading,
  memo as clientMemo,
  type MemoOptions,
  type Settled,
} from "@reactre/core/features/async";
import { __claim, __cursor, __open, __seek, isHydrating, takeHydrationValue } from "@reactre/core/features/hydrate";
import type { Child } from "@reactre/core/jsx-runtime";

export * from "@reactre/core/features/async";

/** A thenable that never settles: a memo that returns it has no value until it runs again. */
const NEVER = { then: () => undefined } as unknown as PromiseLike<never>;

/** A thenable of `r` that calls back at once, so a memo has the value in the same run. */
const now = <T>(r: T): Promise<T> => ({ then: (ok: (r: T) => unknown) => ok(r) }) as unknown as Promise<T>;

/**
 * `fn()`, run only to learn what it reads: `fetch` sends no request meanwhile (its Promise never
 * settles), and what it returns is dropped, a rejection or a throw included.
 */
function trace(fn: () => unknown): unknown {
  const g = globalThis as { fetch?: unknown };
  const f = g.fetch;
  g.fetch = () => new Promise(() => {});
  try {
    const r = fn();
    if (r !== null && typeof r === "object" && typeof (r as PromiseLike<unknown>).then === "function")
      (r as PromiseLike<unknown>).then(undefined, () => {});
    return r;
  } catch {
    return undefined;
  } finally {
    g.fetch = f;
  }
}

/** `it`'s values, after `first`; with `skip`, but its first, which `first` stands for. */
function after<T>(first: T, it: AsyncIterable<T>, skip: boolean): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const i = it[Symbol.asyncIterator]();
      let n = 0;
      return {
        next: () => {
          if (n++ === 0) return now({ value: first, done: false });
          if (n === 2 && skip) return i.next().then((r) => (r.done === true ? r : i.next()));
          return i.next();
        },
        return: () => i.return?.() ?? Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

/**
 * `memo` from @reactre/core/features/async in a hydrate build: while the page hydrates, its first
 * value is what the server sent under its `id` (see the module's comment and `MemoOptions`).
 * Elsewhere, and with no value sent, it is features/async's own.
 */
export function memo<R>(fn: () => R, options?: MemoOptions<Settled<R>>): () => Settled<R> {
  if (options === undefined || options.transparent === true || !isHydrating()) return clientMemo(fn, options);
  if (options.ssrSource === "client") {
    // The server never computed it: its first value is the client's, once the page has hydrated.
    const [go, setGo] = signal(false);
    queueMicrotask(() => setGo(true));
    return clientMemo(() => (go() ? fn() : NEVER) as R, options);
  }
  const got = options.id === undefined ? undefined : takeHydrationValue<Settled<R>>(options.id);
  if (got === undefined) return clientMemo(fn, options);
  let first = true;
  return clientMemo(() => {
    if (!first) return fn();
    first = false;
    const r = trace(fn);
    if (got.status === "rejected") return Promise.reject(got.error) as R;
    if (got.status === "pending") return got.promise as R;
    // An AsyncIterable goes on in the client from the server's value: a source of `from`, which
    // reconnects, or with "hybrid" any, whose first value is the one the server sent.
    if (r !== null && typeof r === "object" && Symbol.asyncIterator in r) {
      const live = __LIVE in r;
      if (live || options.ssrSource === "hybrid")
        return after(got.value, fn() as AsyncIterable<Settled<R>>, !live) as R;
    }
    // With a loadingValue, the server's markup showed that: the value comes after the hydration pass.
    return ("loadingValue" in options ? Promise.resolve(got.value) : got.value) as R;
  }, options);
}

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
