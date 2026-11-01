// @reactre/core/features/for: the runtime of a `<For>` or `<Repeat>` that the core's compiled list
// does not cover. The compiler imports it for a file that has one; it has no export of its own
// for an app to call.
//
// The core's list (`__for`, `__forMount`) is a list of elements, each row one element, in the
// element the list is a child of. This one is any list anywhere: a component's whole view, a
// child of a fragment, of `<Show>`, `<Switch>`, `<Errored>`, `<Loading>` or a context's provider,
// a row of another list; and rows of any shape: text, a fragment, an array, nothing, what a
// component returns, or content that changes (a row whose expression calls something is a slot).
//
// How it works:
//
//   - The list's nodes are between two markers of its own, empty text nodes, which it is built
//     between in a document fragment. It returns its nodes, markers included, as content is
//     returned, so what puts them on the page (a slot, an element's hole, `attach`) moves them
//     where they go; its later renders put rows before its end marker, wherever that is.
//   - A row is its function's content, made nodes by `__frag` under an owner of its own: a slot
//     for a function, the nodes of anything else. Of its nodes, the row keeps its last one, which
//     stays its last (a slot's content goes before its anchor, a list's rows before its end
//     marker): a row's nodes are the ones after the row before it, up to its last.
//   - A render reads each old row's nodes from the page, in order, makes the new rows and disposes
//     the ones that left, then puts each row's nodes before the next row's, from the end, moving
//     only a node that is not where it goes.
//   - Keyed (`key`), a row is kept for the same key and the same item (===): an item that is new
//     for its key builds its row again, as a row's mounts are built again in the core's list.
//     Without a key, rows are by position, as `keyed={false}`'s: the row at index i gets an
//     accessor of the item there, which the list writes when a new item comes. `<Repeat>` is a
//     keyed list over the indexes.
//   - `fallback` is a row of its own, shown while the list is empty.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the compiled list of elements in an element is
//     what the benchmark and every list of host rows use, and it stays as it was, byte for byte. A
//     file whose lists are all of that kind imports nothing of this module.
//   - Built from the core's API (`__frag`, `__Owned`, `__Root`, `signal`), as features/lists is.
//   - Hydration passes the page's markers, the `__frag` that claims and a guard of each row's claim
//     (@reactre/core/features/hydrate's `__heach`): the first render's rows claim the page's nodes
//     in order, and from a row that does not match, the rest are built afresh.

import { __frag, __Owned, __owner, __Root, batch, onCleanup, type Setter, signal, untrack } from "@reactre/core";

/** A row's owner. */
type Root = InstanceType<typeof __Root>;

/**
 * One row: its owner, item and key, its last node (null for none); by position, its item's
 * setter; keyed, with a row function that takes an index, its index and the index's setter.
 */
interface Row<T> {
  readonly r: Root;
  x: T;
  readonly k: unknown;
  readonly last: Node | null;
  readonly s: Setter<T> | null;
  j: number;
  readonly i: Setter<number> | null;
}

/** What the compiler emits for a `<For>` or `<Repeat>` this module renders. */
export interface EachSpec<T> {
  /** The items (tracked: the list renders again when they change). */
  readonly each: () => readonly T[] | null | undefined | false;
  /** An item's key; without one, rows are by position, and a row gets an accessor of its item. */
  readonly key?: (item: T) => unknown;
  /**
   * A row's content, for its item and an accessor of its index; by position, an accessor of its
   * item and its index.
   */
  readonly row: (item: T | (() => T), i: number | (() => number)) => unknown;
  /** What is shown while the list is empty. */
  readonly fallback?: () => unknown;
}

/** A row's claim of the page while it hydrates: `fn()`, or where the page does not match, `fn()` afresh. */
export type Guard = <R>(fn: () => R) => R;

/**
 * Internal (@reactre/compiler): the list of `spec`, as its nodes, markers included. It renders now
 * and whenever `spec.each` changes; it is disposed with the current owner, which takes its nodes
 * out of the page too.
 *
 * @param at The page's markers to render between, while hydrating; else it makes markers of its own.
 * @param frag The `__frag` that makes a row's content its nodes: while hydrating, the one that claims.
 * @param guard While hydrating, the claim of a row.
 */
