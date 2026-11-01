// @reactre/core/features/index: the runtime of `<For each keyed={false}>`, Solid 2.0's
// replacement for `<Index>`. The compiler imports it for a file that has such a list; it has no
// export of its own for an app to call.
//
// Rows are by position. The row at index i is made once, when the list first has an i-th item,
// and stays while the list is that long. Its item is an accessor (`item()`), which reads the
// position's current item: when `each` gives a new item at that position, the holes that read it
// run again, and nothing else of the row does. The row leaves when the list gets shorter.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and this is a runtime function. A file without such a list does not import it,
//     so an app without one ships none of it, and a keyed `<For>` runs as before.
//   - Built on the keyed list and a signal per position, from the core's API as it is: `__index`
//     turns the compiled spec into a keyed one over cells, one per position, keyed by the
//     position and kept from render to render. The keyed list gets the same cell for a key each
//     time, so it never updates a row (`skipUnchanged`); a cell whose item changed writes its
//     signal instead, which re-runs the holes that read the accessor.
//   - The row's code gets the cell's accessor and index by destructuring (`({ v: item, i })`),
//     so a hole that calls `item()` is a reactive hole, as any call is, and one that reads only
//     `i` is written once, when the row is made.

import { type ForSpec, type Setter, signal } from "@reactre/core";

/** One position of a list: the row's accessor of its item, and the position. */
interface Cell<T> {
  /** The row's accessor of the item. */
  readonly v: () => T;
  /** The position. */
  readonly i: number;
  /** The item at this position, as last written. */
  x: T;
  /** Writes the item. */
  readonly s: Setter<T>;
}

/** A cell's key: its position. */
const at = (c: { readonly i: number }): number => c.i;

/** What the compiler emits for a `<For keyed={false}>`: a ForSpec over cells, with no key. */
export type IndexSpec<T> = Omit<ForSpec<Cell<T>, number>, "each" | "key"> & { readonly each: () => readonly T[] };

/**
 * Internal (@reactre/compiler): the keyed spec of a `<For keyed={false}>`, for `__for` or
 * `__forMount`. Each render gives the list the cells of positions 0 to n - 1, made for the
 * positions it did not have, and writes the item of each kept position whose item changed (!==).
 */
export function __index<T>(spec: IndexSpec<T>): ForSpec<Cell<T>, number> {
  const cells: Cell<T>[] = [],
    each = spec.each;
  return {
    ...spec,
    key: at,
    each: () => {
      const items = each(),
        n = items.length;
      for (let i = 0; i < n; i++) {
        const c = cells[i],
          x = items[i] as T;
        if (c === undefined) {
          const [v, s] = signal(x);
          cells.push({ v, i, x, s });
        } else if (c.x !== x) {
          c.x = x;
          // As a function, so an item that is a function is stored, not called.
          c.s(() => x);
        }
      }
      // The cells past the end go with their rows: a list that grows again makes new ones.
      cells.length = n;
      // A new array each time: the keyed list keeps the last one to compare with.
      return cells.slice();
    },
  };
}
