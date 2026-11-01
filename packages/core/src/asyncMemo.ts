// @reactre/core/features/async's `memo`, with Solid 2.0's options for async memos (`MemoOptions`).
//
// Design decisions:
//   - In the browser, rendering afresh, only `loadingValue` changes what a memo does: the others
//     are for the server (@reactre/core/server/async's `memo`) and for a hydrating client
//     (@reactre/core/hydrate/async's), which the compiler's server and hydrate modes point an
//     app's imports at.
//   - A file of its own, as ./observed.ts is for features/memo: features/async re-exports it, and
//     @reactre/compiler sends a call that passes no option to features/async's `__memo`, the
//     core's memo as the module exported it before there were options. So an app that passes none
//     leaves this file out of its bundle whole: Bun's minifier names a bundle's symbols by how
//     often its modules use them, dead code included, so the same code in features/async.ts would
//     move the names of every async app's bundle. A call the compiler does not see (in a .ts
//     file, a dependency) reaches `memo` here, which takes the options it passes.

import * as core from "@reactre/core";

import type { Settled } from "./features/async.ts";

/** The options of an async memo (Solid 2.0's `MemoOptions` for async data). */
export interface MemoOptions<T> {
  /**
   * The value the memo has from the start, until its first value comes: a read of it is ready,
   * so no `<Loading>` shows its fallback for it, and `isPending` is false. After that it is a
   * memo like any other: a change keeps the last value until the new one comes. On the server it
   * is what the HTML shows.
   */
  readonly loadingValue?: T;
  /**
   * The key the server writes the memo's value under for the client (with the render's hydration
   * writer), and the client takes it by while it hydrates: with one, a hydrating client takes the
   * server's value instead of computing it (see `ssrSource`). Unique on the page.
   */
  readonly id?: string;
  /**
   * Where the hydrating client's first value comes from. `"server"` (the default): the server's,
   * written under `id` (without an id, nothing is sent, and the client computes); the client runs
   * `fn` once, with `fetch` sending no request, only to learn what it reads, and computes when
   * that changes. A source of `from` reconnects, from the server's value. `"hybrid"`: the same,
   * but an AsyncIterable `fn` returns goes on in the client, from the server's value (its first,
   * which the server sent, is dropped). `"client"`: the server never computes it, and what reads
   * it waits (its `<Loading>` writes its fallback, which the client replaces), or with a
   * `loadingValue`, the server shows that; the client computes once the page has hydrated.
   */
  readonly ssrSource?: "server" | "hybrid" | "client";
  /** On the server, `renderToStream` sends its shell once the memo has its first value, not a `<Loading>`'s fallback. */
  readonly deferStream?: boolean;
  /** Hydrating, the memo computes, taking no value from the server: for a memo the server does not make. */
  readonly transparent?: boolean;
}

/**
 * `memo` from @reactre/core, typed for an async function: `memo(async () => ...)` reads as the
 * value it resolves to. A read before it has one is not ready (see `<Loading>`). Its options (see
 * `MemoOptions`) give it a value while the first one loads (`loadingValue`), and say what the
 * server does with it and what a hydrating client takes from the server (`id`, `ssrSource`,
 * `deferStream`, `transparent`): in the browser, rendering afresh, only `loadingValue` changes
 * anything.
 *
 * @example
 *   import { memo } from "@reactre/core/features/async";
 *
 *   const user = memo(async () => (await fetch(`/users/${id()}`)).json());
 *   const posts = memo(() => fetchPosts(id()), { loadingValue: [] });
 */
export function memo<R>(fn: () => R, options?: MemoOptions<Settled<R>>): () => Settled<R> {
  const m = core.memo(fn) as () => Settled<R>;
  return options !== undefined && "loadingValue" in options ? __loading(m, options.loadingValue as Settled<R>) : m;
}

/**
 * Internal (@reactre/core/server/async, /hydrate/async): memo `m`'s read, which reads as `v`
 * until `m` has its first value: no read of it waits, and `isPending` is false.
 */
export function __loading<T>(m: () => T, v: T): () => T {
  const read = (): T => {
    try {
      return m();
    } catch (e) {
      // Only a memo with no value yet is not ready: once it has one, it keeps one.
      if (e instanceof core.__NotReadyError) return v;
      throw e;
    }
  };
  core.__refreshers.set(read, core.__refreshers.get(m)!);
  return read;
}
