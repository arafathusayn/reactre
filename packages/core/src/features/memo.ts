// @reactre/core/features/memo: Solid 2.0's options for memos and signals. `memo(fn, { equals })`,
// and `signal(fn)`, a writable derived signal.
//
// Design decisions:
//   - The exports keep @reactre/core's names, `memo` and `signal`, with Solid 2.0's signatures,
//     which take core's as they are: `memo(fn)` and `signal(value)` behave as core's do. A feature
//     module cannot add options to core's own functions without core paying for them, so an app
//     that wants the options imports these instead (`import { memo } from
//     "@reactre/core/features/memo"`), and one that imports both names a pair under `as`.
//   - Built from the public API alone: the value lives in a closure, and a core signal of a
//     version number, bumped when the value changes, is what readers subscribe to. So `equals`
//     decides alone whether readers re-run, and `equals: false` re-runs them on every write.
//   - Solid 2.0's `lazy` and `unobserved` options are in `createMemo` and `createSignal`, Solid
//     2.0's names, from ../observed.ts: both need to know when a memo loses its last reader,
//     which core's signals do not count, so only the signals made with them are counted, and
//     `memo` and `signal` stay as they are. In a file of their own, so an app that imports only
//     `memo` and `signal` bundles the code it did, with the same minified names.

import { effect, type Setter, signal as coreSignal } from "@reactre/core";

export * from "../observed.ts";

/** Options of `signal` and `memo`. */
export interface SignalOptions<T> {
  /**
   * Whether a new value is the same as the last, so that readers do not re-run: default `===`;
   * false re-runs them on every write. It is not asked about a derived signal's first value.
   */
  readonly equals?: false | ((prev: T, next: T) => boolean);
}

const inc = (n: number): number => n + 1;

/**
 * A signal, as `signal` from @reactre/core, with options; or, given a function, a writable
 * derived signal (Solid 2.0's `createSignal(fn)`). `fn(prev)` computes the value now and again
 * whenever what it read changes, given the current value; a write through the setter sets the
 * value until `fn` runs again. To store a function as a value, use @reactre/core's `signal`.
 *
 * @example
 *   import { signal } from "@reactre/core/features/memo";
 *
 *   const [items, setItems] = signal(["a", "b"]);
 *   const [selected, setSelected] = signal(() => items()[0]); // "a"
 *   setSelected("b"); // "b", until items change
 *   setItems(["c"]); // "c"
 */
export function signal<T>(fn: (prev: T | undefined) => T, options?: SignalOptions<T>): [() => T, Setter<T>];
export function signal<T>(value: T, options?: SignalOptions<T>): [() => T, Setter<T>];
export function signal<T>(init: T | ((prev: T | undefined) => T), options?: SignalOptions<T>): [() => T, Setter<T>] {
  const eq = options?.equals ?? ((a: T, b: T) => a === b),
    derived = typeof init === "function",
    [version, bump] = coreSignal(0);
  let v = (derived ? undefined : init) as T,
    // Whether there is a value to compare with: not before a derived signal's first.
    has = !derived;
  const put = (n: T): void => {
    if (has && eq !== false && eq(v, n)) return;
    has = true;
    v = n;
    bump(inc);
  };
  if (derived) effect(() => put((init as (prev: T | undefined) => T)(v)));
  return [() => (version(), v), (next) => put(typeof next === "function" ? (next as (prev: T) => T)(v) : next)];
}

/**
 * A derived value, as `memo` from @reactre/core, with options: `fn(prev)` is given its last
 * value, and `equals` decides whether a new value re-runs its readers (default `===`; false: every
 * time `fn` runs).
 *
 * @example
 *   import { memo } from "@reactre/core/features/memo";
 *
 *   const [user, setUser] = signal({ id: 1, name: "a" });
 *   const current = memo(() => user(), { equals: (a, b) => a.id === b.id });
 *   setUser({ id: 1, name: "b" }); // readers of current do not re-run
 */
export function memo<T>(fn: (prev: T | undefined) => T, options?: SignalOptions<T>): () => T {
  return signal(fn, options)[0];
}
