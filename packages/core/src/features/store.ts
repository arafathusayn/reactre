// @reactre/core/features/store: Solid 2.0's stores. `createStore`, `createProjection`,
// `reconcile`, `snapshot` and `deep`, with its props helpers `merge` and `omit`, and `path`, its
// `storePath`: a setter's function that writes one value at a path.
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

/**
 * `t[k]`, read through a store or a draft. An inherited `__proto__` or `constructor` is
 * undefined, as in Solid 2.0, since what it leads to (Object.prototype, Object) every object
 * shares, and a write there would reach them all. An array's methods that read `constructor`
 * then make plain arrays, as they do for an undefined one.
 */
function get(t: Obj, k: PropertyKey, r: unknown): unknown {
  return (k === "__proto__" || k === "constructor") && !Object.hasOwn(t, k) ? undefined : Reflect.get(t, k, r);
}

/** `t[k] = v`, as an own property for `__proto__` too, whose assignment would set `t`'s prototype. */
function put(t: Obj, k: PropertyKey, v: unknown): void {
  if (k === "__proto__")
    Object.defineProperty(t, k, { value: v, writable: true, enumerable: true, configurable: true });
  else t[k] = v;
}

/** A store's proxy: reads subscribe; writes throw. */
const read: ProxyHandler<Obj> = {
  get(t, k, r) {
    if (k === RAW) return t;
    const v = get(t, k, r);
    // Own properties are tracked, and missing ones, to see them added; the prototype's (an
    // array's methods, an inherited `constructor`) are not.
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
    const v = get(t, k, r);
    return shallow.has(t) ? v : wrap(v, true);
  },
  set(t, k, v) {
    // A write of `__proto__` is dropped, as in Solid 2.0: it would set the object's prototype.
    if (k !== "__proto__") write(t, k, v);
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
  put(t, k, v);
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

/**
 * Write into `t` what differs in `v`, keeping `t`'s objects where `v` has one of the same
 * identity. A shallow store's values are replaced, not merged into: they are not its own.
 */
function diff(t: Obj, v: Obj, key: string | null): void {
  if (shallow.has(t)) return replace(t, v);
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
    // `t`'s own value only: an own `__proto__` of `v` (JSON's) is data, not `t`'s prototype.
    const o = raw(Object.hasOwn(t, k) ? t[k] : undefined),
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
 * returned as they are: replace them (`s.todos = [...s.todos, todo]`) to change them. `reconcile`
 * replaces them too, by reference, rather than merging into them.
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

/** What `path(...keys, path.DELETE)` writes: the property is deleted. */
const DELETE: unique symbol = /* @__PURE__ */ Symbol();

/** A value a store does not go into. */
type Leaf = string | number | bigint | boolean | symbol | null | undefined | ((...args: never[]) => unknown);
/** `T` without what a path cannot go into. */
type In<T> = Exclude<T, Leaf>;
/** The keys of `T` a path goes through: an array's are its indexes. */
type KeyOf<T> = In<T> extends readonly unknown[] ? number : keyof In<T>;
/** What a path finds at key `K` of `T`. */
type At<T, K> = K extends keyof In<T> ? In<T>[K] : never;
/** A range of an array's indexes, `from` to `to` (both included) by `by`: 0, its last, 1 by default. */
export interface PathRange {
  readonly from?: number;
  readonly to?: number;
  readonly by?: number;
}
/** One step of a path through `T`: a key, several keys, and in an array a range or a test of its items. */
export type PathPart<T, K extends KeyOf<T> = KeyOf<T>> =
  K | readonly K[] | (In<T> extends readonly (infer I)[] ? PathRange | ((item: I, index: number) => boolean) : never);
/**
 * What a path writes where it ends: a value (an object over an object is merged into it), a
 * function of the value there, or `path.DELETE`.
 */
export type PathValue<T> = T | Partial<T> | ((prev: T) => T | Partial<T>) | typeof DELETE;

/** `path`: its overloads, from no key to six, and `DELETE`. */
export interface Path {
  /** Written by `path`, deletes the property. */
  readonly DELETE: typeof DELETE;
  // `NoInfer`: the store's type comes from the setter `path` is given to, not from the value.
  <T>(value: NoInfer<PathValue<T>>): (draft: T) => void;
  <T, K1 extends KeyOf<T>>(k1: PathPart<T, K1>, value: NoInfer<PathValue<At<T, K1>>>): (draft: T) => void;
  <T, K1 extends KeyOf<T>, K2 extends KeyOf<At<T, K1>>>(
    k1: PathPart<T, K1>,
    k2: PathPart<At<T, K1>, K2>,
    value: NoInfer<PathValue<At<At<T, K1>, K2>>>,
  ): (draft: T) => void;
  <T, K1 extends KeyOf<T>, K2 extends KeyOf<At<T, K1>>, K3 extends KeyOf<At<At<T, K1>, K2>>>(
    k1: PathPart<T, K1>,
    k2: PathPart<At<T, K1>, K2>,
    k3: PathPart<At<At<T, K1>, K2>, K3>,
    value: NoInfer<PathValue<At<At<At<T, K1>, K2>, K3>>>,
  ): (draft: T) => void;
  <
    T,
    K1 extends KeyOf<T>,
    K2 extends KeyOf<At<T, K1>>,
    K3 extends KeyOf<At<At<T, K1>, K2>>,
    K4 extends KeyOf<At<At<At<T, K1>, K2>, K3>>,
  >(
    k1: PathPart<T, K1>,
    k2: PathPart<At<T, K1>, K2>,
    k3: PathPart<At<At<T, K1>, K2>, K3>,
    k4: PathPart<At<At<At<T, K1>, K2>, K3>, K4>,
    value: NoInfer<PathValue<At<At<At<At<T, K1>, K2>, K3>, K4>>>,
  ): (draft: T) => void;
  <
    T,
    K1 extends KeyOf<T>,
    K2 extends KeyOf<At<T, K1>>,
    K3 extends KeyOf<At<At<T, K1>, K2>>,
    K4 extends KeyOf<At<At<At<T, K1>, K2>, K3>>,
    K5 extends KeyOf<At<At<At<At<T, K1>, K2>, K3>, K4>>,
  >(
    k1: PathPart<T, K1>,
    k2: PathPart<At<T, K1>, K2>,
    k3: PathPart<At<At<T, K1>, K2>, K3>,
    k4: PathPart<At<At<At<T, K1>, K2>, K3>, K4>,
    k5: PathPart<At<At<At<At<T, K1>, K2>, K3>, K4>, K5>,
    value: NoInfer<PathValue<At<At<At<At<At<T, K1>, K2>, K3>, K4>, K5>>>,
  ): (draft: T) => void;
  <
    T,
    K1 extends KeyOf<T>,
    K2 extends KeyOf<At<T, K1>>,
    K3 extends KeyOf<At<At<T, K1>, K2>>,
    K4 extends KeyOf<At<At<At<T, K1>, K2>, K3>>,
    K5 extends KeyOf<At<At<At<At<T, K1>, K2>, K3>, K4>>,
    K6 extends KeyOf<At<At<At<At<At<T, K1>, K2>, K3>, K4>, K5>>,
  >(
    k1: PathPart<T, K1>,
    k2: PathPart<At<T, K1>, K2>,
    k3: PathPart<At<At<T, K1>, K2>, K3>,
    k4: PathPart<At<At<At<T, K1>, K2>, K3>, K4>,
    k5: PathPart<At<At<At<At<T, K1>, K2>, K3>, K4>, K5>,
    k6: PathPart<At<At<At<At<At<T, K1>, K2>, K3>, K4>, K5>, K6>,
    value: NoInfer<PathValue<At<At<At<At<At<At<T, K1>, K2>, K3>, K4>, K5>, K6>>>,
  ): (draft: T) => void;
}

/** A key a path does not go through or write, as in Solid 2.0: it leads to what every object shares. */
const shared = (k: unknown): boolean => k === "__proto__" || k === "constructor" || k === "prototype";

/**
 * Follow `args[i]`, the path's step `i`, from `cur` (a draft), and write its last argument where
 * the path ends. A step of several keys goes each way in turn, as `args[i]` set to each.
 */
function walk(cur: Obj, args: unknown[], i: number): void {
  const last = args.length - 1;
  let k: PropertyKey | undefined,
    prev: unknown = cur;
  if (i < last) {
    const p = args[i];
    if (shared(p)) return;
    let ks: Iterable<unknown> | null = null;
    if (Array.isArray(p)) ks = p;
    else if (Array.isArray(cur) && typeof p === "function") {
      const out: number[] = [];
      for (let j = 0; j < cur.length; j++) if ((p as (v: unknown, i: number) => unknown)(cur[j], j)) out.push(j);
      ks = out;
    } else if (Array.isArray(cur) && typeof p === "object" && p !== null) {
      const { from = 0, to = cur.length - 1, by = 1 } = p as PathRange,
        out: number[] = [];
      for (let j = from; j <= to; j += by) out.push(j);
      ks = out;
    }
    if (ks !== null) {
      for (const each of ks) {
        args[i] = each;
        walk(cur, args, i);
      }
      args[i] = p;
      return;
    }
    k = p as PropertyKey;
    if (i < last - 1) return walk(cur[k] as Obj, args, i + 1);
    prev = cur[k];
  }
  let v = args[last];
  if (typeof v === "function") {
    v = (v as (prev: unknown) => unknown)(prev);
    if (v === prev) return;
  }
  if (k === undefined && v == null) return;
  if (v === DELETE) delete cur[k!];
  else if (k === undefined || (wrappable(raw(prev)) && wrappable(raw(v)) && !Array.isArray(raw(v)))) {
    // Merged into what is there: each own enumerable key of `v`, symbols too; a getter as a getter.
    const into = (k === undefined ? cur : prev) as Obj,
      t = raw(into),
      from = raw(v) as Obj;
    for (const key of Reflect.ownKeys(from)) {
      const desc = Object.getOwnPropertyDescriptor(from, key)!;
      if (!desc.enumerable || shared(key)) continue;
      if (desc.get === undefined && desc.set === undefined) into[key] = desc.value;
      else {
        const had = Object.hasOwn(t, key);
        Object.defineProperty(t, key, desc);
        bump(t, key);
        if (!had) bump(t, KEYS);
      }
    }
  } else cur[k!] = v;
}

/**
 * A setter's function that writes one value at a path into its draft, as Solid 1.x's
 * `setStore("user", "name", "Ada")` did: `setStore(path("user", "name", "Ada"))`. Each step is a
 * key, an array of keys (each is written), and in an array a range `{ from, to, by }` or a test
 * `(item, index) => boolean` of its items. The last argument is the value: a function gets the
 * value there and returns the new one (returning it unchanged writes nothing), an object written
 * over an object (not an array) is merged into it, and `path.DELETE` deletes the property. With
 * no key, the value is merged into the store itself. `__proto__`, `constructor` and `prototype`
 * are neither followed nor written. It is Solid 2.0's `storePath`.
 *
 * @example
 *   setStore(path("user", "name", "Grace"));
 *   setStore(path("todos", (t) => !t.done, "done", true)); // every undone todo, done
 *   setStore(path("todos", { from: 0, to: 1 }, "seen", (n) => n + 1));
 *   setStore(path("user", "nickname", path.DELETE));
 */
export const path: Path = /* @__PURE__ */ Object.assign(
  (...args: unknown[]) =>
    (draft: unknown): void =>
      walk(draft as Obj, args, 0),
  { DELETE },
) as Path;

/** A copy of `v`, read through store proxies when `tracked` (each read subscribes). */
function copy(v: unknown, tracked: boolean, seen: Map<object, unknown>): unknown {
  const t = raw(v);
  if (!wrappable(t)) return v;
  let out = seen.get(t) as Obj | undefined;
  if (out !== undefined) return out;
  const s = tracked ? wrap(t, false) : t;
  seen.set(t, (out = (Array.isArray(t) ? [] : {}) as Obj));
  if (Array.isArray(s)) for (let i = 0; i < s.length; i++) out[i] = copy(s[i], tracked, seen);
  else for (const k of Object.keys(s)) put(out, k, copy(s[k], tracked, seen));
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
