// @reactre/core/features/lists: Solid 2.0's list functions, `mapArray` and `repeat`, as `map` and
// `repeat`: what `<For>` and `<Repeat>` do, as functions that return the mapped array, for a
// list component of your own or a list that is not DOM.
//
// Each row is mapped under an owner of its own, untracked: what the map function makes (effects,
// cleanups, memos) belongs to the row, and goes when the row leaves the list, or when the owner
// `map` or `repeat` was called in is disposed. A row is mapped once, when it comes; what changes
// for it later reaches it through accessors (its index, or its item when the list is keyed by a
// function or by position).
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and these are runtime functions. `<For>` and `<Repeat>` stay compiled lists, so
//     an app that does not import this module ships none of it.
//   - Built from the core's API: a signal holds the mapped array, written by an owned effect that
//     runs the update (`__Owned`, the class `effect` makes, so that it computes where a memo does,
//     on the server too), and each row's owner is a root (`__Root`) entered with `__Owned.within`,
//     as features/owner's `createRoot` enters its own. The rows' index and item accessors are
//     signals, written as the update commits, in a batch with the array itself.
//   - An update is staged: rows are made into new arrays, and only once every one of them was
//     made does it commit, dispose the rows that left and write the accessors. A map function
//     that throws (or reads a value that is not ready) leaves the list as it was, disposing the
//     rows the update made, and the update runs again when what it read changes.
//   - Names: `map` for mapArray, the short verb, as `<For>`'s function; `repeat` keeps Solid's.

import { __Owned, __Root, batch, onCleanup, type Setter, signal } from "@reactre/core";

/** A list, or nothing: what `map`'s list may return for an empty one. */
export type Maybe<T> = T | void | null | undefined | false;

/** A row's owner. */
type Root = InstanceType<typeof __Root>;

/** A row of `map`: its owner, what the map function returned, its item, and its accessors' setters. */
interface Row<T> {
  r: Root;
  v: unknown;
  x: T;
  /** The item accessor's setter: keyed by a function or by position. */
  s?: Setter<T>;
  /** The index accessor's setter: keyed, with a map function that takes an index. */
  i?: Setter<number>;
}

/** Run `fn` under a new root owner, untracked, for a row; returns the root and what `fn` returned. */
function own<U>(fn: () => U): [Root, U] {
  const r = new __Root();
  try {
    return [r, __Owned.within(r, fn)];
  } catch (e) {
    r.dispose();
    throw e;
  }
}

/** Write `x` through `s`, as a value even if it is a function. */
const put = <T>(s: Setter<T>, x: T): void => s(() => x);

/** Options of `map`. */
export interface MapOptions<T, U> {
  /**
   * How rows are matched to items. `true` (the default): by the item itself, and the map function
   * gets the item and an accessor of its index. `false`: by position, and it gets an accessor of
   * the item at its position and the index, a number. A function `(item) => key`: by key, and it
   * gets accessors of the item with that key and of its index.
   */
  readonly keyed?: boolean | ((item: T) => unknown);
  /** What the array holds while the list is empty: `[fallback()]`, under an owner of its own. */
  readonly fallback?: () => U;
}

/**
 * Map a reactive list to rows, Solid 2.0's `mapArray`: returns an accessor of the mapped array.
 * `list()` is tracked; each item is mapped once, by `fn`, untracked, under an owner of its own,
 * which is disposed when the item leaves the list (and the rest when the owner `map` was called
 * in is disposed). A new list keeps the rows of the items it still has, in its order, maps the
 * new ones and disposes the gone ones; the array is new each time the rows change, and the same
 * when they do not (the same items, or keys, in the same order).
 *
 * - Keyed by the item (the default): `fn(item, index)`, where `index()` follows the row's
 *   position. The accessor is made only if `fn` takes it.
 * - `keyed: (item) => key`: `fn(item, index)` with both accessors: an item of the same key keeps
 *   the row, and `item()` gives the new item.
 * - `keyed: false`: rows by position, `fn(item, i)`: `item()` gives the item at index `i`, a
 *   number. The list growing makes rows at the end; shrinking disposes them from the end.
 *
 * With `fallback`, the array is `[fallback()]` while the list is empty.
 *
 * @example
 *   import { map } from "@reactre/core/features/lists";
 *
 *   const [todos, setTodos] = signal([{ id: 1, title: "a" }]);
 *   const labels = map(
 *     () => todos(),
 *     (todo, i) => memo(() => `${i() + 1}. ${todo.title}`),
 *     { fallback: () => () => "nothing to do" },
 *   );
 *   effect(() => console.log(labels().map((l) => l())));
 */
