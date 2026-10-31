// reactre: declarative UI compiled to @reactre/dom templates.
//
// You write TSX components over signals:
//
//   const [rows, setRows] = signal<Row[]>([]);
//   const [selected, setSelected] = signal(0);
//   const isSelected = selector(selected);
//   const App = () => (
//     <tbody>
//       <For each={rows()} key={(r) => r.id}>
//         {(row) => (
//           <tr class={isSelected(row.id) ? "danger" : ""} onClick={() => setSelected(row.id)}>
//             {row.label}
//           </tr>
//         )}
//       </For>
//     </tbody>
//   );
//   render(App, document.getElementById("main")!);
//
// @reactre/compiler turns each JSX tree into a template, cloned per
// instance, and the code that keeps its holes up to date. Components run
// once; what changes later is what reads a signal:
//
//   - Outside a list, a hole whose expression calls a function (a signal
//     read, most often) is an effect: it re-runs, and rewrites the hole,
//     when a signal it read changes. Any other hole is written once.
//   - In a `<For>` row, a hole that reads only the row (`row.label`) is
//     written when the row is created and compared when the list renders
//     the row again with a new item of the same key. A hole that calls a
//     function is the row's reactive part: it re-runs when a signal it read
//     changes. A `selector` read costs a row one field, not a subscription:
//     a change of selection re-runs the two rows whose key it was or is.
//   - Event handlers in rows are delegated: one listener per event type on
//     the list's parent, which finds the row and calls its handler (in the
//     capture phase for an event that does not bubble, such as focus).
//   - A row may also hold components, nested lists, JSX expressions,
//     properties, styles, refs and spread props ("mounts"). Such a row gets
//     an owner, and its mounts run under it; a new item for the row cleans
//     the owner and runs them again. Only lists whose rows have mounts take
//     that path (`__forMount`); host-only rows cost what they always have.
//   - Every effect run owns the effects and cleanups (`onCleanup`) it makes,
//     and disposes them before it re-runs: a slot that replaces its content
//     stops the old content's effects. `render` returns the root's disposer.
//
// The list is @reactre/dom's keyed List (reuse, minimal moves, swaps and
// removals in place). Nothing here depends on React.
//
// Design decisions that shape the code below:
//
//   - Reactivity is push-based and synchronous. A signal write re-runs its
//     observers at once, or at the end of the outermost `batch`. An effect
//     notified while it runs (it wrote what it read) runs again after, up to
//     100 times in a row, then throws.
//   - An observer re-collects what it reads on every run, so a branch that
//     stops reading a signal stops depending on it.
//   - Rows cost as little as possible. A row is one plain object of fixed
//     shape. Its hole nodes are looked up only when one is first written. All
//     rows share one observer context while their reactive holes run, and a
//     row gets an observer object of its own only when it reads a signal.
//   - Everything named with a leading `__` is the compiler's target, not a
//     public API. Its shape follows what the compiler emits.

import { List, Template } from "@reactre/dom";

// #region Reactivity core

/** Something an observer reads: a signal, or a selector's key. */
interface Source {
  /** The observers that read this source on their last run. */
  subs: Observer[];
}

/** What reads are recorded for while it runs. */
interface Reader {
  /** Note that this reader read `s`. */
  read(s: Source): void;
}

/** What runs again when a source it read changes. */
interface Observer extends Reader {
  /** Queued in `pending`, so a batch notifies it once however often its sources change. */
  q: boolean;
  /** A source it read has changed. */
  stale(): void;
}

/** The reader whose reads are being recorded; null outside any observer and inside `untrack`. */
let current: Reader | null = null;
/** The owner that effects and cleanups made now belong to; null outside any (nothing disposes them). */
let owner: Owner | null = null;
/** Depth of nested `batch` calls; observers are deferred while it is above 0. */
let batching = 0;
/** Observers notified during a batch, in first-notified order, each once (its `q` flag says so). */
let pending: Observer[] = [];

/** Tell the observers of `s` that it changed: now, or at the end of the current batch. */
function notify(s: Source): void {
  const subs = s.subs;
  if (subs.length === 0) return;
  if (batching) {
    // The flag keeps each observer to one run per batch, without a search of the queue.
    for (let i = 0; i < subs.length; i++) {
      const o = subs[i]!;
      if (!o.q) {
        o.q = true;
        pending.push(o);
      }
    }
    return;
  }
  // Re-running drops and re-adds subscriptions: run over a copy.
  const run = subs.slice();
  for (let i = 0; i < run.length; i++) run[i]!.stale();
}

/** Run the observers a batch queued, and any that those runs queue in batches of their own. */
function flush(): void {
  while (pending.length) {
    // A run may open a batch of its own and queue more: those go to a fresh queue.
    const q = pending;
    pending = [];
    let i = 0;
    try {
      for (; i < q.length; i++) {
        q[i]!.q = false;
        q[i]!.stale();
      }
    } catch (err) {
      // The ones not run yet stay queued (still flagged) for the next flush.
      pending = q.slice(i + 1).concat(pending);
      throw err;
    }
  }
}

/**
 * Run `fn` with every effect it causes deferred to its end, each run once.
 * Batches nest: effects run when the outermost one returns (or throws).
 *
 * @example
 *   const [a, setA] = signal(1);
 *   const [b, setB] = signal(2);
 *   effect(() => console.log(a() + b())); // logs 3
 *   batch(() => {
 *     setA(10);
 *     setB(20);
 *   }); // logs 30, once
 */
