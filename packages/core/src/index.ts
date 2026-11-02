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
//     on the `__` internals below and hook into nothing that runs without them. So do
//     features/context (`createContext`, `useContext`) and features/errors (`<Errored>`), which
//     wrap methods of the owned effect class as they load (see "Ownership").
//   - Control flow (<Show>, <Switch>/<Match>, <Repeat>, <Portal>, <Dynamic>) is in ./flow.ts,
//     compiled away as <For> is. `dynamic()`, which runs, is @reactre/core/features/dynamic.
//   - Async data (@reactre/core/features/async and features/actions) needs every effect run to
//     know when a read is not ready, and every update whether it waits for one, so its code is
//     here, between `// #if ASYNC` markers (see "Async"). The default build (dist/index.js)
//     drops it (./withoutAsync.ts), so it is the code as it was before; dist/async/index.js
//     keeps it, and @reactre/plugin picks that build for a program that imports either module.
//     Kept in, the code does nothing until one of the modules loads.
//   - The development build's diagnostics (warnings with a code and a fix, and a guard on
//     `<For>` rows that never settle) are between `// #if DEV` markers: dist/dev/index.js keeps
//     them, with the async code, and the production builds strip them (see ./withoutAsync.ts).
//
// The list is @reactre/dom's keyed List (reuse, minimal moves, swaps and
// removals in place). Nothing here depends on React.
//
// Design decisions that shape the code below:
//
//   - Reactivity is synchronous and glitch-free. A signal write applies at
//     once and re-runs its observers before it returns, or at the end of the
//     outermost `batch`: it queues them, marks every memo it may change, and
//     then runs the queue, where a memo read recomputes first what it reads
//     (push to mark, pull to compute: see "Memos"). So each memo and effect
//     runs once per write, and none sees half of it. A write made while an
//     observer runs queues behind it. An effect notified while it runs (it
//     wrote what it read) runs again after, up to 100 times in a row, then
//     throws.
//   - An observer re-collects what it reads on every run, so a branch that
//     stops reading a signal stops depending on it.
//   - Rows cost as little as possible. A row is one plain object of fixed
//     shape. Its hole nodes are looked up only when one is first written. All
//     rows share one observer context while their reactive holes run, and a
//     row gets an observer object of its own only when it reads a signal.
//   - Everything named with a leading `__` is the compiler's target, not a
//     public API. Its shape follows what the compiler emits.

import { List, Prototype } from "@reactre/dom";

import type { Child } from "./jsx-runtime.ts";

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
  /** Run again: a source it read has changed (the queue's drain calls it, or `notify` while it runs). */
  stale(): void;
  /** An effect's (or memo's) run state: not IDLE while it runs. */
  state?: number;
  /** A memo's mark (CLEAN, CHECK or STALE, see "Memos"); undefined for any other observer. */
  f?: number;
  // #if ASYNC
  /** Never held by a transition: it reads `isPending` or `latest`. */
  lv?: boolean;
  // #endif
}

/** The reader whose reads are being recorded; null outside any observer and inside `untrack`. */
let current: Reader | null = null;
/** Depth of nested `batch` calls; observers are deferred while it is above 0. */
let batching = 0;
/**
 * How many observer runs and drains are under way: a write made meanwhile queues its observers,
 * which run when the outermost of them ends.
 */
let depth = 0;
/**
 * Whether a write outside a batch queued observers while a run was under way: the outermost run's
 * end drains them. What else waits in the queue (features/effects' first applies) waits on.
 */
let wrote = false;
/** Observers notified and not yet run, in first-notified order, each once (its `q` flag says so). */
const pending: Observer[] = [];
/** The next of `pending` to run: the ones before it have run (or are running). */
let head = 0;
/** The memos a write marks from clean: those it notifies, then, breadth first, the memos that read them. */
const marked: Memo<unknown>[] = [];
/** Marks memo `m` `f` and queues it (see "Memos"); set once the bundle holds a memo, as `spread` is. */
let mark: ((m: Memo<unknown>, f: number) => void) | null = null;
/** Marks CHECK, breadth first, the memos that read those in `marked`. */
let spread: (() => void) | null = null;
// #if ASYNC
/** The async runtime's hooks, once @reactre/core/features/async or /actions has loaded; null until then. */
let A: AsyncHooks | null = null;
/** The memos a write marks: brought up to date before the rest of `pending` runs (see `drainAsync`). */
const memos: Observer[] = [];
/** The next of `memos` to run. */
let mhead = 0;
/** How many `drainAsync` calls are under way: a memo that goes pending meanwhile holds the drain. */
let draining = 0;
/** Which values a read sees (see "Async"): 0, the page's; 1, a memo's run, the newest; 2, `latest`'s, the newest. */
let nv = 0;
/** The transition that holds a value the running memo read: it holds the memo's value too. */
let taint: __Transition | null = null;
// #endif
// #if DEV

// The development build's diagnostics (dist/dev, and the sources as `bun run` and `bun test` run
// them): a warning names a code and how to fix what it found, once per thing it found it in; a
// guard throws where the production build would loop. The production builds strip them all
// (./withoutAsync.ts), so they cost those nothing.

/** What each code has been warned about: each thing once. */
const warned = new Map<string, WeakSet<object>>();

/** Warn about `code`, found in `at` (once per `at`): what went wrong, and the fix. */
function warn(code: string, at: object, what: string, fix: string): void {
  let seen = warned.get(code);
  if (seen === undefined) warned.set(code, (seen = new WeakSet()));
  if (seen.has(at)) return;
  seen.add(at);
  console.warn(`reactre ${code}: ${what}. Fix: ${fix}.`);
}

/**
 * How many computations that should only read are running: a memo's function, a template hole's
 * value, a row's reactive holes. A signal written meanwhile is warned about. An effect's run is a
 * computation of its own, which sets it to 0 while it runs (see `Effect.run`).
 */
let pure = 0;

/** Run `fn`, a computation that should only read. */
function reading<T>(fn: () => T): T {
  pure++;
  try {
    return fn();
  } finally {
    pure--;
  }
}
// #endif

