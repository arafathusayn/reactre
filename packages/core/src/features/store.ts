// @reactre/core/features/store: Solid 2.0's stores. `createStore`, `createProjection`,
// `reconcile`, `snapshot` and `deep`, with its props helpers `merge` and `omit`.
//
// A store is a proxy over a plain object or array. Reading a property inside an effect, a
// reactive hole or a memo subscribes to that property alone; arrays are followed by index and by
// `length`, and an object's set of keys (what `Object.keys` and `in` see) by a signal of its own.
// Each property's signal is made the first time the property is read through a store.
//
// Writes go through a draft: `setStore((s) => { s.todos.push(todo) })`. The draft is a second
// proxy over the same objects, which writes and notifies but subscribes nothing, so a derived
// store (`createStore(fn, seed)`, `createProjection`) can read its own draft in `fn` without
// depending on itself. A setter's writes are batched.
//
// In compiled TSX, a read through a store is reactive: @reactre/compiler takes a name bound by
// `createStore(...)` or `createProjection(...)` (or by features/actions's `createOptimisticStore`,
// which is built on them) for a store root, and so is an import (a module
// of the whole program that exports a store, or, with each file compiled alone, any import from
// outside @reactre, which may be one). A hole that mentions one is bound (`{store.count}`,
// `<Show when={store.user}>`), and a prop that does is a getter. A <For> renders the array `each`
// returns untracked, and needs a new array for each render (it keeps the last one to skip rows
// whose item has not changed), while a store's array is the same array, changed in place: so
// `<For each={store.todos}>` reads a copy, `[...store.todos]`, whose spread reads the length and
// every index tracked. The items stay the same proxies, so only new rows are built, and in the
// row the item is a store root too: a hole that reads only it (`class={todo.done ? "done" : ""}`)
// follows its in-place writes, where a row over plain values compares such a hole when it gets a
// new item. What the compiler cannot follow to a store (a local made of a store's member, a store
// kept in an object, a store's array passed as a prop and listed there) is written once, as any
// member read is: make such a hole call something, and spread such an `each`.
//
// Design decisions:
//   - A feature module, built from @reactre/core's public API alone (`signal`, `effect`,
//     `batch`, `untrack`): each property is a signal of a version number, bumped on a write, and
//     the value lives in the object itself. An app that does not import it ships none of it.
//   - `fn` of a derived store is synchronous: Solid 2.0's async one needs the core's async
//     runtime, which an app that uses stores alone would then pay for. Read an async memo in it
//     (@reactre/core/features/async), or use features/actions's `createOptimisticStore`.
//   - Objects are wrapped when they are plain (Object.prototype or a null prototype) or arrays,
//     and not frozen; anything else (a Date, a Map, a class instance) is returned as it is.
//   - Values are unwrapped where they are compared or copied, not when they are written: an
//     array built from a draft (`s.todos.filter(...)`) holds draft proxies of the same objects,
//     and every proxy of an object leads back to it.

import { batch, effect, type Setter, signal, untrack } from "@reactre/core";

/** A store: reads subscribe, and writes go through its setter. */
export type Store<T> = T;

/**
 * A store's setter. `fn` gets a draft of the store to change in place; its writes are batched.
 * An object `fn` returns replaces the store's contents shallowly: its keys are written, and the
 * store's other keys deleted. Write `fn` with a block body, since an arrow's expression body
 * returns what it assigns (`(s) => (s.user = u)` returns `u`).
 */
export type StoreSetter<T> = (fn: (draft: T) => T | void) => void;

/** Options of `createStore(value, options)`. */
export interface StoreOptions {
  /** A single-layer store: only its own properties are tracked, and their values are not wrapped. */
  readonly shallow?: boolean;
}

/** Options of a derived store (`createStore(fn, seed, options)`, `createProjection`). */
export interface ProjectionOptions {
  /** The property that identifies an array's items when a returned value is reconciled; null matches them by index. Default "id". */
  readonly key?: string | null;
}

type Obj = Record<PropertyKey, unknown>;

/** Leads from a store or a draft to the object it wraps. */
const RAW = Symbol();
/** Under this key, an object's signal of its set of keys. */
const KEYS = Symbol();

/** The signals of each object's properties, made as they are first read. */
const signals = new WeakMap<object, Map<PropertyKey, [() => number, Setter<number>]>>();
/** Each object's store proxy, and its draft proxy. */
const reads = new WeakMap<object, object>();
const drafts = new WeakMap<object, object>();
/** The objects of shallow stores: their values are returned unwrapped. */
const shallow = new WeakSet<object>();

