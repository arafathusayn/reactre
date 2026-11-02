// @reactre/core/features/actions: Solid 2.0's actions and optimistic values. `action(fn)` runs a
// generator (or async generator) of a mutation in a transition; `createOptimistic` and
// `createOptimisticStore` take writes that show at once and revert when the transition ends;
// `affects` marks what the transition will change as pending; `until` waits for a condition.
//
// How it works:
//   - An action holds the core's transition open (`holds`) while its generator runs, from its
//     first step to its return. Each step (the code up to a `yield`) runs as the action's code
//     (`__act`): an optimistic write made there is the transition's, and a `refresh` made there
//     joins it. A yielded value is awaited, and what it resolves to (or throws) goes back in.
//   - The transition ends once no action runs in it and no async memo it waits for is pending:
//     the optimistic writes revert, what it held runs, and the actions' Promises settle (but
//     those of actions called in another action's code, which settle as they return, for it to
//     yield). One transition is open at a time, so actions that overlap end together.
//   - An optimistic value is a base value with an override per transition: reads see the
//     override; a write in an action sets it, a write elsewhere sets the base.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free. It needs the core's async runtime, as features/async does, and loading it with
//     the core's default build throws, naming the fix.
//   - Generators, as in Solid 2.0, so that the code of an action after a `yield` is known to be
//     the action's. In an async generator, code after an `await` runs outside it: yield the
//     Promise instead.
//   - An optimistic store is two stores: a base (`createStore`), and a projection of it with the
//     transitions' writes applied over it, rebuilt from a deep copy of the base when either
//     changes. Its reads are the projection's.

import * as core from "@reactre/core";
import { __Owned, __owner, __Root, effect, memo, type Setter, signal, untrack } from "@reactre/core";
import {
  createProjection,
  createStore,
  deep,
  type ProjectionOptions,
  reconcile,
  type Store,
  type StoreSetter,
} from "@reactre/core/features/store";

/** What loading this module with the core's default build throws. */
const NEEDS =
  "reactre: @reactre/core/features/actions needs @reactre/core's async runtime, and this @reactre/core is its " +
  "default build. Build with @reactre/plugin, which picks the async build for a program that imports this " +
  'module, or resolve @reactre/core with the "reactre-async" export condition.';
if (typeof core.__installAsync !== "function") throw new Error(NEEDS);

core.__installAsync();
core.__installHolds();

/** A transition, as the core keeps it. */
type Transition = core.__Transition;

/** While `until`'s condition runs: optimistic values read as their base, the authoritative view. */
let authoritative = 0;

/** A version signal and its bump, which the page sees at once, in an action's code too. */
function counter(): [() => number, () => void] {
  const [read, write] = signal(0);
  return [read, () => core.__act(null, () => write((n) => n + 1))];
}

/**
 * An action: a mutation written as a generator (or an async generator), run in a transition.
 * Calling it starts the generator and returns a Promise of what it returns, settled when the
 * transition ends; called in another action's code, it joins that action's transition, and its
 * Promise settles when it returns, so that the other may yield it. Each value it yields is
 * awaited, and goes back in (a rejection is thrown in).
 *
 * In the code of an action, a write to an optimistic value (`createOptimistic`,
 * `createOptimisticStore`) shows at once and reverts when the transition ends, and a `refresh` is
 * waited for by the transition. When the transition ends (no action runs in it, no async memo it
 * waits for is pending), the optimistic writes revert, and the effects it held (see
 * @reactre/core/features/async) run with the new values: the page goes from the optimistic state
 * to the confirmed one at once.
 *
 * @example
 *   import { action, createOptimisticStore } from "@reactre/core/features/actions";
 *   import { refresh } from "@reactre/core/features/async";
 *
 *   const [todos, setTodos] = createOptimisticStore(() => api.todos(), []);
 *   const add = action(function* (title: string) {
 *     setTodos((d) => {
 *       d.push({ id: -1, title });
 *     });
 *     yield api.add(title);
 *     yield refresh(todos);
 *   });
 */
