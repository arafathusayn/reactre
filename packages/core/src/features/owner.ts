// @reactre/core/features/owner: Solid 2.0's owner APIs, `createRoot`, `getOwner` and
// `runWithOwner`.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and these are runtime functions.
//   - `getOwner` and `runWithOwner` read and set the core's owner variable (`__owner`,
//     `__swapOwner`) and bring no part of ownership: owners exist only where something made one,
//     which brought ownership already. `createRoot` makes one, so it brings ownership (`__Owned`),
//     as `attach` does, and the holes rendered in it are owned too.

import { __Owned, __owner, __Root, __swapOwner, untrack } from "@reactre/core";

declare const opaque: unique symbol;

/** An owner, as `getOwner` returns it: opaque, to pass to `runWithOwner`. */
export type Owner = { readonly [opaque]: true };

/**
 * The current owner: the effect whose run is making things, the row or `attach` or `createRoot`
 * root whose content is being built, or null outside any (at module scope, in a view given to
 * `render`, under `runWithOwner(null, ...)`). Keep it to make things later that belong to it,
 * with `runWithOwner`. Reads only a variable, so it brings no part of ownership with it.
 *
 * @example
 *   import { getOwner, runWithOwner } from "@reactre/core/features/owner";
 *
 *   function Widget() {
 *     const o = getOwner();
 *     setTimeout(() => runWithOwner(o, () => onCleanup(() => console.log("gone"))), 100);
 *     return <p />;
 *   }
 */
export function getOwner(): Owner | null {
  return __owner as unknown as Owner | null;
}

/**
 * Run `fn` with `o` as the owner and nothing tracking its reads, and return its result: the
 * effects and cleanups it makes belong to `o`, and go when `o` is disposed or re-runs. With null
 * they belong to nothing: they live until disposed by hand (a `createRoot`'s `dispose`).
 *
 * @example
 *   import { getOwner, runWithOwner } from "@reactre/core/features/owner";
 *
 *   const o = getOwner();
 *   fetch(url).then((r) => runWithOwner(o, () => effect(() => console.log(r.status, n()))));
 */
export function runWithOwner<T>(o: Owner | null, fn: () => T): T {
  const p = __swapOwner(o as unknown as typeof __owner);
  try {
    return untrack(fn);
  } finally {
    __swapOwner(p);
  }
}

/**
 * Run `fn` under a new root owner and return its result. `fn` gets the root's `dispose`, which
 * stops the effects and runs the cleanups `fn` made, deepest first; calling it again does
 * nothing. Reads in `fn` are not tracked.
 *
 * As in Solid 2.0, a root made inside an owner belongs to it, and goes when the owner is disposed
 * or re-runs (an effect's run, a row, an `attach`, another root), or earlier by `dispose`. For a
 * root that outlives its owner, make it under `runWithOwner(null, ...)`. A root made outside any
 * owner lives until `dispose`.
 *
 * @example
 *   import { createRoot } from "@reactre/core/features/owner";
 *
 *   const [n, setN] = signal(0);
 *   const stop = createRoot((dispose) => {
 *     effect(() => console.log(n()));
 *     return dispose;
 *   }); // logs 0
 *   setN(1); // logs 1
 *   stop();
 *   setN(2); // logs nothing
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const r = new __Root(),
    p = __owner;
  if (p !== null) (p.owned ??= []).push(r);
  return __Owned.within(r, () =>
    fn(() => {
      r.dispose();
      // Out of the owner's list, so that an owner that lives long does not keep every root
      // disposed under it. Gone already when the owner itself cleaned.
      const ps = p === null ? null : p.owned,
        i = ps === null ? -1 : ps.indexOf(r);
      if (i >= 0) ps!.splice(i, 1);
    }),
  );
}
