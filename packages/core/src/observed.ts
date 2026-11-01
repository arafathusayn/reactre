// The reader-counting entries of @reactre/core/features/memo's `memo` and `signal`, which take
// their `lazy` and `unobserved` options: `__observedMemo` and `__observedSignal`, exported by that
// module (this file is not an entry of its own). @reactre/compiler sends a call that passes either
// option, or options it cannot read, to them (its observed.ts); every other call stays `memo`'s or
// `signal`'s. Each is right for any options: without either, it is `memo` or `signal`.
//
// Both options need to know when a signal loses its last reader, and the core's signals keep no
// count of their readers: counting every subscribe and unsubscribe would cost every app. So only
// the signals made here are counted, and nothing in the core checks for them:
//
//   - A signal's readers are its `subs` array, which the core pushes a reader to when it reads
//     it and splices out when the reader runs again or goes. A counted signal is the core's
//     signal of a version number whose `subs` is an array of a subclass (`Counted`), whose
//     `push` and `splice` tell it when it gains a reader and when it is left with none. Only that
//     signal's array is of the subclass: every other signal's is the plain array it was.
//   - The signal object is found as its read records it, in an effect whose `read` keeps it
//     (`Grab`, of the core's owned effect class), once, when the signal is made.
//   - A reader that runs again drops its reads before it makes them anew, so a list left empty is
//     checked in a microtask: if no reader has come back by then, it is unobserved.
//
// Design decisions:
//   - In its own file, out of features/memo.ts, which re-exports it: an app that imports only
//     `memo` and `signal` from that module bundles the same code as before, and, since Bun's
//     minifier names locals by the letters of every file in the bundle, the same names.
//   - `memo` and `signal` stay as they are, and the options go to these entries, which only the
//     compiler names: an app that passes neither option pays nothing for them, in bytes or time.

import { __Owned, __Root, effect, onCleanup, type Setter, signal as coreSignal } from "@reactre/core";

import { memo, signal, type SignalOptions } from "./features/memo.ts";

/** What a counted list of readers tells: that it had a reader, and that it has none left. */
interface Watch {
  seen: boolean;
  empty(): void;
}

/** A source's readers, counted: an array, as the core's are, that tells its watch when it gains one and when it is left empty. */
type Subs = unknown[] & { readonly w: Watch };

/** The class of counted lists of readers, made the first time one is needed. */
let Counted: (new (w: Watch) => Subs) | undefined;

/** An effect whose `read` keeps the source it is given (in `grabbed`), made the first time one is needed. */
let Grab: (new (fn: () => void) => { run(): void }) | undefined;
let grabbed: { subs: unknown[] };

const inc = (n: number): number => n + 1;

/** A counted signal of a version number: its read, its write, and its readers. */
function counted(w: Watch): [() => number, Setter<number>, Subs] {
  Counted ??= class extends Array<unknown> {
    static override get [Symbol.species](): ArrayConstructor {
      // A copy (the core runs readers over one) is a plain array.
      return Array;
    }
    readonly w: Watch;
    constructor(w: Watch) {
      super();
      this.w = w;
    }
    override push(...items: unknown[]): number {
      this.w.seen = true;
      return super.push(...items);
    }
    override splice(start: number, n: number): unknown[] {
      const out = super.splice(start, n);
      if (this.length === 0) this.w.empty();
      return out;
    }
  };
  Grab ??= class extends __Owned {
    override read(s: Parameters<InstanceType<typeof __Owned>["read"]>[0]): void {
      grabbed = s as unknown as { subs: unknown[] };
    }
  };
  const [read, write] = coreSignal(0),
    subs = new Counted(w),
    G = Grab;
  // Under no owner, so the effect that finds the signal belongs to nothing; it reads nothing.
  __Owned.within(null, () => new G(read).run());
  grabbed.subs = subs;
  return [read, write, subs];
}

/** `memo`'s options. */
type MemoOptions<T> = Parameters<typeof memo<T>>[1] & {};

/** `signal` and `memo` with `unobserved` or `lazy`. */
function observed<T>(
  init: T | ((prev: T | undefined) => T),
  options: MemoOptions<T>,
  lazy: boolean,
): [() => T, Setter<T>] {
  const eq = options.equals ?? ((a: T, b: T) => a === b),
    derived = typeof init === "function",
    unobserved = options.unobserved;
  let v = (derived ? undefined : init) as T,
    has = !derived,
    // A lazy memo's computation, while it runs: the root that owns its effect.
    root: InstanceType<typeof __Root> | null = null,
    // The owner it was made in is gone: it keeps its last value.
    gone = false,
    queued = false;
  // In a microtask after the last reader stopped reading: whether one has come back.
  const settle = (): void => {
    queued = false;
    if (subs.length !== 0) return;
    if (root !== null) {
      root.dispose();
      root = null;
    }
    if (w.seen) {
      w.seen = false;
      unobserved?.();
    }
  };
  const w: Watch = {
    seen: false,
    empty: () => {
      if (queued) return;
      queued = true;
      queueMicrotask(settle);
    },
  };
  const [version, bump, subs] = counted(w);
  const put = (n: T): void => {
    if (has && eq !== false && eq(v, n)) return;
    has = true;
    v = n;
    bump(inc);
  };
  const compute = (): void => effect(() => put((init as (prev: T | undefined) => T)(v)));
  if (lazy)
    // Its effect belongs to a root of its own, which a read starts; it goes with its owner.
    onCleanup(() => {
      gone = true;
      root?.dispose();
      root = null;
    });
  else if (derived) compute();
  const read = (): T => {
    if (lazy && root === null && !gone) __Owned.within((root = new __Root()), compute);
    version();
    // A read with no reader to record it (outside any, or untracked): it stops again soon.
    if (lazy && subs.length === 0) w.empty();
    return v;
  };
  return [read, (next) => put(typeof next === "function" ? (next as (prev: T) => T)(v) : next)];
}

/**
 * `signal`, with `unobserved` (see `SignalOptions`): what @reactre/compiler calls in its place
 * where the options may hold it. Internal: not part of the package's API, and may change in any
 * release.
 */
export function __observedSignal<T>(
  init: T | ((prev: T | undefined) => T),
  options?: SignalOptions<T>,
): [() => T, Setter<T>] {
  return options?.unobserved === undefined ? signal(init as T, options) : observed(init, options, false);
}

/**
 * `memo`, with `lazy` and `unobserved` (see its options): what @reactre/compiler calls in its
 * place where the options may hold either. Internal: not part of the package's API, and may
 * change in any release.
 */
export function __observedMemo<T>(fn: (prev: T | undefined) => T, options?: MemoOptions<T>): () => T {
  return options?.lazy !== true && options?.unobserved === undefined
    ? memo(fn, options)
    : observed(fn, options!, options!.lazy === true)[0];
}