export function batch<T>(fn: () => T): T {
  batching++;
  try {
    return fn();
  } finally {
    // Flushing happens with batching back at 0, so a write made by a flushed
    // effect notifies its observers at once instead of queueing behind it.
    if (--batching === 0 && pending.length) flush();
  }
}

/**
 * Run `fn` without recording what it reads: the observer around it does not
 * re-run when those signals change.
 *
 * @example
 *   const [count] = signal(0);
 *   const [label] = signal("n");
 *   effect(() => console.log(count(), untrack(label))); // re-runs on count only
 */
export function untrack<T>(fn: () => T): T {
  const o = current;
  current = null;
  try {
    return fn();
  } finally {
    current = o;
  }
}

// #endregion

// #region Ownership

/**
 * What effects and cleanups belong to: an effect's run, a `<For>` row with
 * slots, or a `render`. Disposing an owner disposes what it owns, deepest
 * first, and runs its cleanups. An effect cleans itself before each re-run,
 * so what one run made is gone before the next makes its own.
 *
 * Both lists stay null until something is owned: an effect that creates no
 * effect and registers no cleanup (every hole's) pays one check per run.
 */
class Owner {
  owned: Owner[] | null = null;
  cleanups: (() => void)[] | null = null;
  /** Dispose what it owns and run its cleanups, then forget both. */
  clean(): void {
    const o = this.owned,
      c = this.cleanups;
    this.owned = null;
    this.cleanups = null;
    if (o !== null) for (let i = 0; i < o.length; i++) o[i]!.dispose();
    if (c !== null) for (let i = 0; i < c.length; i++) c[i]!();
  }
  dispose(): void {
    this.clean();
  }
}

/** Make `o` belong to the current owner, if there is one. */
function adopt(o: Owner): void {
  if (owner !== null) (owner.owned ??= []).push(o);
}

/**
 * Run `fn` when the current owner is disposed or re-runs: in an effect,
 * before its next run; in a component, when the slot or row holding it
 * replaces it, or when `render`'s disposer is called. Outside any owner (at
 * module scope) it does nothing, since nothing would ever call it.
 *
 * @example
 *   function Clock() {
 *     const [now, setNow] = signal(Date.now());
 *     const id = setInterval(() => setNow(Date.now()), 1000);
 *     onCleanup(() => clearInterval(id));
 *     return <time>{new Date(now()).toLocaleTimeString()}</time>;
 *   }
 */
export function onCleanup(fn: () => void): void {
  if (owner !== null) (owner.cleanups ??= []).push(fn);
}

/** Run `fn` with `o` as the owner and no reader: what it creates belongs to `o`. */
function within<T>(o: Owner | null, fn: () => T): T {
  const po = owner,
    pc = current;
  owner = o;
  current = null;
  try {
    return fn();
  } finally {
    owner = po;
    current = pc;
  }
}

// #endregion

// #region Signals and effects

/** A signal's setter: a value, or a function of the current value. */
export type Setter<T> = (v: T | ((prev: T) => T)) => void;

/** A signal's state. A class, so every signal has the same two fields in the same order. */
class Signal<T> implements Source {
  subs: Observer[] = [];
  v: T;
  constructor(v: T) {
    this.v = v;
  }
}

/**
 * A value that observers re-run on: [read, write]. Writing an identical (===)
 * value does nothing. Reading inside an effect, a reactive hole or a memo
 * subscribes it.
 *
 * @example
 *   const [count, setCount] = signal(0);
 *   effect(() => console.log(count())); // logs 0
 *   setCount(1); // logs 1
 *   setCount((c) => c + 1); // logs 2
 *   setCount(2); // identical: nothing runs
 */
export function signal<T>(v: T): [() => T, Setter<T>] {
  const s = new Signal(v);
  const read = (): T => {
    if (current !== null) current.read(s);
    return s.v;
  };
  const write: Setter<T> = (next) => {
    const v2 = typeof next === "function" ? (next as (p: T) => T)(s.v) : next;
    if (v2 === s.v) return;
    s.v = v2;
    notify(s);
  };
  return [read, write];
}

// Effect states.
const IDLE = 0,
  RUNNING = 1,
  /** Notified while running: it runs again when the run ends. */
  DIRTY = 2,
  DISPOSED = 3;
/** Re-runs in a row after which an effect that keeps changing what it reads is a cycle. */
const MAX_RERUNS = 100;

/**
 * An effect: a function re-run whenever a source it read last time changes.
 * It owns the effects and cleanups its run makes.
 */
