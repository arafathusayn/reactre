// @reactre/core/features/reaction: `reaction`, an effect split in two (MobX's `reaction`, Solid
// 2.0's `createEffect(compute, apply)`).
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and this is a runtime function.
//   - Built from the public API (a memo and an effect), so it brings ownership as `effect` does,
//     and nothing else; and `__owner`, the run under way, through which the effect takes the
//     async runtime's live mark from the memo (see `reaction`).

import { __owner, effect, memo, onCleanup, untrack } from "@reactre/core";

/** A run (an effect's, a memo's) as the async runtime sees it: `lv` when no transition holds it. */
type Live = { lv?: boolean };
// #if TYPES

/** Options of `reaction`. */
export interface ReactionOptions {
  /**
   * Where the reaction runs in a server build (@reactre/core/server/reaction): `"server"` (the
   * default) and `"hybrid"`, `compute` runs there, as `apply` never does; `"client"`, neither
   * runs there. In the browser, the reaction runs as it does without it.
   */
  readonly ssrSource?: "server" | "hybrid" | "client";
}
// #endif

/**
 * An effect split in two (MobX's `reaction`, Solid 2.0's `createEffect(compute, apply)`).
 * `compute` is tracked, and should only read. `apply(value, prev)` runs untracked after it, now
 * and whenever the value `compute` returns differs (!==) from the last one, with the last one as
 * `prev` (undefined the first time). A function `apply` returns is a cleanup: it runs before the
 * next `apply` and when the reaction is disposed with its owner, as do the effects `apply` made.
 *
 * `effect(fn)` is the same thing with both halves in one function. The split keeps what `apply`
 * reads (and writes) from becoming a dependency, and runs `apply` only on a change of value.
 * Once `compute` reads through `latest` or `isPending` (@reactre/core/features/async), no
 * transition holds `apply`, as none holds an effect that reads through them. `options` matter
 * only in a server build (see `ReactionOptions`).
 *
 * @example
 *   import { reaction } from "@reactre/core/features/reaction";
 *
 *   const [id, setId] = signal(1);
 *   reaction(
 *     () => id(),
 *     (id, prev) => {
 *       console.log("from", prev, "to", id);
 *       const t = setInterval(() => poll(id), 1000);
 *       return () => clearInterval(t);
 *     },
 *   ); // logs "from undefined to 1"
 *   setId(2); // clears the first interval, logs "from 1 to 2"
 */
// #if TYPES
export function reaction<T>(
  compute: () => T,
  apply: (value: T, prev: T | undefined) => void | (() => void),
  _options?: ReactionOptions,
): void {
  // #else
  // export function reaction<T>(compute: () => T, apply: (value: T, prev: T | undefined) => void | (() => void)): void {
  // #endif
  // The memo's run and the effect's, as the async runtime marks them: `lv`, once `latest` or
  // `isPending` (features/async) was read in it, so that no transition holds it. `compute` runs
  // in the memo, which is never held, so the effect that runs `apply` takes the mark from it.
  // `fx` is a stand-in until the effect has run. Without the async runtime, nothing is marked.
  let m: Live,
    fx: Live = {};
  // A memo skips a value equal to the last, so the effect runs `apply` only on a change.
  const value = memo(() => {
    m = __owner as Live;
    try {
      return compute();
    } finally {
      // Live from this run on: the effect, queued behind the memos, is not held when its turn comes.
      if (m.lv) fx.lv = true;
    }
  });
  let prev: T | undefined;
  effect(() => {
    fx = __owner as Live;
    if (m.lv) fx.lv = true;
    const v = value();
    untrack(() => {
      const c = apply(v, prev);
      // #if DEV
      if (c !== undefined && typeof c !== "function")
        throw new TypeError(
          `reactre INVALID_CLEANUP: a reaction's apply returned ${c === null ? "null" : typeof c}, not a cleanup function or undefined. Fix: return a function to run before the next apply and when the owner goes, or nothing.`,
        );
      // #endif
      prev = v;
      // The effect's cleanups run before its next run and when it is disposed.
      if (typeof c === "function") onCleanup(c);
    });
  });
}