export function action<A extends unknown[], R>(
  fn: (...args: A) => Generator<unknown, R, unknown> | AsyncGenerator<unknown, R, unknown>,
): (...args: A) => Promise<R> {
  return (...args) =>
    new Promise<R>((ok, no) => {
      // Called in another action's code, it settles when its generator ends, for that action to
      // yield: settled with the transition, which waits for that action, it never would.
      const inner = core.__acting() !== null,
        t = core.__begin();
      let it: Generator<unknown, R, unknown> | AsyncGenerator<unknown, R, unknown> | undefined;
      const end = (failed: boolean, v: unknown): void => {
        const settle = (): void => (failed ? no(v) : ok(v as R));
        core.__end(t, inner ? null : settle);
        if (inner) settle();
      };
      const next = (r: IteratorResult<unknown, R>): void => {
        if (r.done) return end(false, r.value);
        Promise.resolve(r.value).then(
          (v) => step("next", v),
          (e: unknown) => step("throw", e),
        );
      };
      const step = (how: "next" | "throw", v: unknown): void => {
        let r: IteratorResult<unknown, R> | Promise<IteratorResult<unknown, R>>;
        try {
          r = core.__act(t, () => (it ??= fn(...args))[how](v));
        } catch (e) {
          return end(true, e);
        }
        if (r instanceof Promise) r.then(next, (e: unknown) => end(true, e));
        else next(r);
      };
      step("next", undefined);
    });
}

/**
 * An optimistic signal: `[read, write]`, as `signal`'s. A write in an action's code shows at once
 * and reverts when the action's transition ends; a write anywhere else sets the value, as a
 * signal's does. Given a function, the value is derived, as a memo's (async included): `fn`
 * computes it, and a write outside an action holds until `fn` runs again.
 *
 * @example
 *   const [likes, setLikes] = createOptimistic(() => post().likes);
 *   const like = action(function* () {
 *     setLikes((n) => n + 1);
 *     yield api.like(post().id);
 *     yield refresh(post);
 *   });
 */
export function createOptimistic<T>(fn: () => T): [() => T, Setter<T>];
export function createOptimistic<T>(value: T): [() => T, Setter<T>];
export function createOptimistic<T>(init: T | (() => T)): [() => T, Setter<T>] {
  const [version, bump] = counter();
  // The value a write outside an action set; for a derived one, until `fn` runs again.
  let local: { v: T } | null = null,
    over: { t: Transition; v: T } | null = null;
  const base =
    typeof init === "function"
      ? memo(() => {
          const v = (init as () => T)();
          if (local !== null) {
            local = null;
            bump();
          }
          return v;
        })
      : ((local = { v: init }), null);
  const read = (): T => {
    version();
    if (over !== null && authoritative === 0) return over.v;
    return local !== null ? local.v : base!();
  };
  const write: Setter<T> = (next) => {
    const v = typeof next === "function" ? (next as (prev: T) => T)(untrack(read)) : next,
      t = core.__acting();
    if (t === null) local = { v };
    else if (over !== null && over.t === t) over.v = v;
    else {
      const o = (over = { t, v });
      t.done.push(() => {
        if (over === o) over = null;
        bump();
      });
    }
    bump();
  };
  return [read, write];
}

/**
 * An optimistic store: `[store, setStore]`, as `createStore`'s. A write in an action's code
 * shows at once and reverts when the action's transition ends; a write anywhere else is the
 * store's own, as `createStore`'s setter writes.
 *
 * Given a function, the store is derived, as `createStore(fn, seed)` is: `fn` gets a draft of
 * `seed` to change, or returns the value, which may be a Promise (an async fn), reconciled into it
 * by `options.key`. Until an async `fn` has its first value, reading the store is not ready (see
 * @reactre/core/features/async's `<Loading>`). `refresh(store)` runs `fn` again.
 *
 * @example
 *   const [todos, setTodos] = createOptimisticStore(async () => (await fetch("/todos")).json(), []);
 */