/**
 * Tell the observers of `s` that it changed. They are queued, not run, and every memo the write
 * may change is marked first (see "Memos"); then the queue runs, unless a batch, a run or a
 * drain is under way, whose end runs it.
 */
function notify(s: Source): void {
  const subs = s.subs;
  if (subs.length === 0) return;
  // The flag keeps each observer to one run per drain, without a search of the queue.
  for (let i = 0; i < subs.length; i++) {
    const o = subs[i]!;
    // Notified while it runs (it wrote what its run read): it runs again when that run ends.
    if (o.state) o.stale();
    else if (o.f !== undefined) {
      // A memo: queued STALE where it stands, among the observers; what reads it is marked after.
      if (!o.f) marked.push(o as Memo<unknown>);
      mark!(o as Memo<unknown>, STALE);
      // #if ASYNC
      // A change the page sees: the memo computes what the page sees again (see `Computed.set`).
      if (!(s as Partial<Held>).h) (o as Partial<Computed<unknown>>).u = true;
      // #endif
    } else if (!o.q) {
      // #if ASYNC
      // A change a transition holds: what the page shows runs when it ends, but what reads the newest.
      if ((s as Partial<Held>).h && !o.lv) continue;
      // #endif
      o.q = true;
      pending.push(o);
    }
  }
  if (marked.length !== 0) spread!();
  if (batching === 0) {
    if (depth === 0) drain();
    else wrote = true;
  }
}

/**
 * Run the queue: each observer leaves it (`head` passes it) before it runs, so one that throws
 * leaves the rest queued, still flagged, for the next drain. A write made by what runs queues
 * behind, and this loop runs it too: an observer's writes re-run nothing while it runs.
 */
function drain(): void {
  // #if DEV
  if (depth === 0) drains++;
  // #endif
  depth++;
  try {
    // #if ASYNC
    if (A !== null) return drainAsync();
    // #endif
    while (head < pending.length) {
      const o = pending[head++]!;
      o.q = false;
      o.stale();
    }
    pending.length = head = 0;
  } finally {
    depth--;
    wrote = false;
  }
}

/**
 * Run `fn` with every effect it causes deferred to its end, each run once.
 * Batches nest: effects run when the outermost one returns (or throws). A
 * batch inside an effect's run leaves them to the end of that run.
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
    if (--batching === 0) {
      if (depth === 0) drain();
      else wrote = true;
    }
  }
}

/**
 * Internal (@reactre/core/features/timing's `flush`): drain the queue now, even inside a batch or
 * a run. It runs as the outermost batch's end does, then `batching` and `depth` are put back.
 */
