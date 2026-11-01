// @reactre/core/server/async: @reactre/core/features/async in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). Everything is the module's own
// but these:
//
//   - `<Loading>`, whose client version builds its children in a document fragment: here it is
//     @reactre/core/server's, which writes its children, or its fallback while they wait.
//   - `memo`, which does with its options what the server does (see `MemoOptions`): with an `id`,
//     in a render with `hydrate: true` that waits (`renderToStream`, `renderToStringAsync`), it
//     writes its first value for the hydrating client with the render's hydration writer; with
//     `deferStream`, a stream's shell waits for that value; with `ssrSource: "client"` it never
//     computes, and what reads it waits for good, so its `<Loading>` writes its fallback, which
//     the client replaces (or it reads as its `loadingValue`).
//   - `from`, which takes a subscription's first value and stops it there, as Solid 2.0's server
//     does: the client reconnects, and a source that never ends cannot hold the render open.
//   - `isPending`, false, as nothing is in flight in a server render; but a read of a value that
//     is not ready yet throws on, as Solid 2.0's server has it, so that what reads it waits for
//     the value (or its `<Loading>` writes its fallback), and the page shows the settled state.

import {
  __LIVE,
  __loading,
  from as clientFrom,
  type FromSource,
  memo as clientMemo,
  type MemoOptions,
  resolve,
  type Settled,
} from "@reactre/core/features/async";
import { __ssrClient, __ssrDefer, __ssrHydrating, getHydrationWriter } from "@reactre/core/server";

export * from "@reactre/core/features/async";
export { __ssrLoading as Loading } from "@reactre/core/server";

/** Whether `r` is what an async memo waits for: a Promise, or an AsyncIterable. */
const isAsync = (r: unknown): boolean =>
  r !== null &&
  (typeof r === "object" || typeof r === "function") &&
  (typeof (r as PromiseLike<unknown>).then === "function" || Symbol.asyncIterator in (r as object));

/**
 * `memo` from @reactre/core/features/async, on the server: computed as there, at once, and with
 * its options as the server has them (see the module's comment). A value that `fn` returns at
 * once, not a Promise or an AsyncIterable, is never written: the client computes it the same.
 */
export function memo<R>(fn: () => R, options?: MemoOptions<Settled<R>>): () => Settled<R> {
  if (options === undefined) return clientMemo(fn);
  const lv = "loadingValue" in options;
  if (options.ssrSource === "client") {
    if (lv) {
      const v = options.loadingValue as Settled<R>;
      return () => v;
    }
    // A memo that never has a value: what reads it waits for good, as the async runtime sees it.
    const never = clientMemo(() => new Promise<never>(() => {}));
    return () => {
      __ssrClient();
      return never();
    };
  }
  let first = true,
    async = false;
  const m = clientMemo(() => {
    const r = fn();
    if (first) {
      first = false;
      async = isAsync(r);
    }
    return r;
  });
  if (async) {
    const w = getHydrationWriter();
    const write = options.id !== undefined && w !== undefined && w.async && __ssrHydrating();
    if (write || options.deferStream === true) {
      const p = resolve(m);
      if (write) w.write(options.id!, p, { deferStream: options.deferStream === true });
      else __ssrDefer(p);
    }
  }
  return lv ? __loading(m, options.loadingValue as Settled<R>) : m;
}

/**
 * `isPending` from @reactre/core/features/async, on the server: `fn` runs, and the answer is
 * false. What it throws is thrown on, a read of a value that is not ready yet included.
 */
export function isPending(fn: () => unknown): boolean {
  fn();
  return false;
}

/**
 * `from` from @reactre/core/features/async, on the server: an AsyncIterable sends each value; a
 * subscription or an Observable its first, and is stopped there.
 */
export function from<T>(source: FromSource<T>): AsyncIterable<T> {
  const it = clientFrom(source);
  if (!(__LIVE in it)) return it;
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const i = it[Symbol.asyncIterator]();
      let n = 0;
      return {
        next: () => {
          if (n++ === 0) return i.next();
          void i.return!();
          return Promise.resolve({ value: undefined, done: true });
        },
        return: () => i.return!(),
      };
    },
  };
}