export function map<T, U>(
  list: () => Maybe<readonly T[]>,
  fn: (item: T, index: () => number) => U,
  options?: MapOptions<T, U> & { readonly keyed?: true },
): () => U[];
export function map<T, U>(
  list: () => Maybe<readonly T[]>,
  fn: (item: () => T, index: number) => U,
  options: MapOptions<T, U> & { readonly keyed: false },
): () => U[];
export function map<T, U>(
  list: () => Maybe<readonly T[]>,
  fn: (item: () => T, index: () => number) => U,
  options: MapOptions<T, U> & { readonly keyed: (item: T) => unknown },
): () => U[];
export function map<T, U>(
  list: () => Maybe<readonly T[]>,
  fn: (item: never, index: never) => U,
  options?: MapOptions<T, U>,
): () => U[] {
  const keyed = options?.keyed,
    key = typeof keyed === "function" ? keyed : null,
    byIndex = keyed === false,
    // An index accessor only for a map function that takes one.
    indexes = !byIndex && fn.length > 1,
    fallback = options?.fallback,
    f = fn as (item: unknown, index: unknown) => U;
  let rows: Row<T>[] = [],
    out: U[] = [],
    // The fallback's owner, while the array holds it.
    fb: Root | null = null;
  const [read, write] = signal(out);
  onCleanup(() => {
    for (const row of rows) row.r.dispose();
    fb?.dispose();
  });

  /** Map item `x` at index `j` to a new row. */
  const make = (x: T, j: number): Row<T> => {
    const row = { x } as Row<T>;
    [row.r, row.v] = own(() => {
      let item: unknown = x,
        index: unknown = j;
      if (byIndex || key !== null) {
        const [g, s] = signal(x);
        row.s = s;
        item = g;
      }
      if (indexes) {
        const [g, s] = signal(j);
        row.i = s;
        index = g;
      } else if (!byIndex) index = undefined;
      return f(item, index);
    });
    return row;
  };

  new __Owned(() => {
    const items = list() || [],
      n = items.length,
      len = rows.length;
    if (n === 0) {
      if (len === 0 && (fallback === undefined || fb !== null)) return;
      let next: U[] = [],
        r: Root | null = null;
      if (fallback !== undefined) [r, next[0]] = own(fallback);
      batch(() => {
        for (const row of rows) row.r.dispose();
        rows = [];
        fb = r;
        write((out = next));
      });
      return;
    }
    // The items, read once (a store's array tracks each index read).
    const xs: T[] = new Array(n);
    for (let j = 0; j < n; j++) xs[j] = items[j]!;
    const next: Row<T>[] = new Array(n),
      made: Row<T>[] = [];
    // Whether the rows are the same, in the same order.
    let same = n === len;
    // The rows by position, or the old rows matched to the new items by key; `used`: those kept.
    const used: boolean[] = new Array(len);
    try {
      if (byIndex)
        for (let j = 0; j < n; j++) {
          if (j < len) next[j] = rows[j]!;
          else made.push((next[j] = make(xs[j]!, j)));
        }
      else {
        const k = key ?? ((x: T): unknown => x);
        // Each key's old rows, in order: equal keys pair by their order.
        const old = new Map<unknown, number[]>();
        for (let i = len - 1; i >= 0; i--) {
          const kx = k(rows[i]!.x),
            q = old.get(kx);
          if (q === undefined) old.set(kx, [i]);
          else q.push(i);
        }
        for (let j = 0; j < n; j++) {
          const q = old.get(k(xs[j]!)),
            i = q === undefined ? undefined : q.pop();
          if (i === undefined) {
            made.push((next[j] = make(xs[j]!, j)));
            same = false;
          } else {
            next[j] = rows[i]!;
            used[i] = true;
            if (i !== j) same = false;
          }
        }
      }
    } catch (e) {
      for (const row of made) row.r.dispose();
      throw e;
    }
    // Commit: the rows that stay take their new item and index, then the rows that left go.
    batch(() => {
      for (let j = 0; j < n; j++) {
        const row = next[j]!,
          x = xs[j]!;
        if (row.x !== x) {
          row.x = x;
          if (row.s !== undefined) put(row.s, x);
        }
        if (row.i !== undefined) row.i(j);
      }
      for (let i = 0; i < len; i++) if (byIndex ? i >= n : !used[i]) rows[i]!.r.dispose();
      if (fb !== null) {
        fb.dispose();
        fb = null;
      }
      rows = next;
      if (!same) {
        out = new Array(n);
        for (let j = 0; j < n; j++) out[j] = next[j]!.v as U;
        write(out);
      }
    });
  }).run();
  return read;
}