export function __drain(): void {
  const b = batching,
    d = depth;
  batching = depth = 0;
  try {
    drain();
  } finally {
    batching = b;
    depth = d;
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
  // #if ASYNC
  /** The transition that holds `v`, a write the page sees when it ends; `c` is what the page sees until then. */
  h: __Transition | null = null;
  c: unknown = undefined;
  // #endif
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
    // #if ASYNC
    if (s.h !== null) return seen!(s) as T;
    // #endif
    return s.v;
  };
  const write: Setter<T> = (next) => {
    // #if DEV
    if (pure !== 0)
      warn(
        "REACTIVE_WRITE_IN_OWNED_SCOPE",
        s,
        "a signal was written while a memo, a template hole or a <For> row's hole computed its value, which re-runs what read it in the middle of an update",
        "compute the value without writing: write in an event handler or an effect, or derive the value with memo()",
      );
    // #endif
    const v2 = typeof next === "function" ? (next as (p: T) => T)(s.v) : next;
    // #if ASYNC
    // In an action's code, a write is held by its transition; outside, one to a held value frees it.
    if (acting !== null ? v2 !== s.v : s.h !== null) return held!(s, v2);
    // #endif
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
/** What a cycle throws. */
const NEVER = "reactre: an effect writes a signal it reads, so it never settles";
// #if DEV

/** How many drains have started with none under way: the current drain's number. */
let drains = 0;

/**
 * Count a run of `o` from the queue in the current drain. Observers that keep writing what the
 * other reads (or a row's hole what it reads) queue each other without end, and keep the drain
 * going: past MAX_RUNS runs of one observer in one drain, throw `message`. The development
 * build's guard: the production build's drain runs on, as a loop of the app's own would.
 */
function cycle(o: { g: number; k: number }, message: string): void {
  if (o.g !== drains) {
    o.g = drains;
    o.k = 0;
  }
  if (++o.k > MAX_RUNS) throw new Error(message);
}
// #endif

/** An effect: a function re-run whenever a source it read last time changes. */
class Effect implements Observer {
  protected readonly fn: () => void;
  sources: Source[] = [];
  q = false;
  state: number = IDLE;
  // #if DEV
  /** The drain of its last run from the queue, and its runs in it (see `cycle`). */
  g: number = 0;
  k: number = 0;
  // #endif
  // #if ASYNC
  /** An async memo: a run that reads a value not ready waits under no boundary. */
  m = false;
  lv = false;
  /** While its last run read a value that was not ready: what `A.wait` gave for it. */
  nr: unknown = null;
  // #endif
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
    if (this.state === IDLE) {
      // #if DEV
      cycle(this, NEVER);
      // #endif
      this.run();
    } else this.state = DIRTY;
  }
  /**
   * Run, and again while a run was notified (it wrote what it read), up to MAX_RUNS in a row.
   * What its writes notify runs after it, when the outermost run (or drain) under way ends.
   */
  run(): void {
    // #if DEV
    // A computation of its own: what a hole's value started (a lazy memo's first run) may write.
    const p = pure;
    pure = 0;
    try {
      this.runs();
    } finally {
      pure = p;
    }
  }
  /** `run`, in the development build. */
  private runs(): void {
    // #endif
    depth++;
    try {
      for (let n = 0; n < MAX_RUNS; n++) {
        this.state = RUNNING;
        this.once();
        if (this.state === RUNNING) return;
      }
      throw new Error(NEVER);
    } finally {
      this.state = IDLE;
      if (--depth === 0 && batching === 0 && wrote) drain();
    }
  }
  /** One run of `fn` as the current observer, after dropping the sources of the last run. */
  protected once(): void {
    this.drop();
    const o = current;
    current = this;
    // #if ASYNC
    // A memo computes the newest values, what a transition holds included; an effect shows the page's.
    const pv = nv,
      pt = taint;
    nv = (this as Observer).f === undefined ? 0 : 1;
    taint = null;
    try {
      this.fn();
      if (this.nr !== null) ready(this);
    } catch (err) {
      // A read that was not ready: the run stops there, and what it wrote before stays. The
      // effect runs again when the value comes (it reads it, even where the read was untracked),
      // and its boundary waits for it until then.
      if (A === null || err !== NOT_READY) throw err;
      this.read(waiting!);
      if (this.nr === null && !this.m) this.nr = A.wait(this, null);
    } finally {
      current = o;
      nv = pv;
      taint = pt;
    }
    // #else
    // try {
    //   this.fn();
    // } finally {
    //   current = o;
    // }
    // #endif
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

/**
 * Dispose what `o` owns and run its cleanups, then forget both. One that throws stops none of
 * the others: the first error is thrown once all have run.
 */
function clean(o: Owner): void {
  const owned = o.owned,
    c = o.cleanups;
  let err: [unknown] | undefined;
  o.owned = null;
  o.cleanups = null;
  if (owned !== null)
    for (let i = 0; i < owned.length; i++)
      try {
        owned[i]!.dispose();
      } catch (e) {
        err ??= [e];
      }
  if (c !== null)
    for (let i = 0; i < c.length; i++)
      try {
        c[i]!();
      } catch (e) {
        err ??= [e];
      }
  if (err) throw err[0];
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
    // #if ASYNC
    if (this.nr !== null) ready(this);
    // #endif
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
 *
 * @reactre/core/features/context and features/errors wrap methods of `__Owned` (`once`, and the
 * static `within`) as they load, and features/errors those of `__RowObserver` (`read`, `stale`,
 * see "Lists"), the row observer class, which brings no list with it: owners then take the
 * scope they were made in, and what an effect or a row throws finds its boundary. Nothing here
 * checks for them.
 */
export { owner as __owner, Root as __Root, Owned as __Owned, RowObserver as __RowObserver };

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
 * Its readers re-run only when the recomputed value differs (!==) from the
 * last. A write recomputes each memo it changes once, after what the memo
 * reads, so no memo or effect sees half of the write.
 *
 * @example
 *   const [a, setA] = signal(2);
 *   const double = memo(() => a() * 2);
 *   double(); // 4
 *   setA(3);
 *   double(); // 6
 */
export function memo<T>(fn: () => T): () => T {
  // #if ASYNC
  // With the async runtime on, a memo may return a Promise or an AsyncIterable (see "Async").
  if (A !== null) return computed(fn);
  // #endif
  // #if DEV
  const m: Memo<T> = new Memoed<T>(() => m.put(reading(fn)));
  // #else
  // const m: Memo<T> = new Memoed<T>(() => m.put(fn()));
  // #endif
  m.run();
  return () => m.get();
}

// #endregion

// #region Memos

// A memo is an owned effect that computes a value, and the source its readers read. A write
// marks, before anything runs, every memo it may change: those it notifies STALE (a source of
// theirs changed), and, breadth first, those that read a marked memo CHECK (one of their memos
// may change). The marked memos join the queue, so each is brought up to date once, in the order
// they were marked; and a read of a marked memo brings it up to date first. Bringing a memo up to
// date (`up`) brings its marked memos up to date first, then recomputes it if it is STALE (a
// memo of it whose value changed makes it so). An effect that reads only memos is queued only
// when one of them changes. So a join of several branches recomputes once, after them, and a
// value read anywhere, in a run or between writes in a batch, is the write's whole result.
//
// The marking is installed with the first memo (`Memoed`): a bundle without one drops it.

/** A memo's marks. */
const CLEAN = 0,
  /** A memo it reads may have changed. */
  CHECK = 1,
  /** A source it read has changed: it computes again. */
  STALE = 2,
  /** Being brought up to date: a read meanwhile (a cycle through its owner) gets its last value. */
  UPDATING = -1;

/** A memo: the effect that computes it, and the source its readers read. */
class Memo<T> extends OwnedEffect implements Source {
  subs: Observer[] = [];
  v: T | undefined = undefined;
  f: number = CLEAN;
  /** The owner it was made in: brought up to date first, as its run may dispose this memo. */
  readonly p: Owner | null = owner;
  override stale(): void {
    // Notified while it runs, it runs again as an effect does; from the queue, it is brought up to date.
    if (this.state) super.stale();
    else this.up();
  }
  /** Bring it up to date: its owner and marked memos first, then itself, if it is STALE. */
  up(): void {
    const f = this.f;
    if (f <= CLEAN) return;
    this.f = UPDATING;
    // A memo made in a memo's run: the owner first, which disposes it if it runs again.
    const p = this.p as Partial<Memo<unknown>> | null;
    if (p !== null && p.f) p.up!();
    const ss = this.sources;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i] as Partial<Memo<unknown>>;
      // A source that changes makes this STALE (its `put` notifies this).
      if (s.f) s.up!();
    }
    const now = this.f;
    this.f = CLEAN;
    // Disposed meanwhile, its run does nothing.
    if (f === STALE || now === STALE) this.run();
  }
  get(): T {
    // Up to date before the reader subscribes: a reader that runs dropped its subscriptions, so
    // what this recomputing notifies does not run it again.
    if (this.f) this.up();
    if (current !== null) current.read(this);
    return this.v as T;
  }
  /** What a run computed. */
  put(v: T): void {
    if (v === this.v) return;
    this.v = v;
    notify(this);
  }
}

/** Install the marking, and ownership, which memos belong to. */
function installMemos(): typeof Memo {
  installOwners();
  const m = (mark = (m, f) => {
    m.f = f;
    if (!m.q) {
      m.q = true;
      // #if ASYNC
      // With the async runtime on, memos run before the other observers (see `drainAsync`).
      if (A !== null) {
        memos.push(m);
        return;
      }
      // #endif
      pending.push(m);
    }
  });
  spread = () => {
    // Breadth first, after the memos the write notifies: the queue runs them in that order. A
    // marked memo's readers are marked already; effects wait for a memo to change.
    for (let i = 0; i < marked.length; i++) {
      const subs = marked[i]!.subs;
      for (let j = 0; j < subs.length; j++) {
        const o = subs[j]!;
        if (o.f === CLEAN) {
          m(o as Memo<unknown>, CHECK);
          marked.push(o as Memo<unknown>);
        }
      }
    }
    marked.length = 0;
  };
  return Memo;
}

/** The memo class, with the marking installed; dropped from a bundle that makes no memo. */
const Memoed: typeof Memo = /* @__PURE__ */ installMemos();

// #endregion

// #if ASYNC
// #region Async

// The async runtime: what @reactre/core/features/async (async memos, <Loading>, `isPending`,
// `refresh`, ...) and features/actions (actions, optimistic values) build on. Either module
// installs it as it loads (`__installAsync`); until then nothing here runs, and every branch that
// leads here is off (`A` is null). The default build has none of it (see ./withoutAsync.ts).
//
//   - An async memo is a memo whose function returned a Promise or an AsyncIterable. Until its
//     first value comes, reading it throws NOT_READY: the effect or row whose run read it stops
//     there, keeps what it showed, and runs again when the value comes. Its <Loading> (found by
//     features/async through `A.wait`) shows its fallback until every run under it that waited
//     has run through.
//   - A memo with a value that runs again for a change keeps its value until the new one comes,
//     and the change starts a transition: the observers its batch would run are held, but for
//     memos (which run first, see `drainAsync`) and live observers (which read `isPending` or
//     `latest`), and they run when every memo of the transition has its new value. So an update
//     that makes an async read pending keeps the old UI, whole, until it settles. A batch in which
//     a memo of the transition gets its value, the transition still waiting for others, is held
//     too. One such transition is open at a time (`T`): what overlaps it joins it. Its writes
//     apply at once, as without the runtime: what it holds is the effects, not the values.
//   - Actions (features/actions) run in transitions of their own, held open while they run
//     (`holds`). Actions called in one tick (before a microtask) share one, as do an action and
//     those its code calls; two that write one value become one (`join`). A write in an action's
//     code is held by its transition: the value's `h` is the transition, and its `c` what the
//     page sees until the transition ends. A memo computes the newest values (`nv` is 1 while it
//     runs), so an async memo fetches with the held writes, and the transition waits for it;
//     a memo whose run read a held value is held too (`taint`), its `c` computed again as the
//     page sees it after a change the page sees (`u`). Effects, holes and reads outside a memo
//     see `c`; `latest` sees the newest values. A held change runs no effect, and when the
//     transition ends (`complete`) what read a value it held runs, with the values, its
//     optimistic writes revert (its `done` list) and the actions settle.

/** What @reactre/core/features/async gives the core: the boundaries that runs wait under. */
export interface AsyncHooks {
  /** Effect `o` (or row observer, of list `list`) read a value that was not ready: returns what `done` gets. */
  wait(o: object, list: object | null): unknown;
  /** What `wait` returned no longer waits: its run ran through, or it was disposed. */
  done(token: unknown): void;
}

/** The hooks while features/actions is in without features/async: no boundaries. */
const NO_BOUNDARIES: AsyncHooks = { wait: () => true, done: () => {} };

/** What reading a value that is not ready throws (features/async exports it as NotReadyError). */
export class __NotReadyError extends Error {
  override name: string = "NotReadyError";
  constructor() {
    super(
      "reactre: an async value was read before it resolved, where nothing waits for it: read it in an effect or in JSX, under a <Loading>",
    );
  }
}
/** Thrown, once made, for every read that is not ready: a run that catches it reads `waiting`. */
const NOT_READY = new __NotReadyError();
/** The source the last NOT_READY was thrown for. */
let waiting: Source | null = null;

/** `o` no longer waits: tell its boundary. */
function ready(o: { nr: unknown }): void {
  const t = o.nr;
  o.nr = null;
  if (A !== null) A.done(t);
}

/** A transition: the async memos an update made pending, and the observers held until they have their values. */
export class __Transition {
  /** The memos it waits for. */
  readonly pending: Set<object> = new Set();
  /** The memos it made pending (`pend`), to clear when it ends. */
  readonly marked: { pend: boolean }[] = [];
  /** The observers held until it ends. */
  readonly held: { q: boolean; stale(): void }[] = [];
  /** Run when it ends. */
  readonly done: (() => void)[] = [];
  /** The actions running in it: it ends only when none is. */
  holds = 0;
  /** The values whose newest it holds, a write the page sees when it ends (with `h` of it). */
  readonly w: Held[] = [];
  /** The transition it became part of (`join`), or null. */
  into: __Transition | null = null;
}

/** A signal or a memo, as a transition holds its value: `v` the newest, `c` what the page sees. */
interface Held extends Source {
  h: __Transition | null;
  v: unknown;
  c: unknown;
}

/** The open transition of an update that made an async memo pending, if any. */
let T: __Transition | null = null;
/** The transition of the action whose code is running (`__act`). */
let acting: __Transition | null = null;
/** The transition of the actions called in this tick: the next one called joins it. */
let fresh: __Transition | null = null;
/** The transition the observers of this drain are held for; null: they run. */
let entangled: __Transition | null = null;
/** The memo `refresh` runs: it runs again without a transition. */
let quiet: Computed<unknown> | null = null;
/** Read by `isPending`'s readers: notified when what is pending changes. */
const pendSrc: Source = { subs: [] };
/** What `affects` marked pending, by the transition it is pending in. */
const aff: Map<object, __Transition> = new Map();

/** The transition `t` is part of. */
function root(t: __Transition): __Transition {
  while (t.into !== null) t = t.into;
  return t;
}

/** Make transition `b` part of `a`: they end together. */
function join(a: __Transition, b: __Transition): __Transition {
  a = root(a);
  b = root(b);
  if (a === b) return a;
  b.into = a;
  a.holds += b.holds;
  for (const m of b.pending) {
    a.pending.add(m);
    (m as Computed<unknown>).pt = a;
  }
  for (const s of b.w) {
    if (s.h === b) s.h = a;
    a.w.push(s);
  }
  a.marked.push(...b.marked);
  a.done.push(...b.done);
  if (acting === b) acting = a;
  if (fresh === b) fresh = a;
  return a;
}

// Held writes, which only an action makes: features/actions installs them (`__installHolds`), so
// an app without actions ships none of their code. Until then, each is null, and no value is held.

/** A read of `s`, whose newest value a transition holds: the page's value, or, in a memo or `latest`, the newest. */
let seen: ((s: Held) => unknown) | null = null;
/** Signal `s` is written `v`: held, in an action's code; outside, a write the page sees, which frees it. */
let held: ((s: Signal<unknown>, v: unknown) => void) | null = null;
/** Memo `m`'s newest value is held by `t`, the page seeing `c`. */
let keep: ((m: Computed<unknown>, t: __Transition, c: unknown) => void) | null = null;
/** `fn()` as the page sees it: what a memo's run computes again for the page. */
let page: ((fn: () => unknown) => unknown) | null = null;
/** Transition `t` has ended: the page sees what it held, and what read it runs. */
let release: ((t: __Transition) => void) | null = null;

/**
 * The end of a batch with the async runtime on: memos first, then the other observers, each
 * held, if the batch belongs to a transition, unless it is live. Runs as the default loop runs:
 * each observer leaves the queue before it runs, and one that throws leaves the rest queued.
 */
function drainAsync(): void {
  draining++;
  try {
    for (;;) {
      let o: Observer;
      if (mhead < memos.length) o = memos[mhead++]!;
      else if (head < pending.length) {
        o = pending[head++]!;
        if (entangled !== null && !o.lv) {
          // Still flagged: a later write leaves it in place, and it runs once, when the transition ends.
          entangled.held.push(o);
          continue;
        }
      } else break;
      o.q = false;
      o.stale();
    }
    memos.length = mhead = 0;
    pending.length = head = 0;
  } finally {
    if (--draining === 0) entangled = null;
  }
}

/** Transition `t` has what it waited for: clear what is pending, revert, and run what it held. */
function complete(t: __Transition): void {
  if (T === t) T = null;
  if (entangled === t) entangled = null;
  const end = (): void => {
    release?.(t);
    for (const c of t.marked) c.pend = false;
    notify(pendSrc);
    for (const f of t.done) f();
    for (const o of t.held) pending.push(o as Observer);
  };
  // In a drain, its loop runs what this queues.
  if (draining) end();
  else batch(end);
}

/**
 * A memo with the async runtime on: marked and brought up to date as a memo is (see "Memos").
 * Its value is what `fn` returned, or what a Promise it returned resolved to, or the last value
 * an AsyncIterable it returned gave.
 */
class Computed<T> extends Memo<T> {
  override m = true;
  /** Whether it has a value: a readers' read before it does is not ready. */
  has = false;
  /** What its last async run failed with, thrown to its readers; NONE when it did not. */
  err: unknown = NONE;
  /** A run for a change is in flight, or its transition has not ended: `isPending` is true. */
  pend = false;
  /** The run whose result is awaited; null when none is. */
  tok: object | null = null;
  /** The iterator of the AsyncIterable its run returned. */
  it: AsyncIterator<T> | null = null;
  /** What `refresh` returned and waits for the next result. */
  w: [() => void, (e: unknown) => void][] | null = null;
  /** The transition that holds `v`; `c` is what the page sees until it ends (see "Async"). */
  h: __Transition | null = null;
  c: unknown = undefined;
  /** Marked by a change the page sees since its last run. */
  u = false;
  /** The transition that waits for the result of its run. */
  pt: __Transition | null = null;
  override get(): T {
    if (this.f) this.up();
    if (current !== null) current.read(this);
    if (this.err !== NONE) throw this.err;
    if (!this.has) {
      waiting = this;
      throw NOT_READY;
    }
    if (this.h !== null) return seen!(this) as T;
    return this.v as T;
  }
  /** What a run of `fn` returned. */
  set(r: unknown, fn: () => unknown): void {
    const it = this.it,
      u = this.u;
    this.it = null;
    this.u = false;
    if (it !== null) void it.return?.();
    if (typeof r === "object" && r !== null) {
      if (typeof (r as PromiseLike<T>).then === "function") return this.start(r as PromiseLike<T>, null);
      const iterate = (r as Partial<AsyncIterable<T>>)[Symbol.asyncIterator];
      if (typeof iterate === "function") return this.start(null, iterate.call(r));
    }
    this.tok = null;
    this.err = NONE;
    // Its run read a held value, and the page's changed too: compute what the page sees.
    this.put(r as T, taint, taint !== null && u ? page!(fn) : NONE);
    const t = this.pt;
    this.pt = null;
    if (t !== null && t.pending.delete(this)) __settle(t);
  }
  /** Wait for a Promise's value, or an iterator's values. */
  private start(p: PromiseLike<T> | null, it: AsyncIterator<T> | null): void {
    const tok = (this.tok = {}),
      q = quiet !== this && this.has,
      // What waits for it: a change, the update's transition, or one that holds a value its run
      // read; `refresh`, or a first run, the transition of the action whose code runs.
      t = q ? (taint ?? (T ??= new __Transition())) : (acting ?? taint),
      old = this.pt;
    this.it = it;
    if (old !== null && old !== t && old.pending.delete(this)) __settle(old);
    this.pt = t;
    if (t !== null) {
      if (q && !this.pend) {
        this.pend = true;
        t.marked.push(this);
        notify(pendSrc);
      }
      t.pending.add(this);
      if (q && t === T && draining) entangled = t;
    }
    const no = (e: unknown): void => {
      if (this.tok === tok) this.settle(undefined, e, true);
    };
    if (p !== null)
      p.then((v) => {
        if (this.tok === tok) this.settle(v, NONE, true);
      }, no);
    else {
      const pull = (): void =>
        void it!.next().then((r) => {
          if (this.tok !== tok) return;
          if (r.done) this.tok = null;
          else {
            this.settle(r.value, NONE, false);
            pull();
          }
        }, no);
      pull();
    }
  }
  /** A value (or, with `err`, a failure) came; `last` when no more will for this run. */
  private settle(v: T | undefined, err: unknown, last: boolean): void {
    if (last) this.tok = null;
    batch(() => {
      const t = this.pt;
      let h: __Transition | null = null;
      this.pt = null;
      if (t !== null && t.pending.delete(this)) {
        // The transition still waits: what this value re-runs waits with it, an update's, or, an
        // action's, the value too.
        if (t.pending.size !== 0 || t.holds !== 0) t === T ? (entangled = t) : (h = t);
        else complete(t);
      }
      if (err === NONE) {
        this.err = NONE;
        this.put(v as T, h);
      } else {
        this.err = err;
        notify(this);
      }
      const w = this.w;
      this.w = null;
      if (w !== null) for (const [ok, no] of w) err === NONE ? ok() : no(err);
    });
  }
  /**
   * Its newest value is `v`, which transition `t` holds, the page seeing `c` until it ends; with
   * `t` null (or `c` the same), the page sees `v` now.
   */
  override put(v: T, t: __Transition | null = null, c: unknown = NONE): void {
    const h = this.h,
      was = h !== null ? this.c : this.v;
    if (t === null) c = v;
    else if (c === NONE) c = was;
    if (this.has && v === this.v && c === was) return;
    // `c` is not `v`: `t` is not null, and an action's.
    if (c === v || !this.has) this.h = null;
    else keep!(this as Computed<unknown>, t!, c);
    this.has = true;
    this.v = v;
    // A change the page sees notifies as a write does; one only the newest values see is held.
    const k = this.h;
    if (c !== was) this.h = null;
    notify(this);
    this.h = k;
  }
  /** Run again, outside any transition (but an action's), and wait for the result. */
  refresh(): Promise<void> {
    batch(() => {
      quiet = this as Computed<unknown>;
      try {
        this.f = STALE;
        this.up();
      } finally {
        quiet = null;
      }
    });
    return this.tok === null ? Promise.resolve() : new Promise((ok, no) => (this.w ??= []).push([ok, no]));
  }
}

/** Each memo's `refresh`, by its read function; features/actions adds its optimistic stores'. */
export const __refreshers: WeakMap<object, () => Promise<void>> = new WeakMap();

/** `memo(fn)` with the async runtime on. */
function computed<T>(fn: () => T): () => T {
  const c: Computed<T> = new Computed<T>(() => c.set(fn(), fn));
  const read = (): T => c.get();
  __refreshers.set(read, () => c.refresh());
  c.run();
  return read;
}

/** Records reads, and whether one of them is pending. */
class Probe implements Reader {
  hit = false;
  readonly o: Reader | null;
  constructor(o: Reader | null) {
    this.o = o;
  }
  read(s: Source): void {
    if (this.o !== null) this.o.read(s);
    if (!this.hit && pendingOf(s)) this.hit = true;
  }
}

/** Whether a change to `s` is in flight: an async memo's run, a memo of one, what `affects` marked. */
function pendingOf(s: Source): boolean {
  if (aff.has(s)) return true;
  if (!(s instanceof Computed)) return false;
  if (s.pend) return true;
  const ss = s.sources;
  for (let i = 0; i < ss.length; i++) if (pendingOf(ss[i]!)) return true;
  return false;
}

/**
 * Internal (features/async's `isPending`): run `fn`, read as the current reader reads, and say
 * whether a read was pending. The current reader also follows what is pending.
 */
export function __probe<T>(fn: () => T): [T, boolean] {
  if (current !== null) current.read(pendSrc);
  const o = current,
    p = new Probe(o);
  current = p;
  try {
    return [fn(), p.hit];
  } finally {
    current = o;
  }
}

/** Internal: the current observer is live: no transition holds it. */
export function __live(): void {
  const o = current === rowContext ? rowContext.entry.obs : current;
  if (o !== null) (o as Observer).lv = true;
}

/** Internal (features/actions' `affects`): the sources `fn` reads. A read that is not ready ends it. */
export function __capture(fn: () => unknown): object[] {
  const out: Source[] = [],
    o = current;
  current = { read: (s) => void (out.includes(s) || out.push(s)) };
  try {
    fn();
  } catch (e) {
    if (e !== NOT_READY) throw e;
  } finally {
    current = o;
  }
  return out;
}

/** Internal: mark `sources` pending until transition `t` ends. */
export function __affect(t: __Transition, sources: readonly object[]): void {
  for (const s of sources) aff.set(s, t);
  notify(pendSrc);
}

/**
 * Internal (features/actions): the transition an action called now runs in, held open for it
 * until `__end`: that of the action whose code calls it, or of the actions called in this tick,
 * or a new one.
 */
export function __begin(): __Transition {
  let t = acting ?? fresh;
  if (t === null) {
    const n = (t = fresh = new __Transition());
    queueMicrotask(() => {
      if (fresh === n) fresh = null;
    });
  }
  t.holds++;
  return t;
}

/** Internal (features/actions): an action of transition `t` returned; `f` runs when the transition ends. */
export function __end(t: __Transition, f: (() => void) | null): void {
  t = root(t);
  if (f !== null) t.done.push(f);
  t.holds--;
  __settle(t);
}

/** Internal: the open transition of an update, or null. */
export function __open(): __Transition | null {
  return T;
}

/** Internal: end transition `t` if it waits for nothing and runs no action. */
export function __settle(t: __Transition): void {
  if (t.pending.size === 0 && t.holds === 0) complete(t);
}

/**
 * Internal: run `fn` as code of an action of transition `t` (null: of none, so that its writes
 * are not held), in a batch, whose effects run once the code has returned.
 */
export function __act<R>(t: __Transition | null, fn: () => R): R {
  const p = acting;
  return batch(() => {
    acting = t && root(t);
    try {
      return fn();
    } finally {
      acting = p;
    }
  });
}

/** Internal (features/actions): turn held writes on (see "Async"). */
export function __installHolds(): void {
  seen = (s) => {
    if (nv === 0) return s.c;
    // A memo that read it is held by the same transition.
    if (nv === 1 && taint !== s.h) taint = taint === null ? s.h : join(taint, s.h!);
    return s.v;
  };
  held = (s, v) => {
    const t = acting;
    if (t === null) s.h = null;
    else if (s.h === null) {
      s.c = s.v;
      s.h = t;
      t.w.push(s);
    } else if (s.h !== t) join(s.h, t);
    s.v = v;
    notify(s);
  };
  keep = (m, t, c) => {
    if (m.h === null) {
      m.h = t;
      t.w.push(m);
    } else if (m.h !== t) join(m.h, t);
    m.c = c;
  };
  page = (fn) => {
    const o = current;
    current = null;
    nv = 0;
    try {
      return fn();
    } finally {
      current = o;
      nv = 1;
    }
  };
  release = (t) => {
    if (fresh === t) fresh = null;
    for (const [s, u] of aff) if (root(u) === t) aff.delete(s);
    // What it held, the page sees now: what read the page's value runs. Memos have the newest.
    for (const s of t.w)
      if (s.h === t) {
        s.h = null;
        if (s.c !== s.v)
          for (const o of s.subs)
            if (o.f === undefined && !o.q) {
              o.q = true;
              pending.push(o);
            }
      }
  };
}

/** Internal (features/async's `latest`): `fn()`, its reads seeing the newest values, held ones included. */
export function __newest<R>(fn: () => R): R {
  const p = nv;
  nv = 2;
  try {
    return fn();
  } finally {
    nv = p;
  }
}

/** Internal: the transition of the action whose code is running, or null. */
export function __acting(): __Transition | null {
  return acting;
}

/**
 * Internal: turn the async runtime on, with `hooks` (features/async), or with the hooks given
 * before (features/actions, which has none of its own); `false` turns it off, for tests.
 */
export function __installAsync(hooks?: AsyncHooks | false): void {
  if (hooks === false) {
    A = null;
    T = acting = fresh = entangled = null;
    aff.clear();
    return;
  }
  A = hooks ?? A ?? NO_BOUNDARIES;
}

// #endregion
// #endif

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
  readonly byKey: Map<K, Source> = new Map<K, Source>();
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
    // Its readers run after this (the selector's own run is under way): a key they stopped asking
    // about since it last woke is forgotten now.
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
  // #if DEV
  /** The drain of its last run, and its runs in it (see `cycle`). */
  g: number = 0;
  k: number = 0;
  // #endif
  // #if ASYNC
  lv = false;
  /** While the row's last run read a value that was not ready: what `A.wait` gave for it. */
  nr: unknown = null;
  /** The row has left its list: a transition that held this observer does not run it. */
  d = false;
  // #endif
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
    // #if ASYNC
    if (this.d) return;
    // #endif
    // A hole that writes what it reads queues the row again from inside its own run, without end:
    // the development build throws, as its guard on effects that keep re-running each other does;
    // the production build's drain runs on.
    // #if DEV
    cycle(
      this,
      "reactre FOR_ROW_LOOP: a <For> row's reactive hole writes a signal it reads, so the row never settles. Fix: compute the hole's value without writing; write in an event handler or an effect",
    );
    // #endif
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
    // #if ASYNC
    try {
      // #if DEV
      // The development build has the async runtime: only this branch needs the check.
      reading(() => this.spec.dyn!(item, out));
      // #else
      // this.spec.dyn!(item, out);
      // #endif
      if (e.obs !== null && e.obs.nr !== null) ready(e.obs);
    } catch (err) {
      // A read that was not ready, as an effect's run takes it: the row's holes are empty until
      // the value comes, and its boundary waits for it.
      if (A === null || err !== NOT_READY) throw err;
      rowContext.read(waiting!);
      out.fill(undefined, 0, this.nd);
      const ob = e.obs!;
      if (ob.nr === null) ob.nr = A.wait(ob, this);
    } finally {
      current = o;
      rowContext.list = pl;
      rowContext.entry = pe;
    }
    // #else
    // try {
    //   this.spec.dyn!(item, out);
    // } finally {
    //   current = o;
    //   rowContext.list = pl;
    //   rowContext.entry = pe;
    // }
    // #endif
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
    // #if ASYNC
    if (e.obs !== null) {
      e.obs.drop();
      e.obs.d = true;
      if (e.obs.nr !== null) ready(e.obs);
    }
    // #else
    // if (e.obs !== null) e.obs.drop();
    // #endif
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
    // #if DEV
    checkKeys(this as ForList<unknown, unknown>, items);
    // #endif
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
// #if DEV

/** By list, the key each object item had at its last render. */
const keysOf = new WeakMap<object, WeakMap<object, unknown>>();

/**
 * Check the keys of `items`, which list `l` is about to render: two items of one key share one
 * row, and an item whose key changed from the last render (a key made anew each time, or a
 * position) has its row rebuilt.
 */
function checkKeys(l: ForList<unknown, unknown>, items: readonly unknown[]): void {
  const key = l.spec.key,
    seen = new Set<unknown>();
  let last = keysOf.get(l);
  if (last === undefined) keysOf.set(l, (last = new WeakMap()));
  for (let i = 0; i < items.length; i++) {
    const item = items[i],
      k = key(item);
    if (seen.has(k))
      warn(
        "FOR_DUPLICATE_KEY",
        l,
        `two items of a <For> have the key ${String(k)}, and a key has one row`,
        "give each item a key of its own, such as an id",
      );
    seen.add(k);
    if (typeof item === "object" && item !== null) {
      if (last.has(item) && last.get(item) !== k)
        warn(
          "FOR_UNSTABLE_KEY",
          l,
          "an item of a <For> got another key than at the last render, so its row was built again (keys are compared with ===)",
          "key by something of the item that stays, such as its id, not a new object or array, its index or a counter",
        );
      last.set(item, k);
    }
  }
}
// #endif

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
    // Every hole's node is found now, in the clone as it was made: a mount puts nodes in the
    // row (a slot's content, a component's, a list's rows), and a hole after it, looked up
    // later by its path, would find one of those.
    this.spec.t.locate(e.root, (e.nodes = []));
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
  // #if DEV
  return checked(new Prototype(strings, holes, svg));
  // #else
  // return new Prototype(strings, holes, svg);
  // #endif
}
// #if DEV

/**
 * Template `t`, checking the values its clones and writes give its text holes, where a function
 * is a mistake (`{count}` for `{count()}`), and so is a node or an array of nodes, which the
 * compiler could not tell the hole would hold (`{make()}` of a function it cannot see). (An
 * `on...` attribute hole of a template is set as the element's property, so `onclick={fn}`
 * listens; spread props are checked in `prop`.)
 */
function checked(t: Prototype): Prototype {
  // @reactre/dom's kind code (`Prototype.kinds`) of a text hole.
  const TEXT = 0;
  const text: number[] = [];
  for (let i = 0; i < t.n; i++) if (t.kinds[i] === TEXT) text.push(i);
  if (text.length === 0) return t;
  const clone = t.clone.bind(t),
    write = t.write.bind(t);
  t.clone = (values) => {
    for (let j = 0; j < text.length; j++) asText(t, values[text[j]!]);
    return clone(values);
  };
  t.write = (i, node, v) => {
    if (t.kinds[i] === TEXT) asText(t, v);
    write(i, node, v);
  };
  return t;
}

/** Check `v`, which template `at` writes as text: a function, or nodes, is a mistake. */
function asText(at: object, v: unknown): void {
  if (typeof v === "function") functionAsText(at);
  else if (holdsNode(v))
    warn(
      "NODE_AS_TEXT",
      at,
      "a node (or an array of nodes) was rendered where text goes, as the compiler could not see it holds JSX, so it shows as [object ...]",
      "wrap the hole in a fragment, <>{value}</>, which inserts nodes, or render a component as an element (<Item />)",
    );
}

/** Whether `v` is a node, or an array that holds one. */
function holdsNode(v: unknown): boolean {
  return typeof v === "object" && v !== null && ("nodeType" in v || (Array.isArray(v) && v.some(holdsNode)));
}

/** Warn that a function is rendered as text, found in `at`. */
function functionAsText(at: object): void {
  warn(
    "FUNCTION_AS_TEXT",
    at,
    "a function was rendered where text goes, so its source is shown",
    "call it ({count()}, not {count}), or render a component as an element (<Item />)",
  );
}
// #endif

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
    // #if DEV
    if (typeof x === "function") functionAsText(x);
    // #endif
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
    // #if DEV
    const v = reading(value);
    // #else
    // const v = value();
    // #endif
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
    // #if DEV
    const v = reading(value);
    // #else
    // const v = value();
    // #endif
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
  // A string in an inline event-handler attribute (`onclick`, `ONCLICK`: one the element has as a
  // property) is code the page would run: from data spread onto an element, a script injected. It
  // is left out; null and false still remove one, and another `on...` name (`one`) is an attribute.
  if (typeof v === "string" && /^on/i.test(k) && k.toLowerCase() in el) {
    // #if DEV
    warn(
      "STRING_HANDLER",
      el,
      `the spread prop ${k} was given a string, which would run as an inline handler, so it is left out`,
      `to listen, pass a function as on${k.charAt(2).toUpperCase()}${k.slice(3).toLowerCase()}; to keep the text, put it in a data- attribute`,
    );
    // #endif
    return;
  }
  // #if DEV
  if (typeof v === "function" && /^on[a-z]/.test(k))
    warn(
      "ATTRIBUTE_HANDLER",
      el,
      `the spread prop ${k} was given a function, which becomes the text of an attribute`,
      `to listen, write it in camelCase (on${k.charAt(2).toUpperCase()}${k.slice(3)})`,
    );
  // #endif
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
 * `<For each key fallback>`: a keyed list; compiled away, so only its type is used.
 * Calling it at runtime throws: the source was not compiled by @reactre/compiler.
 *
 * Rows are keyed by `key`, reused across renders and moved with the fewest
 * DOM moves. A row's markup is built once, when its key first appears; its
 * holes that read only the item are compared when the list renders it again
 * with a new item. `fallback` is shown while `each` is empty.
 *
 * `keyed={(item) => key}` is `key`, under Solid 2.0's name. With `keyed={false}` (Solid 2.0's
 * replacement for `<Index>`), rows are by position (@reactre/core/features/index, which the
 * compiler imports): the row at index `i` is built once, and gets an accessor of its item,
 * `(item, i) => ...`, whose holes follow a new item at that position.
 *
 * @example
 *   <tbody>
 *     <For each={rows()} key={(row) => row.id}>
 *       {(row) => <tr><td>{row.label}</td></tr>}
 *     </For>
 *   </tbody>
 *   <ul>
 *     <For each={names()} keyed={false}>
 *       {(name, i) => <li>{i + 1}. {name()}</li>}
 *     </For>
 *   </ul>
 */
