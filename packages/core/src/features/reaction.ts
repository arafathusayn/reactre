// @reactre/core/features/reaction: `reaction`, an effect split in two (MobX's `reaction`, Solid
// 2.0's `createEffect(compute, apply)`).
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and this is a runtime function.
//   - Built from the public API alone (a memo and an effect), so it brings ownership as `effect`
//     does, and nothing else.

import { effect, memo, onCleanup, untrack } from "@reactre/core";

/**
 * An effect split in two (MobX's `reaction`, Solid 2.0's `createEffect(compute, apply)`).
 * `compute` is tracked, and should only read. `apply(value, prev)` runs untracked after it, now
 * and whenever the value `compute` returns differs (!==) from the last one, with the last one as
 * `prev` (undefined the first time). A function `apply` returns is a cleanup: it runs before the
 * next `apply` and when the reaction is disposed with its owner, as do the effects `apply` made.
 *
 * `effect(fn)` is the same thing with both halves in one function. The split keeps what `apply`
 * reads (and writes) from becoming a dependency, and runs `apply` only on a change of value.
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
export function reaction<T>(compute: () => T, apply: (value: T, prev: T | undefined) => void | (() => void)): void {
  // A memo skips a value equal to the last, so the effect runs `apply` only on a change.
  const value = memo(compute);
  let prev: T | undefined;
  effect(() => {
    const v = value();
    untrack(() => {
      const c = apply(v, prev);
      prev = v;
      // The effect's cleanups run before its next run and when it is disposed.
      if (typeof c === "function") onCleanup(c);
    });
  });
}
