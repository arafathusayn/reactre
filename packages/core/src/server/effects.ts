// @reactre/core/server/effects: @reactre/core/features/effects in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode). An effect does not run on the
// server: `bind` computes its value, as `reaction` does there, and never applies it; `autorun`'s
// function and `onFlush`'s callback never run, as Solid 2.0's server has them.

import { memo } from "@reactre/core/server";

/**
 * `bind` from @reactre/core/features/effects, on the server: `compute` runs, in a memo as on the
 * client, and `apply` does not.
 */
export function bind<T>(
  compute: (prev: T | undefined) => T,
  _apply: (value: T, prev: T | undefined) => void | (() => void),
  _options?: { readonly defer?: boolean; readonly schedule?: boolean },
): void {
  let v: T | undefined;
  memo(() => (v = compute(v)));
}

/** `autorun` from @reactre/core/features/effects, on the server: `fn` never runs. */
export function autorun(_fn: () => void | (() => void)): void {}

/** `onFlush` from @reactre/core/features/effects, on the server: `fn` never runs. */
export function onFlush(_fn: () => void): void {}