export function __each<T>(
  spec: EachSpec<T>,
  at?: readonly [Node, Node],
  frag: (kids: readonly unknown[]) => Node[] = __frag,
  guard: Guard = (fn) => fn(),
): Node[] {
  let start: Node, end: Node;
  if (at === undefined) {
    const f = document.createDocumentFragment();
    start = f.appendChild(document.createTextNode(""));
    end = f.appendChild(document.createTextNode(""));
  } else [start, end] = at;
  const key = spec.key,
    fallback = spec.fallback;
  let rows: Row<T>[] = [],
    // The fallback's row, while it is shown (and `rows` is empty).
    fb: Row<T> | null = null;
  // Each row's nodes, and the rows made, during a render.
  const nodes = new Map<Row<T>, Node[]>();
  let made: Row<T>[] = [];

  /** A new row for item `x` of key `k` at index `i` (-1: the fallback's), with its nodes. */
  const make = (x: T, k: unknown, i: number): Row<T> => {
    const [row, ns] = guard((): [Row<T>, Node[]] => {
      const r = new __Root();
      let s: Setter<T> | null = null,
        is: Setter<number> | null = null;
      try {
        const ns = __Owned.within(r, () => {
          if (i < 0) return frag([fallback!()]);
          if (key === undefined) {
            const [v, set] = signal(x);
            s = set;
            return frag([spec.row(v, i)]);
          }
          // An index accessor only for a row function that takes one.
          if (spec.row.length < 2) return frag([spec.row(x, i)]);
          const [j, set] = signal(i);
          is = set;
          return frag([spec.row(x, j)]);
        });
        return [{ r, x, k, last: ns.length === 0 ? null : ns[ns.length - 1]!, s, j: i, i: is }, ns];
      } catch (e) {
        r.dispose();
        throw e;
      }
    });
    nodes.set(row, ns);
    made.push(row);
    return row;
  };

  /** Dispose `row`, and take its nodes out. */
  const drop = (row: Row<T>): void => {
    row.r.dispose();
    for (const n of nodes.get(row)!) n.parentNode?.removeChild(n);
  };

  const render = (items: readonly T[]): void => {
    const old = fb === null ? rows : [fb],
      n = items.length;
    // Each old row's nodes as the page has them now, in order.
    let walk = start.nextSibling!;
    for (const row of old) {
      const ns: Node[] = [];
      if (row.last !== null)
        while (walk !== end) {
          ns.push(walk);
          walk = walk.nextSibling!;
          if (ns[ns.length - 1] === row.last) break;
        }
      nodes.set(row, ns);
    }
    const next: Row<T>[] = [];
    made = [];
    try {
      if (key === undefined) for (let j = 0; j < n; j++) next.push(j < rows.length ? rows[j]! : make(items[j]!, j, j));
      else {
        // Each key's old rows, in order: equal keys pair by their order.
        const byKey = new Map<unknown, Row<T>[]>();
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i]!,
            q = byKey.get(row.k);
          if (q === undefined) byKey.set(row.k, [row]);
          else q.push(row);
        }
        for (let j = 0; j < n; j++) {
          const x = items[j]!,
            k = key(x),
            q = byKey.get(k),
            row = q?.[q.length - 1];
          // An item new for its key builds its row again.
          next.push(row !== undefined && row.x === x ? q!.pop()! : make(x, k, j));
        }
      }
      if (n === 0 && fallback !== undefined) next.push(fb ?? make(undefined as T, undefined, -1));
    } catch (e) {
      for (const row of made) drop(row);
      nodes.clear();
      throw e;
    }
    // The rows that left go.
    const stay = new Set(next);
    for (const row of old) if (!stay.has(row)) drop(row);
    // Each row's nodes before the next row's, from the end: a node already in its place stays.
    const p = end.parentNode!;
    let ref: Node = end;
    for (let j = next.length - 1; j >= 0; j--) {
      const ns = nodes.get(next[j]!)!;
      for (let i = ns.length - 1; i >= 0; i--) {
        const nd = ns[i]!;
        if (nd.nextSibling !== ref) p.insertBefore(nd, ref);
        ref = nd;
      }
    }
    nodes.clear();
    // What is left before the rows is no row's: the page's nodes that hydration did not claim.
    while (start.nextSibling !== ref) p.removeChild(start.nextSibling!);
    if (n === 0 && fallback !== undefined) {
      fb = next[0]!;
      rows = [];
      return;
    }
    fb = null;
    rows = next;
    // By position, a kept row takes the item now at its index; keyed, its index.
    batch(() => {
      for (let j = 0; j < n; j++) {
        const row = next[j]!,
          x = items[j]!;
        if (row.x !== x) {
          row.x = x;
          row.s!(() => x);
        }
        if (row.j !== j) {
          row.j = j;
          row.i?.(j);
        }
      }
    });
  };

  if (__owner !== null)
    onCleanup(() => {
      for (const row of fb === null ? rows : [fb]) row.r.dispose();
      rows = [];
      fb = null;
      const p = end.parentNode;
      if (p !== null && start.parentNode === p) {
        while (start.nextSibling !== end) p.removeChild(start.nextSibling!);
        p.removeChild(start);
        p.removeChild(end);
      }
    });
  new __Owned(() => {
    const items = spec.each() || [];
    untrack(() => render(items));
  }).run();
  const out: Node[] = [];
  for (let n: Node = start; ; n = n.nextSibling!) {
    out.push(n);
    if (n === end) return out;
  }
}
