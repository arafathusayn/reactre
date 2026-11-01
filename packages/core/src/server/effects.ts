// @reactre/core/server/effects: @reactre/core/features/effects in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). As Solid 2.0's server has them:
// `bind` computes its value and applies it once, as its render effect does there, and never again;
// `autorun`'s function and `onFlush`'s callback never run.

import { memo, untrack } from "@reactre/core/server";

/**
 * `bind` from @reactre/core/features/effects, on the server: `compute` runs, in a memo as on the
 * client, and `apply` once, with the first value and `undefined` (with `defer`, never). A value
 * that is not ready yet is waited for: `apply` gets it once it comes. What `apply` returns is
 * not kept: nothing runs it on the server.
 */
export function bind<T>(
  compute: (prev: T | undefined) => T,
  apply: (value: T, prev: T | undefined) => void | (() => void),
  options?: { readonly defer?: boolean; readonly schedule?: boolean },
): void {
  let v: T | undefined,
    applied = options?.defer === true;
  memo(() => {
    const next = (v = compute(v));
    if (applied) return;
    applied = true;
    untrack(() => apply(next, undefined));
  });
}

/** `autorun` from @reactre/core/features/effects, on the server: `fn` never runs. */
export function autorun(_fn: () => void | (() => void)): void {}

/** `onFlush` from @reactre/core/features/effects, on the server: `fn` never runs. */
export function onFlush(_fn: () => void): void {}
