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
//     stops the old content's effects. `attach` returns the root's disposer.
//   - An app ships only what it uses. Ownership comes with what owns (see
//     "Ownership"); rows with several selector keys come with
//     @reactre/core/features/selectors. The benchmark app ships neither.
//   - Solid 2.0's owner and timing APIs are feature modules, since they are runtime functions
//     and not compiled away: @reactre/core/features/owner (`createRoot`, `getOwner`,
//     `runWithOwner`), features/timing (`onSettled`, `flush`) and features/reaction. They build
//     on the `__` internals below and hook into nothing that runs without them.
//   - Control flow (<Show>, <Switch>/<Match>, <Repeat>, <Portal>, <Dynamic>) is in ./flow.ts,
//     compiled away as <For> is. `dynamic()`, which runs, is @reactre/core/features/dynamic.
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

import { List, Prototype } from "@reactre/dom";

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
/** Depth of nested `batch` calls; observers are deferred while it is above 0. */
let batching = 0;
/** Observers notified during a batch, in first-notified order, each once (its `q` flag says so). */
const pending: Observer[] = [];
/** The next of `pending` to run: the ones before it have run (or are running). */
let head = 0;

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
    // effect notifies its observers at once instead of queueing behind it. A
    // run that opens a batch of its own queues behind the rest, and its batch's
    // end drains the one queue, in order. Each observer leaves the queue (`head`
    // passes it) before it runs: one that throws leaves the rest queued, still
    // flagged, for the next flush.
    if (--batching === 0) {
      while (head < pending.length) {
        const o = pending[head++]!;
        o.q = false;
        o.stale();
      }
      pending.length = head = 0;
    }
  }
}

/**
 * Internal (@reactre/core/features/timing's `flush`): drain the queue now, even inside a batch.
 * It runs with `batching` at 0, as the outermost batch's end does, so that the effects it runs
 * apply their own writes at once; then `batching` is put back.
 */
export function __drain(): void {
  const b = batching;
  batching = 0;
  try {
    batch(() => {});
  } finally {
    batching = b;
  }
}

/** Internal: the batch queue and where it stands, read by @reactre/core/features/timing. */
export { batching as __batching, head as __head, pending as __pending };

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
  DIRTY = 2;
/** Runs in a row after which an effect that keeps changing what it reads is a cycle. */
const MAX_RUNS = 100;

/** An effect: a function re-run whenever a source it read last time changes. */
class Effect implements Observer {
  protected readonly fn: () => void;
  private sources: Source[] = [];
  q = false;
  private state = IDLE;
  constructor(fn: () => void) {
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
    else this.state = DIRTY;
  }
  /** Run, and again while a run was notified (it wrote what it read), up to MAX_RUNS in a row. */
  run(): void {
    for (let n = 0; n < MAX_RUNS; n++) {
      this.state = RUNNING;
      try {
        this.once();
      } catch (err) {
        this.state = IDLE;
        throw err;
      }
      if (this.state === RUNNING) {
        this.state = IDLE;
        return;
      }
    }
    this.state = IDLE;
    throw new Error("reactre: an effect writes a signal it reads, so it never settles");
  }
  /** One run of `fn` as the current observer, after dropping the sources of the last run. */
  protected once(): void {
    this.drop();
    const o = current;
    current = this;
    try {
      this.fn();
    } finally {
      current = o;
    }
  }
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
}

/**
 * The class the runtime's own effects (holes, lists, selectors) are made of: Effect, or
 * OwnedEffect once the bundle holds anything that owns (see "Ownership"), so that those
 * effects belong to the owner they are made in.
 */
let Eff: new (fn: () => void) => Effect = Effect;

/** One of the runtime's own effects: run `fn` now and whenever what it read changes. */
function track(fn: () => void): void {
  new Eff(fn).run();
}

// #endregion

// #region Ownership

// What effects and cleanups belong to: an effect's run, a `<For>` row with mounts, or an
// `attach`. Disposing an owner disposes what it owns, deepest first, and runs its cleanups. An
// effect cleans itself before each re-run, so what one run made is gone before the next makes
// its own.
//
// An app pays for owners only when it makes one. Everything here is reached from `Owned`,
// whose initializer installs it, and `Owned` is used only by what makes an owner: `effect`,
// `memo`, a slot (`__slot`, and `__frag` through it), a row with mounts (`__forMount`) and
// `attach`. A bundle with none of them (the benchmark app's) drops the lot, and its effects are
// plain Effects with `owner` null throughout, which is right: with nothing that disposes, no
// effect is ever made inside another's run. `onCleanup` reads only `owner`, so it costs a few
// bytes and does nothing until something owns.

