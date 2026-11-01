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
// #if DEV

// Where Solid 2.0 lets an owner make nothing (its development build throws): an `autorun`'s
// function (features/effects), and an `onSettled` callback that has an owner (features/timing).
// What such a run made would belong to an owner that does not know of it: an autorun's effect
// is run again with what it read, and a settled owner's content may long outlive the callback.
// `__ban` locks the owner while the run is under way: its two lists, of what it owns and of its
// cleanups, get a `push` of their own that throws, so an effect, a memo, a root or a slot made
// there (each puts itself in the first) and `onCleanup` (the second) throw, naming the fix; and
// the core's code is as it was. The production build drops all of this.

/** An owner of the core's. */
type Core = NonNullable<typeof __owner>;

/** A `push` for an owner's list that throws `code`'s error: what went wrong there, and the fix. */
const refuse = (code: string, what: string, fix: string) => (): never => {
  throw new Error(
    `reactre ${code}: ${what} in an autorun's function or in an onSettled callback that has an owner, where Solid 2.0 lets nothing be made. Fix: ${fix}.`,
  );
};
/** The error for `what`, made where nothing may be. */
const made = (what: string): (() => never) =>
  refuse(
    "PRIMITIVE_IN_FORBIDDEN_SCOPE",
    `${what} was made`,
    "make it outside the callback, in the component's body or in an effect",
  );
const NO_PRIMITIVE = made("an effect, a memo, a root or a slot");
const NO_CLEANUP = refuse(
  "CLEANUP_IN_FORBIDDEN_SCOPE",
  "onCleanup was called",
  "return the cleanup function from the callback instead",
);

/** The owner locked now; null: none is. */
let banned: Core | null = null;
/** By locked owner, which of its lists were null before it was locked. */
const was = new WeakMap<Core, readonly [boolean, boolean]>();

/** Lock owner `o`'s lists. */
function lock(o: Core): void {
  was.set(o, [o.owned === null, o.cleanups === null]);
  ((o.owned ??= []) as { push: unknown }).push = NO_PRIMITIVE;
  ((o.cleanups ??= []) as { push: unknown }).push = NO_CLEANUP;
}

/** Unlock owner `o`'s lists: as they were, unless it was cleaned meanwhile (they are null then). */
function unlock(o: Core): void {
  const [owned, cleanups] = was.get(o)!;
  if (o.owned !== null) {
    delete (o.owned as { push?: unknown }).push;
    if (owned && o.owned.length === 0) o.owned = null;
  }
  if (o.cleanups !== null) {
    delete (o.cleanups as { push?: unknown }).push;
    if (cleanups && o.cleanups.length === 0) o.cleanups = null;
  }
}

/**
 * Internal (features/effects and features/timing, development build): run `fn` with owner `o`
 * locked (null: none is), where nothing may be made; the owner locked before is unlocked meanwhile.
 */
export function __ban<T>(o: object | null, fn: () => T): T {
  const b = banned,
    c = o as unknown as Core | null;
  if (b !== null) unlock(b);
  if (c !== null) lock(c);
  banned = c;
  try {
    return fn();
  } finally {
    if (c !== null) unlock(c);
    banned = b;
    if (b !== null) lock(b);
  }
}

/**
 * Internal (features/effects, development build): throw where the current owner is locked, for
 * `what`, which registers a cleanup before it makes its effect: the error names it, not onCleanup.
 * An owner that ran again meanwhile (a write of the callback's re-ran it) cleaned its locked lists
 * away, and makes what it likes.
 */
export function __refuse(what: string): void {
  if (banned !== null && __owner === banned && (banned.cleanups?.push as unknown) === NO_CLEANUP) made(what)();
}
// #endif

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