const inc = (n: number): number => n + 1;

/** Subscribe the current reader to property `k` of `t`. */
function track(t: object, k: PropertyKey): void {
  let m = signals.get(t);
  if (m === undefined) signals.set(t, (m = new Map()));
  let s = m.get(k);
  if (s === undefined) m.set(k, (s = signal(0)));
  s[0]();
}

/** Re-run what read property `k` of `t`. */
function bump(t: object, k: PropertyKey): void {
  signals.get(t)?.get(k)?.[1](inc);
}

/** The object a store or a draft wraps; any other value as it is. */
function raw<T>(v: T): T {
  return (v && ((v as Obj)[RAW] as T)) || v;
}

/** Whether a store wraps `v`: a plain object or an array, not frozen. */
function wrappable(v: unknown): v is Obj {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null || Array.isArray(v);
}

/** `v`'s store proxy, or its draft (`d`); a value a store does not wrap, as it is. */
function wrap<T>(v: T, d: boolean): T {
  const t = raw(v);
  if (!wrappable(t)) return v;
  const c = d ? drafts : reads;
  let p = c.get(t);
  if (p === undefined) c.set(t, (p = new Proxy(t, d ? draft : read)));
  return p as T;
}

function readOnly(): never {
  throw new Error("reactre: a store is written through the draft its setter gives");
}

/** A store's proxy: reads subscribe; writes throw. */
const read: ProxyHandler<Obj> = {
  get(t, k, r) {
    if (k === RAW) return t;
    const v = Reflect.get(t, k, r);
    // Own properties are tracked, and missing ones, to see them added; the prototype's (an
    // array's methods) are not.
    if (Object.hasOwn(t, k) || !(k in t)) track(t, k);
    return shallow.has(t) ? v : wrap(v, false);
  },
  has(t, k) {
    track(t, k);
    return k in t;
  },
  ownKeys(t) {
    track(t, KEYS);
    return Reflect.ownKeys(t);
  },
  set: readOnly,
  deleteProperty: readOnly,
  defineProperty: readOnly,
};

/** A draft's proxy: reads subscribe nothing; writes notify. */
const draft: ProxyHandler<Obj> = {
  get(t, k, r) {
    if (k === RAW) return t;
    const v = Reflect.get(t, k, r);
    return shallow.has(t) ? v : wrap(v, true);
  },
  set(t, k, v) {
    write(t, k, v);
    return true;
  },
  deleteProperty(t, k) {
    remove(t, k);
    return true;
  },
};

/** Write `t[k]`, and re-run what read it: the property, the keys, an array's length and the indexes it cut. */
function write(t: Obj, k: PropertyKey, v: unknown): void {
  v = raw(v);
  const had = Object.hasOwn(t, k);
  if (had && t[k] === v) return;
  const len = Array.isArray(t) ? t.length : -1;
  t[k] = v;
  bump(t, k);
  if (!had) bump(t, KEYS);
  if (len >= 0) {
    const n = (t as unknown as unknown[]).length;
    if (n > len) bump(t, "length");
    else if (n < len) {
      for (let i = n; i < len; i++) bump(t, "" + i);
      bump(t, KEYS);
    }
  }
}

/** Delete `t[k]`, and re-run what read it or the keys. */
function remove(t: Obj, k: PropertyKey): void {
  if (!Object.hasOwn(t, k)) return;
  delete t[k];
  bump(t, k);
  bump(t, KEYS);
}

/** Make `t`'s own properties `v`'s, by reference: write each of `v`'s, delete the rest (an array: cut to length). */
function replace(t: Obj, v: Obj): void {
  for (const k of Object.keys(v)) write(t, k, v[k]);
  if (Array.isArray(t)) write(t, "length", (v as unknown as unknown[]).length);
  else for (const k of Object.keys(t)) if (!Object.hasOwn(v, k)) remove(t, k);
}

/** Apply what a setter returned: an object replaces the store's contents. */
function apply(t: Obj, r: unknown): void {
  const v = raw(r);
  if (typeof v === "object" && v !== null && v !== t) replace(t, v as Obj);
}

/** The identity of `v` under `key`: its key property, or undefined for none (or by index). */
function id(v: unknown, key: string | null): unknown {
  return key !== null && wrappable(v) ? v[key] : undefined;
}