class Effect extends Owner implements Observer {
  private readonly fn: () => void;
  private sources: Source[] = [];
  q = false;
  private state = IDLE;
  constructor(fn: () => void) {
    super();
    this.fn = fn;
  }
  read(s: Source): void {
    // An effect reads few sources, so a linear scan is enough to skip repeats.
    if (this.sources.includes(s)) return;
    this.sources.push(s);
    s.subs.push(this);
  }
  stale(): void {
    // A write to what it read, made by its own run (or by a run it caused),
    // does not recurse: the run ends first, then it runs again.
    if (this.state === IDLE) this.run();
    else if (this.state === RUNNING) this.state = DIRTY;
  }
  /** Run `fn` as the current observer and owner, after dropping the sources and owned effects of the last run. */
  run(): void {
    // What the last run made and read is gone: this run collects its own.
    if (this.owned !== null || this.cleanups !== null) this.clean();
    this.drop();
    this.state = RUNNING;
    const o = current,
      ow = owner;
    current = this;
    owner = this;
    try {
      this.fn();
    } catch (err) {
      if (this.state !== DISPOSED) this.state = IDLE;
      throw err;
    } finally {
      current = o;
      owner = ow;
    }
    // Notified while running (it wrote what it read): run again, out of this path.
    if (this.state === DIRTY) this.again();
    else if (this.state === RUNNING) this.state = IDLE;
  }
  /** The run ended with the effect notified again: run it again, up to MAX_RERUNS in a row. */
  private again(): void {
    this.state = IDLE;
    if (++this.reruns === MAX_RERUNS) {
      this.reruns = 0;
      throw new Error(
        `reactre: an effect re-ran ${MAX_RERUNS} times in a row: it writes a signal it reads (directly or through other effects), so it never settles`,
      );
    }
    try {
      this.run();
    } finally {
      this.reruns = 0;
    }
  }
  /** Re-runs in a row so far, while `again` recurses. */
  private reruns = 0;
  /** Unsubscribe from every source of the last run. */
  drop(): void {
    const ss = this.sources;
    for (let i = 0; i < ss.length; i++) {
      const subs = ss[i]!.subs,
        j = subs.indexOf(this);
      if (j >= 0) subs.splice(j, 1);
    }
    this.sources = [];
  }
  /** Stop for good: unsubscribe, and dispose what the last run made. */
  override dispose(): void {
    this.state = DISPOSED;
    this.drop();
    this.clean();
  }
}

/**
 * Run `fn` now and again whenever a signal it read changes. Each run records
 * its reads afresh, so conditional reads are tracked as they happen.
 *
 * @example
 *   const [name, setName] = signal("a");
 *   effect(() => (document.title = name()));
 *   setName("b"); // the title is now "b"
 */
export function effect(fn: () => void): void {
  const e = new Effect(fn);
  adopt(e);
  e.run();
}

/**
 * A derived value, recomputed when what it reads changes: a read function.
 * It is a signal written by an effect, so its readers re-run only when the
 * recomputed value differs (!==) from the last.
 *
 * @example
 *   const [a, setA] = signal(2);
 *   const double = memo(() => a() * 2);
 *   double(); // 4
 *   setA(3);
 *   double(); // 6
 */
export function memo<T>(fn: () => T): () => T {
  // The effect runs at once, so the placeholder undefined is never observed.
  const [read, write] = signal<T>(undefined as T);
  effect(() => write(fn()));
  return read;
}

// #endregion

// #region Selector

/**
 * A keyed view of `source`: `is(k)` is true for the one key the source
 * holds. When it changes, only what asked about the old key and the new one
 * re-runs (a selected row, among a thousand).
 *
 * @example
 *   const [selected, setSelected] = signal(0);
 *   const isSelected = selector(selected);
 *   // In a <For> row: <tr class={isSelected(row.id) ? "danger" : ""}>
 *   setSelected(7); // re-runs the rows with id 0 and 7, no others
 */
export function selector<K>(source: () => K): (k: K) => boolean {
  const sel = new Selector<K>();
  effect(() => {
    const next = source();
    const prev = sel.key;
    sel.key = next;
    // The first run only records the key: nothing has asked about one yet.
    if (sel.ready) sel.changed(prev, next);
    sel.ready = true;
  });
  return (k: K): boolean => {
    const o = current;
    if (o !== null) sel.watch(o, k);
    return k === sel.key;
  };
}

/** One key of a selector, as a source: the observers outside rows that asked about it. */
class KeySource implements Source {
  subs: Observer[] = [];
}

/**
 * A selector's state: its current key and who asked about which key.
 *
 * Rows of a `<For>` are not subscribed one by one. A row records the
 * selector and the key it asked about on itself, and the selector keeps only
 * the list, once. On a change, each list scans its rows for the two keys:
 * one comparison per row, no subscription objects at all. A row that asks
 * more than one (selector, key) pair keeps them all in a list (see `more`).
 *
 * Any other reader subscribes to the key's source like to a signal, so it
 * stops following a key when a run no longer asks about it.
 */
class Selector<K> {
  key!: K;
  ready = false;
  // Rows of lists that asked: by list, the rows remember their key themselves.
  readonly lists: ForList<unknown, unknown>[] = [];
  // Anything else that asked, by key.
  readonly byKey = new Map<K, KeySource>();
  /** Record that reader `o` asked about key `k`. */
  watch(o: Reader, k: K): void {
    if (o === rowContext) {
      // A row asks: it keeps the key itself; the list is told of changes.
      const e = rowContext.entry,
        list = rowContext.list;
      if (e.sel === null) {
        e.sel = this as Selector<unknown>;
        e.sk = k;
      } else if (e.sel !== this || e.sk !== k) more(list, e, this as Selector<unknown>, k);
      if (!this.lists.includes(list)) {
        this.lists.push(list);
        list.sels.push(this as Selector<unknown>);
      }
      return;
    }
    let src = this.byKey.get(k);
    if (src === undefined) this.byKey.set(k, (src = new KeySource()));
    o.read(src);
  }
  /** The key moved from `prev` to `next`: re-run what asked about either. */
  changed(prev: K, next: K): void {
    if (prev === next) return;
    for (let i = 0; i < this.lists.length; i++) this.lists[i]!.selectorChanged(this as Selector<unknown>, prev, next);
    // Only rows asked (the benchmark's case): no per-key lookups.
    if (this.byKey.size === 0) return;
    this.wake(prev);
    this.wake(next);
  }
  /** Re-run the observers that asked about `k`; a key no one asks about any more is forgotten. */
  private wake(k: K): void {
    const src = this.byKey.get(k);
    if (src === undefined) return;
    notify(src);
    if (src.subs.length === 0) this.byKey.delete(k);
  }
}