// The overloads that `keyed` added are TYPES blocks, which every build strips: they ship no code,
// and Bun's minifier names locals by the letters of the source, types included (./withoutAsync.ts).
// #if TYPES
export function For<T>(props: {
  each: readonly T[];
  key: (item: T) => string | number;
  /** Shown while `each` is empty. */
  fallback?: Child;
  /** A row: its content, for the item (and an accessor of its index), or the content itself. */
  children: ((item: T, index: () => number) => unknown) | Child;
}): unknown;
export function For<T>(props: {
  each: readonly T[];
  /** The key of an item, as `key`. */
  keyed: (item: T) => string | number;
  /** Shown while `each` is empty. */
  fallback?: Child;
  /** A row: its content, for the item (and an accessor of its index), or the content itself. */
  children: ((item: T, index: () => number) => unknown) | Child;
}): unknown;
export function For<T>(props: {
  each: readonly T[];
  /** Rows by position: a row gets an accessor of the item at its index, and the index. */
  keyed: false;
  /** Shown while `each` is empty. */
  fallback?: Child;
  children: (item: () => T, i: number) => unknown;
}): unknown;
export function For(_props: unknown): unknown {
  // #else
  // export function For<T>(_props: {
  //   each: readonly T[];
  //   key: (item: T) => string | number;
  //   /** Shown while `each` is empty. */
  //   fallback?: Child;
  //   children: (item: T) => unknown;
  // }): unknown {
  // #endif
  throw new Error("reactre: <For> must be compiled by @reactre/compiler");
}

// #endregion

export * from "./flow.ts";