/** Whether `o` takes `n`'s contents instead of being replaced by it: both objects, or both arrays, of one identity. */
function same(o: unknown, n: unknown, key: string | null): o is Obj {
  return wrappable(o) && wrappable(n) && Array.isArray(o) === Array.isArray(n) && id(o, key) === id(n, key);
}

/** Write into `t` what differs in `v`, keeping `t`'s objects where `v` has one of the same identity. */
function diff(t: Obj, v: Obj, key: string | null): void {
  if (Array.isArray(t)) {
    const old = t as unknown[],
      next = v as unknown as unknown[],
      byId = new Map<unknown, unknown>();
    for (const x of old) {
      const k = id(raw(x), key);
      if (k !== undefined) byId.set(k, raw(x));
    }
    const out: unknown[] = [];
    for (let i = 0; i < next.length; i++) {
      const n = raw(next[i]),
        k = id(n, key),
        o = k !== undefined ? byId.get(k) : raw(old[i]);
      if (o !== n && same(o, n, key)) {
        diff(o, n as Obj, key);
        out.push(o);
      } else out.push(n);
    }
    replace(t, out as unknown as Obj);
    return;
  }
  for (const k of Object.keys(v)) {
    const o = raw(t[k]),
      n = raw(v[k]);
    if (o !== n && same(o, n, key)) diff(o, n as Obj, key);
    else write(t, k, n);
  }
  for (const k of Object.keys(t)) if (!Object.hasOwn(v, k)) remove(t, k);
}

/**
 * A store: a deep reactive proxy over `value`, and its setter. Reading a property inside an
 * effect or a reactive hole subscribes to that property alone; arrays are followed by index and
 * `length`. The setter gives `fn` a draft to change in place, and batches its writes; an object
 * `fn` returns replaces the store's contents shallowly. `value` itself is the store's state, not
 * a copy of it.
 *
 * With `{ shallow: true }`, only the store's own properties are tracked, and their values are
 * returned as they are: replace them (`s.todos = [...s.todos, todo]`) to change them.
 *
 * `createStore(fn, seed)` is a derived store that can also be written: `fn` gets the draft, runs
 * tracked now and whenever what it read changes, and changes the draft or returns a new value,
 * reconciled into it by `options.key` (default "id"). A write through the setter holds until `fn`
 * runs again.
 *
 * @example
 *   import { createStore } from "@reactre/core/features/store";
 *
 *   const [store, setStore] = createStore({ todos: [{ id: 1, title: "a", done: false }] });
 *   effect(() => console.log(store.todos[0]!.done)); // logs false
 *   setStore((s) => {
 *     s.todos[0]!.done = true;
 *   }); // logs true
 *   setStore((s) => {
 *     s.todos.push({ id: 2, title: "b", done: false });
 *   }); // the effect read no part of the new todo: nothing logs
 */
export function createStore<T extends object>(value: T, options?: StoreOptions): [Store<T>, StoreSetter<T>];
export function createStore<T extends object>(
  fn: (draft: T) => T | void,
  seed: T,
  options?: ProjectionOptions,
): [Store<T>, StoreSetter<T>];
export function createStore<T extends object>(
  a: T | ((draft: T) => T | void),
  b?: T | StoreOptions,
  c?: ProjectionOptions,
): [Store<T>, StoreSetter<T>] {
  const fn = typeof a === "function" ? (a as (draft: T) => T | void) : null;
  const t = raw(fn !== null ? b : a) as Obj;
  if (fn === null && (b as StoreOptions | undefined)?.shallow) shallow.add(t);
  const d = wrap(t, true) as T;
  if (fn !== null) {
    const key = c?.key === undefined ? "id" : c.key;
    effect(() =>
      batch(() => {
        const v = raw(fn(d));
        if (wrappable(v) && v !== t) diff(t, v, key);
      }),
    );
  }
  return [wrap(t, false) as T, (f) => batch(() => untrack(() => apply(t, f(d))))];
}

/**
 * A read-only derived store. `fn` gets a draft of `seed`, runs tracked now and whenever what it
 * read changes, and changes the draft in place or returns a new value, which is reconciled into
 * it: objects of the same `options.key` (default "id"; null for by index) keep their identity and
 * only what changed is written, so readers of an unchanged property do not re-run.
 *
 * @example
 *   import { createProjection } from "@reactre/core/features/store";
 *
 *   const [selected, setSelected] = signal(1);
 *   const flags = createProjection<Record<number, boolean>>((d) => {
 *     for (const k of Object.keys(d)) delete d[+k];
 *     d[selected()] = true;
 *   }, {});
 *   // flags[3] re-runs its readers only when row 3 gains or loses the selection.
 */