/**
 * Stands in a row's `sel` when the row asked more than one (selector, key)
 * pair; its `sk` then holds the pairs, flat: [selector, key, selector, key, ...].
 */
const MANY = new Selector<unknown>();

/** Row `e` asks about a second (or later) pair: keep them all, and mark the list as having such rows. */
function more(list: ForList<unknown, unknown>, e: Row<unknown>, sel: Selector<unknown>, k: unknown): void {
  if (e.sel !== MANY) {
    e.sk = [e.sel, e.sk];
    e.sel = MANY;
    list.many = true;
  }
  const pairs = e.sk as unknown[];
  for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === sel && pairs[i + 1] === k) return;
  pairs.push(sel, k);
}

// #endregion

// #region Lists

/**
 * One row of a `<For>`. Every row is created by one object literal with all
 * of these fields, so rows share one shape and the list's loops over them
 * stay monomorphic.
 */
interface Row<T> {
  readonly root: Element;
  item: T;
  /** The row's hole nodes, looked up the first time one is written. */
  nodes: unknown[] | null;
  /** The last values of its reactive holes. */
  dv: unknown[] | null;
  /** The selector it asked, and the key it asked about (MANY and the pairs, for several). */
  sel: Selector<unknown> | null;
  sk: unknown;
  /** Its observer, when its reactive holes read a signal (not a selector). */
  obs: RowObserver | null;
}

/** What the compiler emits for a `<For>`: the row template and how to fill it. */
export interface ForSpec<T, K> {
  /** The rows (read in an effect: the list renders again when it changes). */
  readonly each: () => readonly T[];
  readonly key: (item: T) => K;
  /** The row template. */
  readonly t: Template;
  /** Write the values of the holes that read only the row into `v`, by hole index. */
  readonly fill: (item: T, v: unknown[]) => void;
  /** Indexes of those holes. */
  readonly holes: readonly number[];
  /** Write the values of the reactive holes into `v` (in their order, from 0). */
  readonly dyn?: (item: T, v: unknown[]) => void;
  /** The template hole of each reactive value. */
  readonly dynHoles?: readonly number[];
  /** Delegated handlers: [event type, hole of the element, handler of the row]. */
  readonly events?: readonly (readonly [string, number, (item: T) => (e: Event) => void])[];
  /**
   * With `__forMount`: the parts of a row that create something of their own (a slot, a nested
   * list, a property, a style, a ref, spread props), as [hole, part]. Each part runs with the
   * row's item and the hole's node, under the row's owner, when the row is created and again
   * when it gets a new item.
   */
  readonly mounts?: readonly (readonly [number, (item: T, node: Node) => void])[];
}

/** A row of a `__forMount` list: a row, plus the owner of what its mounts created. */
interface MountRow<T> extends Row<T> {
  own: Owner;
}

/**
 * The observer of one row whose reactive holes read a signal. When one of
 * those signals changes, the row's reactive holes run again.
 */
class RowObserver implements Observer {
  readonly list: ForList<unknown, unknown>;
  readonly entry: Row<unknown>;
  private sources: Source[] = [];
  q = false;
  constructor(list: ForList<unknown, unknown>, entry: Row<unknown>) {
    this.list = list;
    this.entry = entry;
  }
  read(s: Source): void {
    if (this.sources.includes(s)) return;
    this.sources.push(s);
    s.subs.push(this);
  }
  stale(): void {
    this.list.refresh(this.entry);
  }
  /** Unsubscribe from every source: before a re-run, and when the row leaves the list. */
  drop(): void {
    for (const s of this.sources) {
      const j = s.subs.indexOf(this);
      if (j >= 0) s.subs.splice(j, 1);
    }
    this.sources = [];
  }
}

/**
 * The observer a row's reactive holes run under. A selector read records
 * the key on the row; a signal read makes the row an observer of its own.
 * One instance serves every row of every list: `runDyn` points it at the
 * row being run, so running a row allocates nothing.
 */
class RowContext implements Reader {
  list!: ForList<unknown, unknown>;
  entry!: Row<unknown>;
  // Only a reader, never notified itself: signals subscribe the row's own RowObserver.
  read(s: Source): void {
    // Created on the first signal read: a row that reads only a selector, or
    // nothing reactive, never pays for an observer.
    let o = this.entry.obs;
    if (o === null) o = this.entry.obs = new RowObserver(this.list, this.entry);
    o.read(s);
  }
}
const rowContext = new RowContext();

/**
 * The runtime of one `<For>`: a @reactre/dom List of rows, plus what keeps
 * the rows' holes current (item updates, signal reads, selector changes)
 * and the delegated event listeners.
 */