/** Options of `repeat`. */
export interface RepeatOptions<U> {
  /** The first index (0 by default): the rows are `from` to `from + count - 1`. */
  readonly from?: () => number | undefined;
  /** What the array holds while the count is 0: `[fallback()]`, under an owner of its own. */
  readonly fallback?: () => U;
}

/**
 * A row per index, Solid 2.0's `repeat`: returns an accessor of the array of `fn(i)` for `i` from
 * `from()` (0 by default) to `from() + count() - 1`. `count` and `from` are tracked; each index is
 * mapped once, by `fn`, untracked, under an owner of its own, which is disposed when the index
 * leaves the range (and the rest when the owner `repeat` was called in is disposed). With
 * `fallback`, the array is `[fallback()]` while the count is 0.
 *
 * @example
 *   import { repeat } from "@reactre/core/features/lists";
 *
 *   const [page, setPage] = signal(0);
 *   const rows = repeat(() => 20, (i) => `row ${i}`, { from: () => page() * 20 });
 *   setPage(1); // rows() is "row 20" to "row 39"
 */
export function repeat<U>(count: () => number, fn: (index: number) => U, options?: RepeatOptions<U>): () => U[] {
  const from = options?.from,
    fallback = options?.fallback;
  let rows: Root[] = [],
    out: U[] = [],
    // The first index of `rows`.
    at = 0,
    fb: Root | null = null;
  const [read, write] = signal(out);
  onCleanup(() => {
    for (const r of rows) r.dispose();
    fb?.dispose();
  });
  new __Owned(() => {
    const n = count(),
      start = (from === undefined ? 0 : from()) || 0,
      len = rows.length;
    if (n === 0) {
      if (len === 0 && (fallback === undefined || fb !== null)) return;
      let next: U[] = [],
        r: Root | null = null;
      if (fallback !== undefined) [r, next[0]] = own(fallback);
      batch(() => {
        for (const row of rows) row.dispose();
        rows = [];
        at = 0;
        fb = r;
        write((out = next));
      });
      return;
    }
    if (n === len && start === at) return;
    const end = start + n,
      // The indexes both ranges have, whose rows stay.
      keep = Math.max(start, at),
      stop = Math.min(end, at + len),
      next: Root[] = new Array(n),
      vs: U[] = new Array(n),
      made: Root[] = [];
    for (let i = keep; i < stop; i++) {
      next[i - start] = rows[i - at]!;
      vs[i - start] = out[i - at]!;
    }
    try {
      for (let i = start; i < end; i++)
        if (i < keep || i >= stop) {
          const [r, v] = own(() => fn(i));
          made.push((next[i - start] = r));
          vs[i - start] = v;
        }
    } catch (e) {
      for (const r of made) r.dispose();
      throw e;
    }
    batch(() => {
      for (let i = 0; i < len; i++) if (i + at < keep || i + at >= stop) rows[i]!.dispose();
      if (fb !== null) {
        fb.dispose();
        fb = null;
      }
      rows = next;
      at = start;
      write((out = vs));
    });
  }).run();
  return read;
}