export function createOptimisticStore<T extends object>(
  value: T,
  options?: ProjectionOptions,
): [Store<T>, StoreSetter<T>];
export function createOptimisticStore<T extends object>(
  fn: (draft: T) => T | void | PromiseLike<T>,
  seed: T,
  options?: ProjectionOptions,
): [Store<T>, StoreSetter<T>];
export function createOptimisticStore<T extends object>(
  a: T | ((draft: T) => T | void | PromiseLike<T>),
  b?: T | ProjectionOptions,
  c?: ProjectionOptions,
): [Store<T>, StoreSetter<T>] {
  const derived = typeof a === "function",
    options = (derived ? c : (b as ProjectionOptions | undefined)) ?? {},
    key = options.key === undefined ? "id" : options.key,
    owner = __owner;
  let source: (() => unknown) | undefined, base: T, setBase: StoreSetter<T>;
  if (derived) {
    // `fn` runs in a memo, so that it may be async; the base store reconciles what it gives.
    [base, setBase] = createStore<T>(
      (d) => (source ??= __Owned.within(owner, () => memo(() => (a as (draft: T) => unknown)(d))))() as T | void,
      b as T,
      options,
    );
  } else [base, setBase] = createStore(a as T);
  // The transitions' writes, applied in order over a copy of the base.
  const writes: { t: Transition; f: (draft: T) => T | void }[] = [];
  const [version, bump] = counter();
  const opt = createProjection<T>(
    (d) => {
      version();
      reconcile(deep(base), key)(d);
      for (const w of writes) {
        const r = w.f(d);
        if (typeof r === "object" && r !== null) reconcile(r, key)(d);
      }
    },
    (Array.isArray(base) ? [] : {}) as T,
    options,
  );
  // Reads go to the projection; until's condition reads the base. A derived store's reads wait
  // for its first value.
  const at = (): object => {
    if (source !== undefined) source();
    return authoritative === 0 ? opt : base;
  };
  const store = new Proxy(opt, {
    get: (_, k) => (typeof k === "symbol" ? Reflect.get(opt, k) : Reflect.get(at(), k)),
    has: (_, k) => Reflect.has(at(), k),
    ownKeys: () => Reflect.ownKeys(at()),
  });
  const set: StoreSetter<T> = (f) => {
    const t = core.__acting();
    if (t === null) return setBase(f);
    if (!writes.some((w) => w.t === t))
      t.done.push(() => {
        for (let i = writes.length; i--;) if (writes[i]!.t === t) writes.splice(i, 1);
        bump();
      });
    writes.push({ t, f });
    bump();
  };
  core.__refreshers.set(store, () => (source === undefined ? Promise.resolve() : core.__refreshers.get(source)!()));
  return [store, set];
}

/**
 * Mark `target` as changed by the work in flight: in the current action's transition, until it
 * ends, `isPending` is true for it and for what reads it. `target` is a signal's or memo's read
 * function (an optimistic one included), or a store, whose own properties are marked, or one of
 * them, `key`. It only adds pending state.
 *
 * @throws Error outside an action's code.
 *
 * @example
 *   const rename = action(function* (name: string) {
 *     affects(user, "name");
 *     yield api.rename(name);
 *     yield refresh(user);
 *   });
 */
export function affects(target: object, key?: PropertyKey): void {
  const t = core.__acting();
  if (t === null) throw new Error("reactre: affects() marks what an action changes: call it in an action's code");
  const store = target as Record<PropertyKey, unknown>;
  core.__affect(
    t,
    core.__capture(() => {
      if (typeof target === "function") (target as () => unknown)();
      else if (key !== undefined) store[key];
      else for (const k of Object.keys(store)) store[k];
    }),
  );
}

/** What `until` rejects with when its `timeout` passes. */
export class TimeoutError extends Error {
  override name: string = "TimeoutError";
  constructor() {
    super("reactre: until's condition did not come true in time");
  }
}

/** `until`'s options. */
export interface UntilOptions {
  /** Milliseconds after which it rejects with a TimeoutError. */
  readonly timeout?: number;
  /** Rejects with the signal's reason when it aborts. */
  readonly signal?: AbortSignal;
}

/**
 * A Promise of the first truthy value `fn` returns. `fn` runs now and whenever what it reads
 * changes, and reads the authoritative view: an optimistic value reads as its base, so an action
 * cannot confirm its own writes. A read that is not ready waits. It rejects with what `fn`
 * throws, a TimeoutError after `timeout`, or the reason of `signal` when it aborts. In an action,
 * `yield until(...)` holds the transition open, and the optimistic writes shown, until then.
 *
 * @example
 *   const send = action(function* (msg: Message) {
 *     setMessages((d) => {
 *       d.push(msg);
 *     });
 *     socket.send(msg);
 *     yield until(() => confirmed().includes(msg.id), { timeout: 5000 });
 *   });
 */
export function until<T>(fn: () => T, options: UntilOptions = {}): Promise<T> {
  return new Promise<T>((ok, no) => {
    const abort = options.signal;
    if (abort?.aborted) return no(abort.reason);
    const r = new __Root();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      r.dispose();
      clearTimeout(timer);
      abort?.removeEventListener("abort", aborted);
    };
    const aborted = (): void => {
      stop();
      no(abort!.reason);
    };
    abort?.addEventListener("abort", aborted);
    if (options.timeout !== undefined)
      timer = setTimeout(() => {
        stop();
        no(new TimeoutError());
      }, options.timeout);
    __Owned.within(r, () =>
      effect(() => {
        core.__live();
        let v: T;
        authoritative++;
        try {
          v = fn();
        } catch (e) {
          if (e instanceof core.__NotReadyError) throw e;
          stop();
          return no(e);
        } finally {
          authoritative--;
        }
        if (!v) return;
        stop();
        ok(v);
      }),
    );
  });
}