class ForList<T, K> {
  readonly spec: ForSpec<T, K>;
  readonly list: List<T, Row<T>, K & (string | number)>;
  readonly parent: Element;
  /** Scratch values for every hole, reused for each row created or updated. */
  protected readonly v: unknown[];
  /** Scratch for reactive values, and for an old item's values during an update. */
  private readonly dv: unknown[] = [];
  /** Number of reactive holes. */
  private readonly nd: number;
  /** Whether a row has ever asked several selector pairs: then changes take the slower scan. */
  many = false;
  /** The selectors whose `lists` hold this list. */
  readonly sels: Selector<unknown>[] = [];

  constructor(parent: Element, anchor: Node | null, spec: ForSpec<T, K>) {
    this.spec = spec;
    this.parent = parent;
    this.v = new Array(spec.t.n).fill("");
    this.nd = spec.dynHoles?.length ?? 0;
    // With no anchor the list is the parent's only content: it can clear the
    // parent natively and build it detached.
    const owns = anchor === null;
    this.list = new List<T, Row<T>, K & (string | number)>(parent, {
      key: spec.key as (item: T) => K & (string | number),
      create: (item) => this.create(item),
      update: (e, item) => this.update(e, item),
      anchor,
      owns,
      detach: owns,
      // Safe here: a row's reactive holes follow signals through their own
      // observers, so `update` depends on nothing but the item.
      skipUnchanged: true,
      remove: (e) => this.dispose(e),
    });
    if (spec.events) {
      // One listener per event type, with that type's holes and handlers.
      const byType = new Map<string, [number[], ((item: T) => (e: Event) => void)[]]>();
      for (const [type, hole, h] of spec.events) {
        let t = byType.get(type);
        if (t === undefined) byType.set(type, (t = [[], []]));
        t[0].push(hole);
        t[1].push(h);
      }
      for (const [type, [holes, hs]] of byType) this.listen(type, holes, hs);
    }
  }

  /** Build a row: compute its values, then clone the template with them baked in. */
  protected create(item: T): Row<T> {
    const spec = this.spec,
      v = this.v;
    spec.fill(item, v);
    // The row object exists before its element so that running the reactive
    // holes can record the row's selector key and observer on it. `root` is
    // set right after the clone; it is in the literal so the shape is final.
    const e: Row<T> = {
      root: null as unknown as Element,
      item,
      nodes: null,
      dv: null,
      sel: null,
      sk: undefined,
      obs: null,
    };
    if (this.nd) {
      const dv = this.dv;
      this.runDyn(e, item, dv);
      const holes = spec.dynHoles!;
      for (let i = 0; i < holes.length; i++) v[holes[i]!] = dv[i];
      // `this.dv` is shared scratch: the row keeps its own copy.
      e.dv = dv.slice(0, this.nd);
    }
    // No Block per row: the clone is born with its values, and hole nodes are
    // looked up only when one is first written (see `node`).
    (e as { root: Element }).root = spec.t.clone(v as never);
    return e;
  }

  /** Run the reactive holes of row `e` for `item` into `out`, recording what they read. */
  private runDyn(e: Row<T>, item: T, out: unknown[]): void {
    // Saved and restored, so runs can nest: a reactive hole may build rows of
    // another list while this row runs.
    const o = current,
      pl = rowContext.list,
      pe = rowContext.entry;
    if (e.obs !== null) e.obs.drop();
    rowContext.list = this as ForList<unknown, unknown>;
    rowContext.entry = e as Row<unknown>;
    current = rowContext;
    try {
      this.spec.dyn!(item, out);
    } finally {
      current = o;
      rowContext.list = pl;
      rowContext.entry = pe;
    }
  }