/** An owner: what it owns, and its cleanups. Both stay null until something is owned. */
interface Owner {
  owned: Owner[] | null;
  cleanups: (() => void)[] | null;
  dispose(): void;
}

/** The owner that effects and cleanups made now belong to; null outside any (nothing disposes them). */
let owner: Owner | null = null;

/** Dispose what `o` owns and run its cleanups, then forget both. */
function clean(o: Owner): void {
  const owned = o.owned,
    c = o.cleanups;
  o.owned = null;
  o.cleanups = null;
  if (owned !== null) for (let i = 0; i < owned.length; i++) owned[i]!.dispose();
  if (c !== null) for (let i = 0; i < c.length; i++) c[i]!();
}

/** An owner that is not an effect: an `attach` root, or a row with mounts. */
class Root implements Owner {
  owned: Owner[] | null = null;
  cleanups: (() => void)[] | null = null;
  dispose(): void {
    clean(this);
  }
}

/** An effect that owns what its run makes, and belongs to the owner it was made in. */
class OwnedEffect extends Effect implements Owner {
  owned: Owner[] | null = null;
  cleanups: (() => void)[] | null = null;
  private dead = false;
  constructor(fn: () => void) {
    super(fn);
    if (owner !== null) (owner.owned ??= []).push(this);
  }
  override stale(): void {
    // Disposed while queued in a batch: it does not run.
    if (!this.dead) super.stale();
  }
  protected override once(): void {
    if (this.dead) return;
    // What the last run made is gone: this run makes its own.
    if (this.owned !== null || this.cleanups !== null) clean(this);
    const ow = owner;
    owner = this;
    try {
      super.once();
    } finally {
      owner = ow;
    }
  }
  /** Stop for good: unsubscribe, and dispose what the last run made. */
  dispose(): void {
    this.dead = true;
    this.drop();
    clean(this);
  }
  /** Run `fn` with `o` as the owner and no reader: what it creates belongs to `o`. */
  static within<T>(o: Owner | null, fn: () => T): T {
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
}

/** Makes list `l` disposed with the current owner; set once ownership is installed. */
let ownList: ((l: ForList<unknown, unknown>) => void) | null = null;

/** Make the runtime's effects owned, and lists disposable with their owner. */
function installOwners(): typeof OwnedEffect {
  Eff = OwnedEffect;
  ownList = (l) => onCleanup(() => destroy(l));
  return OwnedEffect;
}

/** Ownership, installed as the module loads; dropped from a bundle that never uses it. */
const Owned: typeof OwnedEffect = /* @__PURE__ */ installOwners();

/**
 * Run `fn` when the current owner is disposed or re-runs: in an effect,
 * before its next run; in a component, when the slot or row holding it
 * replaces it, or when `attach`'s disposer is called. Outside any owner (at
 * module scope, or in a view given to `render`) it does nothing, since
 * nothing would ever call it.
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

/**
 * Internal (@reactre/core/features/owner's `runWithOwner`): make `o` the current owner, and
 * return the one it replaces, to put back. Brings no part of ownership with it.
 */
export function __swapOwner(o: Owner | null): Owner | null {
  const p = owner;
  owner = o;
  return p;
}

/**
 * Internal: the current owner, the root owner class, and ownership itself (`Owned.within`), for
 * @reactre/core/features/owner. Only what uses `__Owned` brings ownership.
 */
export { owner as __owner, Root as __Root, Owned as __Owned };

/**
 * Run `fn` now and again whenever a signal it read changes. Each run records
 * its reads afresh, so conditional reads are tracked as they happen. It owns
 * the effects and cleanups its run makes, and disposes them before it re-runs.
 *
 * @example
 *   const [name, setName] = signal("a");
 *   effect(() => (document.title = name()));
 *   setName("b"); // the title is now "b"
 */
export function effect(fn: () => void): void {
  new Owned(fn).run();
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
  track(() => {
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

/**
 * A selector's state: its current key and who asked about which key.
 *
 * Rows of a `<For>` are not subscribed one by one. A row records the
 * selector and the key it asked about on itself, and the selector keeps only
 * the list, once. On a change, each list scans its rows for the two keys:
 * one comparison per row, no subscription objects at all. A row that asks
 * more than one (selector, key) pair needs @reactre/core/features/selectors
 * (see "Rows with several selector keys").
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
  readonly byKey = new Map<K, Source>();
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
    if (src === undefined) this.byKey.set(k, (src = { subs: [] }));
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

// #endregion

// #region Rows with several selector keys

// A row that asks more than one (selector, key) pair keeps them all: `sel` is MANY and `sk`
// holds the pairs, flat, [selector, key, selector, key, ...], and its list scans rows for them on
// a change. @reactre/core/features/selectors installs this (`__installSelectors`); the compiler
// imports that module itself for a row whose reactive holes make two or more calls with
// arguments. Until it is installed, a second pair throws: a row that reads a selector through a
// function of its own is the case the compiler cannot see.

/** Row `e` of `list` asks about a second (or later) pair `sel`, `k`. */
let more = (_list: ForList<unknown, unknown>, _e: Row<unknown>, _sel: Selector<unknown>, _k: unknown): void => {
  throw new Error(
    'reactre: a <For> row read a second selector key; import "@reactre/core/features/selectors" to allow it',
  );
};
/** `selectorChanged` for a list where some row has asked several pairs; set with `more`. */
let scanMany: ((list: ForList<unknown, unknown>, sel: Selector<unknown>, prev: unknown, next: unknown) => void) | null =
  null;

/** Stands in a row's `sel` when the row asked more than one (selector, key) pair. */
const MANY = {} as Selector<unknown>;

/** Internal: allow rows with several selector keys (@reactre/core/features/selectors calls it). */
export function __installSelectors(): void {
  more = (list, e, sel, k) => {
    if (e.sel !== MANY) {
      e.sk = [e.sel, e.sk];
      e.sel = MANY;
      list.many = true;
    }
    const pairs = e.sk as unknown[];
    for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === sel && pairs[i + 1] === k) return;
    pairs.push(sel, k);
  };
  scanMany = (list, sel, prev, next) => {
    // The rows to refresh are found first: a refresh rewrites the pairs it scans.
    const hit: Row<unknown>[] = [],
      es = list.list.entries;
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
    for (let i = 0; i < hit.length; i++) list.refresh(hit[i]!);
  };
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
  readonly t: Prototype;
  /** Write the values of the holes that read only the row into `v`, by hole index. */
  readonly fill: (item: T, v: unknown[]) => void;
  /** Indexes of those holes. */
  readonly holes: readonly number[];
  /** Write the values of the reactive holes into `v` (in their order, from 0). */
  readonly dyn?: (item: T, v: unknown[]) => void;
  /** The template hole of each reactive value. */
  readonly dynHoles?: readonly number[];
  /**
   * Delegated handlers: [event type, hole of the element, handler of the row], and 1 for an
   * event that does not bubble, which the list catches in the capture phase.
   */
  readonly events?: readonly (readonly [string, number, (item: T) => (e: Event) => void, 1?])[];
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
  own: Root;
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
  /** Whether a row has ever asked several selector pairs: then changes take the slower scan (`scanMany`). */
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
      const byType = new Map<string, [number[], ((item: T) => (e: Event) => void)[], boolean]>();
      for (const [type, hole, h, capture] of spec.events) {
        let t = byType.get(type);
        if (t === undefined) byType.set(type, (t = [[], [], capture === 1]));
        t[0].push(hole);
        t[1].push(h);
      }
      for (const [type, [holes, hs, capture]] of byType) this.listen(type, holes, hs, capture);
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

  /** A selector this list's rows asked has moved from prev to next. */
  selectorChanged(sel: Selector<unknown>, prev: unknown, next: unknown): void {
    const es = this.list.entries;
    if (this.many) return scanMany!(this as ForList<unknown, unknown>, sel, prev, next);
    for (let i = 0; i < es.length; i++) {
      const e = es[i]!;
      if (e.sel === sel && (e.sk === prev || e.sk === next)) this.refresh(e);
    }
  }

  /** Render the rows for `items`. */
  render(items: readonly T[]): void {
    this.list.set(items);
  }

  /**
   * One listener per event type on the list's parent: the row is the
   * parent's child the event came through, its handler the one of the
   * innermost element with a handler for the type. `holes[i]` holds the
   * element `hs[i]` handles. An event that does not bubble (`capture`, as the compiler
   * marks it) still passes the parent on its way down: it is caught there.
   */
  private listen(type: string, holes: number[], hs: ((item: T) => (e: Event) => void)[], capture: boolean): void {
    const parent = this.parent;
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
  /** The delegated listeners, for `destroy`. */
  readonly listeners: [string, (ev: Event) => void, boolean][] = [];
}

/**
 * List `l`'s owner is disposed (a slot replaced it, or `attach`'s disposer ran): its rows
 * leave, its listeners go, and its selectors forget it. Reached only through `ownList`.
 */
function destroy(l: ForList<unknown, unknown>): void {
  l.list.clear();
  for (const [type, fn, capture] of l.listeners) l.parent.removeEventListener(type, fn, capture);
  for (const sel of l.sels) sel.lists.splice(sel.lists.indexOf(l), 1);
}

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
    e.own = new Root();
    this.mount(e);
    return e;
  }
  protected override update(e: Row<T>, item: T): void {
    const fresh = e.item !== item;
    super.update(e, item);
    if (fresh) {
      clean((e as MountRow<T>).own);
      this.mount(e as MountRow<T>);
    }
  }
  protected override dispose(e: Row<T>): void {
    super.dispose(e);
    clean((e as MountRow<T>).own);
  }
  private mount(e: MountRow<T>): void {
    const ms = this.spec.mounts!;
    Owned.within(e.own, () => {
      for (let i = 0; i < ms.length; i++) ms[i]![1](e.item, this.node(e, ms[i]![0]));
    });
  }
}

// #endregion

// #region What compiled code calls

/** Internal: a template from markup strings and hole markers (@reactre/compiler). */
export function __template(strings: readonly string[], holes: readonly number[], svg?: boolean): Prototype {
  return new Prototype(strings, holes, svg);
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
  // A current owner means ownership is installed, and `ownList` with it.
  if (owner !== null) ownList!(l as ForList<unknown, unknown>);
  // Rendering the rows reads the rows' items, not what the rows read: only
  // `each` is this effect's dependency.
  track(() => {
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
export function __bind(t: Prototype, hole: number, node: Node, value: () => unknown): void {
  // NONE matches no value, so the first run writes even undefined.
  let last: unknown = NONE;
  track(() => {
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
  // Owned: each run disposes what the last run's content made.
  new Owned(() => {
    // Only `value()` is this effect's dependency; inserting is untracked.
    const v = value();
    prev = untrack(() => __insert(anchor, v, prev));
  }).run();
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
  track(() => {
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
  track(() => {
    h = value();
  });
  node.addEventListener(type, function (this: Node, e: Event) {
    if (typeof h === "function") (h as (this: Node, e: Event) => void).call(this, e);
  });
}

/** The "no value yet" sentinel of `__bind`. */
const NONE = /* @__PURE__ */ Symbol("none");

// #endregion

// #region Rendering

/**
 * Render the component `view` into `parent`, after what it holds, for good. Components run
 * once. Use `attach` for a view you will take out again.
 *
 * The component's own body is untracked: a signal it reads directly does not
 * re-run it. Only the holes and slots inside the markup follow signals.
 *
 * @example
 *   const [count, setCount] = signal(0);
 *   const App = () => <button onClick={() => setCount((c) => c + 1)}>{count()}</button>;
 *   render(App, document.body);
 */
export function render(view: () => unknown, parent: Element): void {
  __insert(at(parent), untrack(view), null);
}

/**
 * `render`, returning a function that disposes the view: its effects stop, its cleanups run,
 * and its nodes leave `parent`. The view's effects belong to one owner, so an app that uses it
 * includes ownership (about 0.3 KB gzipped; see the README).
 *
 * @example
 *   const dispose = attach(App, document.body);
 *   dispose(); // the page is as before
 */
export function attach(view: () => unknown, parent: Element): () => void {
  const anchor = at(parent);
  const root = new Root();
  const nodes = Owned.within(root, () => __insert(anchor, view(), null));
  return () => {
    root.dispose();
    if (nodes !== null) for (const n of nodes) n.parentNode?.removeChild(n);
    anchor.parentNode?.removeChild(anchor);
  };
}

/** An empty text node appended to `parent`: where a view goes, after what `parent` holds. */
function at(parent: Element): Text {
  return parent.appendChild(document.createTextNode(""));
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

export * from "./flow.ts";