export function createProjection<T extends object>(
  fn: (draft: T) => T | void,
  seed: T,
  options?: ProjectionOptions,
): Store<T> {
  return createStore(fn, seed, options)[0];
}

/**
 * A setter's function that writes into its draft only what differs in `value`. Objects of the
 * same `key` (default "id"; null to match array items by index) are kept and updated in place,
 * so readers of what did not change do not re-run. Give it to a setter, or call it on a part of
 * the draft.
 *
 * @example
 *   setStore(reconcile(await fetchState()));
 *   setStore((s) => {
 *     reconcile(rows, "id")(s.rows);
 *   });
 */
export function reconcile<T>(value: T, key: string | null = "id"): (draft: T) => void {
  return (d) => {
    const t = raw(d),
      v = raw(value);
    if (wrappable(t) && wrappable(v)) diff(t, v, key);
  };
}

/** A copy of `v`, read through store proxies when `tracked` (each read subscribes). */
function copy(v: unknown, tracked: boolean, seen: Map<object, unknown>): unknown {
  const t = raw(v);
  if (!wrappable(t)) return v;
  let out = seen.get(t) as Obj | undefined;
  if (out !== undefined) return out;
  const s = tracked ? wrap(t, false) : t;
  seen.set(t, (out = (Array.isArray(t) ? [] : {}) as Obj));
  if (Array.isArray(s)) for (let i = 0; i < s.length; i++) out[i] = copy(s[i], tracked, seen);
  else for (const k of Object.keys(s)) out[k] = copy(s[k], tracked, seen);
  return out;
}

/**
 * A plain copy of a store (or of part of one), deep, that nothing tracks: to serialize, log or
 * hand to code that must not subscribe.
 *
 * @example
 *   localStorage.setItem("todos", JSON.stringify(snapshot(store.todos)));
 */
export function snapshot<T>(store: T): T {
  return copy(store, false, new Map()) as T;
}

/**
 * Subscribe to every property of a store (or of part of one), at every depth, and return a
 * snapshot of it: an effect that calls it re-runs on any change inside.
 *
 * @example
 *   effect(() => save(deep(store))); // saves after every write
 */
export function deep<T>(store: T): T {
  return copy(store, true, new Map()) as T;
}

/** A getter property of `o`, enumerable, as an object literal's. */
function getter(o: object, k: PropertyKey, get: () => unknown): void {
  Object.defineProperty(o, k, { enumerable: true, configurable: true, get });
}

/** `A` with `B`'s properties over its own. */
type Over<A, B> = Omit<A, keyof B> & B;

/** The type of `merge(...sources)`: each source's properties over the ones before it. */
export type Merged<T extends readonly unknown[]> = T extends readonly [infer A, ...infer R]
  ? Over<A extends object ? A : {}, Merged<R>>
  : {};

/**
 * An object with the properties of every source, a later source's over an earlier one's; null
 * and undefined sources are skipped. A property that a later source has, even as undefined,
 * overrides. Each property is a getter that reads the source when read, so getters (reactive
 * props) and stores stay reactive: nothing is read when merging. The keys are the sources'
 * keys at the time of the call.
 *
 * @example
 *   function Button(props: { label?: string; kind?: string }) {
 *     const p = merge({ label: "OK", kind: "primary" }, props);
 *     return <button class={p.kind}>{p.label}</button>;
 *   }
 */
export function merge<T extends readonly unknown[]>(...sources: T): Merged<T> {
  const out = {},
    ss = sources.filter((s): s is Obj => s != null);
  for (const s of ss)
    for (const k of Object.keys(s))
      if (!Object.hasOwn(out, k))
        getter(out, k, () => {
          for (let i = ss.length; i--;) if (k in ss[i]!) return ss[i]![k];
          return undefined;
        });
  return out as Merged<T>;
}

/**
 * An object with `obj`'s properties but `keys`, each a getter that reads `obj` when read, so
 * getters (reactive props) and stores stay reactive. The keys are `obj`'s at the time of the call.
 *
 * @example
 *   function Input(props: { label: string } & Record<string, unknown>) {
 *     const rest = omit(props, "label");
 *     return <label>{props.label}<input {...rest} /></label>;
 *   }
 */
export function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = {};
  for (const k of Object.keys(obj)) if (!keys.includes(k as K)) getter(out, k, () => (obj as Obj)[k]);
  return out as Omit<T, K>;
}