  /** Give row `e` a new item of the same key: write the holes whose values changed. */
  protected update(e: Row<T>, item: T): void {
    const spec = this.spec,
      old = e.item,
      v = this.v,
      w = this.dv;
    e.item = item;
    // The row's own holes: written where the new item's value differs.
    // Rows keep no copy of these values, so the old item's are computed again.
    spec.fill(old, w);
    spec.fill(item, v);
    const holes = spec.holes;
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i]!;
      if (v[h] !== w[h]) this.write(e, h, v[h]);
    }
    // `refresh` overwrites `this.dv` (w here); the loop above is done with it.
    if (this.nd) this.refresh(e);
  }

  /** Run row e's reactive holes again and write those that changed. */
  refresh(e: Row<T>): void {
    const dv = this.dv,
      prev = e.dv!,
      holes = this.spec.dynHoles!;
    // The run records the selectors it asks afresh, as an observer's run records its sources.
    e.sel = null;
    this.runDyn(e, e.item, dv);
    for (let i = 0; i < holes.length; i++) {
      if (dv[i] !== prev[i]) {
        prev[i] = dv[i];
        this.write(e, holes[i]!, dv[i]);
      }
    }
  }

  private write(e: Row<T>, hole: number, value: unknown): void {
    this.spec.t.write(hole, this.node(e, hole), value);
  }

  /**
   * Row e's node for one hole, looked up (that hole only) the first time. A
   * row that is never written is never walked from JavaScript.
   */
  protected node(e: Row<T>, hole: number): Node {
    let nodes = e.nodes;
    if (nodes === null) nodes = e.nodes = [];
    let n = nodes[hole] as Node | undefined;
    if (n === undefined) {
      // One compiled locator per hole, shared by every row of the list.
      (this.finders[hole] ??= this.spec.t.locator([hole]))(e.root, nodes);
      n = nodes[hole] as Node;
    }
    return n;
  }
  /** Single-hole locators, by hole index, compiled on first use. */
  private readonly finders: ((root: Node, out: unknown[]) => void)[] = [];

  /** A row leaves the list: unsubscribe it, so it stops re-running. */
  protected dispose(e: Row<T>): void {
    if (e.obs !== null) e.obs.drop();
  }

  /**
   * The list's owner is disposed (a slot replaced it, or `render`'s disposer ran): its rows
   * leave, its listeners go, and its selectors forget it.
   */
  destroy(): void {
    this.list.clear();
    for (const [type, fn, capture] of this.listeners) this.parent.removeEventListener(type, fn, capture);
    for (const sel of this.sels) sel.lists.splice(sel.lists.indexOf(this as ForList<unknown, unknown>), 1);
  }
  /** The delegated listeners, for `destroy`. */
  private readonly listeners: [string, (ev: Event) => void, boolean][] = [];

  /** A selector this list's rows asked has moved from prev to next. */
  selectorChanged(sel: Selector<unknown>, prev: unknown, next: unknown): void {
    const es = this.list.entries;
    if (this.many) {
      this.selectorChangedMany(sel, prev, next);
      return;
    }
    for (let i = 0; i < es.length; i++) {
      const e = es[i]!;
      if (e.sel === sel && (e.sk === prev || e.sk === next)) this.refresh(e);
    }
  }

  /** `selectorChanged` for a list where some row has asked several pairs. */
  private selectorChangedMany(sel: Selector<unknown>, prev: unknown, next: unknown): void {
    // The rows to refresh are found first: a refresh rewrites the pairs it scans.
    const hit: Row<T>[] = [],
      es = this.list.entries;
    for (let i = 0; i < es.length; i++) {
      const e = es[i]!;
      if (e.sel === sel) {
        if (e.sk === prev || e.sk === next) hit.push(e);
      } else if (e.sel === MANY) {
        const pairs = e.sk as unknown[];
        for (let j = 0; j < pairs.length; j += 2) {
          if (pairs[j] === sel && (pairs[j + 1] === prev || pairs[j + 1] === next)) {
            hit.push(e);
            break;
          }
        }
      }
    }
    for (let i = 0; i < hit.length; i++) this.refresh(hit[i]!);
  }

  /** Render the rows for `items`. */
  render(items: readonly T[]): void {
    this.list.set(items);
  }

  /**
   * One listener per event type on the list's parent: the row is the
   * parent's child the event came through, its handler the one of the
   * innermost element with a handler for the type. `holes[i]` holds the
   * element `hs[i]` handles.
   */
  private listen(type: string, holes: number[], hs: ((item: T) => (e: Event) => void)[]): void {
    const parent = this.parent;
    // An event that does not bubble still passes the parent on its way down: it is caught there.
    const capture = NO_BUBBLE.has(type);
    const fn = (ev: Event): void => {
      // Climb from the target to the parent's child, keeping the path:
      // path[0] is the innermost element.
      let node = ev.target as Node | null;
      const path: Node[] = [];
      while (node !== null && node.parentNode !== parent) {
        path.push(node);
        node = node.parentNode;
      }
      if (node === null) return;
      // Rows carry no link from element to row: a WeakMap entry or expando
      // per row slows creation and native clearing. A scan finds the row.
      const es = this.list.entries;
      let e: Row<T> | undefined;
      for (let i = 0; i < es.length; i++) {
        if (es[i]!.root === node) {
          e = es[i];
          break;
        }
      }
      if (e === undefined) return;
      path.push(node);
      for (let p = 0; p < path.length; p++) {
        for (let i = 0; i < holes.length; i++) {
          if (this.node(e, holes[i]!) === path[p]) {
            const row = e;
            // Batched: a handler that sets several signals re-renders once.
            batch(() => hs[i]!(row.item)(ev));
            return;
          }
        }
      }
    };
    parent.addEventListener(type, fn, capture);
    this.listeners.push([type, fn, capture]);
  }
}

/** Events that do not bubble, which a list delegates in the capture phase. */
const NO_BUBBLE = new Set([
  "focus",
  "blur",
  "mouseenter",
  "mouseleave",
  "pointerenter",
  "pointerleave",
  "load",
  "error",
  "scroll",
  "scrollend",
  "toggle",
  "invalid",
  "play",
  "pause",
  "ended",
  "volumechange",
  "timeupdate",
]);

/**
 * A `<For>` whose rows hold mounts (see `ForSpec.mounts`). Each row gets an owner; its mounts
 * run under it at creation, again (after it is cleaned) when the row gets a new item, and it
 * is cleaned when the row leaves. A subclass, so that lists of host-only rows run the plain
 * create, update and dispose with no check for mounts.
 */
class MountList<T, K> extends ForList<T, K> {
  constructor(parent: Element, anchor: Node | null, spec: ForSpec<T, K>) {
    super(parent, anchor, spec);
    // A mount's hole is never filled: null is what the prototype holds for an attribute hole,
    // so the clone writes nothing there.
    for (const [hole] of spec.mounts!) this.v[hole] = null;
  }
  protected override create(item: T): Row<T> {
    const e = super.create(item) as MountRow<T>;
    e.own = new Owner();
    this.mount(e);
    return e;
  }
  protected override update(e: Row<T>, item: T): void {
    const fresh = e.item !== item;
    super.update(e, item);
    if (fresh) {
      (e as MountRow<T>).own.clean();
      this.mount(e as MountRow<T>);
    }
  }
  protected override dispose(e: Row<T>): void {
    super.dispose(e);
    (e as MountRow<T>).own.clean();
  }
  private mount(e: MountRow<T>): void {
    const ms = this.spec.mounts!;
    within(e.own, () => {
      for (let i = 0; i < ms.length; i++) ms[i]![1](e.item, this.node(e, ms[i]![0]));
    });
  }
}

// #endregion

// #region What compiled code calls

/** Internal: a template from markup strings and hole markers (@reactre/compiler). */
export function __template(strings: readonly string[], holes: readonly number[], svg?: boolean): Template {
  return new Template(strings, holes, svg);
}

/** Internal: a `<For>` in `parent`, before `anchor` (null: the list is the parent's only content). */
export function __for<T, K>(parent: Element, anchor: Node | null, spec: ForSpec<T, K>): void {
  start(new ForList<T, K>(parent, anchor, spec), spec);
}

/** Internal: a `<For>` whose rows hold mounts (`spec.mounts`): see `__for`. */
export function __forMount<T, K>(parent: Element, anchor: Node | null, spec: ForSpec<T, K>): void {
  start(new MountList<T, K>(parent, anchor, spec), spec);
}

/** Render list `l` now and whenever `spec.each` changes; it is destroyed with the current owner. */
function start<T, K>(l: ForList<T, K>, spec: ForSpec<T, K>): void {
  if (owner !== null) onCleanup(() => l.destroy());
  // Rendering the rows reads the rows' items, not what the rows read: only
  // `each` is this effect's dependency.
  effect(() => {
    const items = spec.each();
    untrack(() => l.render(items));
  });
}

/**
 * Internal: put `value` (a node, an array of nodes, text, or nothing) before
 * `anchor`, replacing what it put there before.
 *
 * null, undefined, true and false render nothing. Any other non-node value
 * becomes a text node, so it is never parsed as HTML. Nested arrays are
 * flattened.
 *
 * @param prev What the last call returned for this anchor; those nodes are removed first.
 * @returns The nodes inserted, to pass back as `prev` next time; null when there are none.
 */
export function __insert(anchor: Node, value: unknown, prev: Node[] | null): Node[] | null {
  const parent = anchor.parentNode!;
  // A node may have left already: a slot inside a fragment removes its own content when disposed.
  if (prev !== null) for (const n of prev) if (n.parentNode === parent) parent.removeChild(n);
  if (value == null || value === false || value === true) return null;
  const out: Node[] = [];
  const add = (x: unknown): void => {
    if (x == null || x === false || x === true) return;
    if (Array.isArray(x)) {
      for (const y of x) add(y);
      return;
    }
    const n = typeof x === "object" && "nodeType" in (x as object) ? (x as Node) : document.createTextNode("" + x);
    parent.insertBefore(n, anchor);
    out.push(n);
  };
  add(value);
  return out;
}

/** Internal: a hole whose value may change: written now and whenever what it reads changes. */
export function __bind(t: Template, hole: number, node: Node, value: () => unknown): void {
  // NONE matches no value, so the first run writes even undefined.
  let last: unknown = NONE;
  effect(() => {
    const v = value();
    if (v !== last) {
      last = v;
      t.write(hole, node, v);
    }
  });
}

/** Internal: a slot whose content may change (a component's or a function's result). */
export function __slot(anchor: Node, value: () => unknown): void {
  let prev: Node[] | null = null;
  // Disposed with its owner, the slot takes its content out: the owner's own nodes may be
  // removed by a snapshot taken before this content came (a fragment's, a row's mount).
  if (owner !== null)
    onCleanup(() => {
      if (prev !== null) for (const n of prev) n.parentNode?.removeChild(n);
      prev = null;
    });
  effect(() => {
    // Only `value()` is this effect's dependency; inserting is untracked.
    const v = value();
    prev = untrack(() => __insert(anchor, v, prev));
  });
}

/**
 * Internal: a fragment's nodes, as an array, built in a document fragment. A child that is a
 * function may change: it becomes a slot. Any other child is inserted once, as `__insert` would.
 */
export function __frag(kids: readonly unknown[]): Node[] {
  const f = document.createDocumentFragment();
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    const a = f.appendChild(document.createTextNode(""));
    if (typeof k === "function") __slot(a, k as () => unknown);
    else {
      __insert(a, k, null);
      f.removeChild(a);
    }
  }
  return Array.from(f.childNodes);
}

/**
 * Internal: apply `value()` to `node` with `set` (`__style`, `__spread`), now and whenever what
 * it reads changes; `set` gets the last value too, to undo what the new one leaves out.
 */
export function __apply(node: Node, set: (node: Node, v: unknown, prev: unknown) => void, value: () => unknown): void {
  let prev: unknown;
  effect(() => {
    const v = value();
    set(node, v, prev);
    prev = v;
  });
}

/** A style object's property name in CSS: `fontSize` is `font-size`; a custom property is kept. */
const cssName = (k: string): string => (k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));

/**
 * Internal: an element's `style`: a string is its whole inline style; an object sets each
 * property by name (camelCase or CSS, custom properties included). Values are written as given:
 * a number gets no unit. null, undefined and false remove a property.
 */
export function __style(node: Node, v: unknown, prev: unknown): void {
  const s = (node as HTMLElement).style;
  if (v == null || typeof v !== "object") {
    s.cssText = v == null ? "" : "" + (v as string);
    return;
  }
  const next = v as Record<string, unknown>;
  let last: Record<string, unknown>;
  if (prev != null && typeof prev === "object") last = prev as Record<string, unknown>;
  else {
    // From a string (or nothing): start clean.
    s.cssText = "";
    last = {};
  }
  for (const k in last) if (!(k in next)) s.removeProperty(cssName(k));
  for (const k in next) {
    const x = next[k];
    if (x === last[k]) continue;
    if (x == null || x === false) s.removeProperty(cssName(k));
    else s.setProperty(cssName(k), "" + (x as string));
  }
}

/** Internal: give element `node` to a ref: a function is called with it, an object gets it as `current`. */
export function __ref(node: Node, r: unknown): void {
  if (typeof r === "function") (r as (n: Node) => void)(node);
  else if (r != null) (r as { current: unknown }).current = node;
}

/**
 * Internal: an element's spread props, applied as the compiler applies props: `on*` handlers as
 * listeners, `class` and `className`, `style`, `ref`, `value`, `checked` and `selected` as
 * properties, and anything else as an attribute (null, undefined and false remove it, true sets
 * it empty). Props the last object had and this one lacks are undone.
 */
export function __spread(node: Node, v: unknown, prev: unknown): void {
  const next = (v ?? {}) as Record<string, unknown>,
    last = (prev ?? {}) as Record<string, unknown>;
  for (const k in last) if (!(k in next)) prop(node as Element, k, undefined, last[k]);
  for (const k in next) if (next[k] !== last[k]) prop(node as Element, k, next[k], last[k]);
}

/** One spread prop `k`: from `old` to `v`. */
function prop(el: Element, k: string, v: unknown, old: unknown): void {
  if (k === "children" || k === "key") return;
  if (k === "ref") return __ref(el, v);
  if (k === "style") return __style(el, v, old);
  if (/^on[A-Z]/.test(k)) {
    const type = k.slice(2).toLowerCase();
    if (typeof old === "function") el.removeEventListener(type, old as EventListener);
    if (typeof v === "function") el.addEventListener(type, v as EventListener);
    return;
  }
  if (k === "value" || k === "checked" || k === "selected") {
    (el as unknown as Record<string, unknown>)[k] = v;
    return;
  }
  const name = k === "className" ? "class" : k === "htmlFor" ? "for" : k;
  if (name === "class" && el.namespaceURI !== "http://www.w3.org/2000/svg")
    el.className = v == null ? "" : "" + (v as string);
  else if (v == null || v === false) el.removeAttribute(name);
  else el.setAttribute(name, v === true ? "" : "" + (v as string));
}

/**
 * Internal: a handler that may change (its expression reads a signal): one listener calls the
 * handler `value()` gave last.
 */
export function __on(node: Node, type: string, value: () => unknown): void {
  let h: unknown = null;
  effect(() => {
    h = value();
  });
  node.addEventListener(type, function (this: Node, e: Event) {
    if (typeof h === "function") (h as (this: Node, e: Event) => void).call(this, e);
  });
}

/** The "no value yet" sentinel of `__bind`. */
const NONE = Symbol("none");

// #endregion

// #region Rendering

/**
 * Render the component `view` into `parent`, after what it holds. Components run once.
 * Returns a function that disposes the view: its effects stop, its cleanups
 * run, and its nodes leave `parent`.
 *
 * The component's own body is untracked: a signal it reads directly does not
 * re-run it. Only the holes and slots inside the markup follow signals.
 *
 * @example
 *   const [count, setCount] = signal(0);
 *   const App = () => <button onClick={() => setCount((c) => c + 1)}>{count()}</button>;
 *   render(App, document.body);
 */
export function render(view: () => unknown, parent: Element): () => void {
  // An empty text node marks where the content goes, after existing children.
  const anchor = document.createTextNode("");
  parent.appendChild(anchor);
  // The view's effects belong to one root, which the returned function disposes.
  const root = new Owner();
  const nodes = within(root, () => __insert(anchor, view(), null));
  return () => {
    root.dispose();
    if (nodes !== null) for (const n of nodes) n.parentNode?.removeChild(n);
    anchor.parentNode?.removeChild(anchor);
  };
}

/**
 * `<For each key>`: a keyed list; compiled away, so only its type is used.
 * Calling it at runtime throws: the source was not compiled by @reactre/compiler.
 *
 * Rows are keyed by `key`, reused across renders and moved with the fewest
 * DOM moves. A row's markup is built once, when its key first appears; its
 * holes that read only the item are compared when the list renders it again
 * with a new item.
 *
 * @example
 *   <tbody>
 *     <For each={rows()} key={(row) => row.id}>
 *       {(row) => <tr><td>{row.label}</td></tr>}
 *     </For>
 *   </tbody>
 */
export function For<T>(_props: {
  each: readonly T[];
  key: (item: T) => string | number;
  children: (item: T) => unknown;
}): unknown {
  throw new Error("reactre: <For> must be compiled by @reactre/compiler");
}

// #endregion
