// @reactre/core/features/errors: error boundaries, as Solid 2.0 has them. `<Errored fallback>`
// shows its fallback in place of its children when something they made throws; an effect can
// take its own handler (`effect(fn, { error })`); `configureClientErrors({ onError })` gets what
// no boundary catches.
//
// Where a throw is caught:
//
//   - Building the children: `<Errored>` reads them inside a try, so a component that throws
//     while its body runs is caught there, and what the children had made so far is disposed.
//   - Running an effect: the runtime's own (a hole, a slot, a list) and the app's, at their first
//     run and at every later one. The effect's scope (see @reactre/core/features/context, whose
//     scopes this module shares) holds the nearest boundary's handler.
//   - A `<For>` row's reactive holes: when the row is made or gets a new item, they run in the
//     list's effect, guarded as above. When a signal they read re-runs them, they run from the
//     write, under no effect: the row's observer is guarded, with the scope its list took when
//     a row first read a signal (as rows are made, in the list's effect). When a selector's
//     change re-runs them, they run in the selector's effect, so what they throw goes to the
//     boundary around the `selector()` call.
//
// A boundary shows its fallback once the run that threw, and every run around it, has ended: it
// never disposes a list or an effect in the middle of its own work. That is still before the
// write (or the `render`) that caused it returns.
//
// Design decisions:
//   - A feature module, not part of @reactre/core: the core's main entry holds what the compiler
//     makes free, and this is a runtime function.
//   - Effects get a try only when this module is loaded. It wraps the owned effect class's `once`
//     (every effect is one, once ownership is in) and the row observer class's `read` and `stale`
//     (`__Owned`, `__RowObserver`), as @reactre/core/features/context wraps `once` to give owners
//     their scope. With no boundary above and no `onError`, what is caught is thrown on: the core
//     behaves as it does without this module. The row observer class is small and holds no
//     list: an app without lists does not ship them for it.
//   - An effect's own handler is an option of the effect, `effect(fn, { error })`, as in Solid
//     2.0's `createEffect`, and not a registration on the current owner (Solid 1's `onError`).
//     An option is set where the effect is made, for its runs alone: it cannot be registered
//     after the code that throws, and in a component body it cannot end up on the slot or row
//     around the component, catching its neighbours' errors. It costs a try in that effect only.
//   - Event handlers and code that runs later (a timer, a promise) throw to their caller, as in
//     Solid: they run under no effect.

import { __frag, __Owned, __RowObserver, effect as coreEffect, signal, untrack } from "@reactre/core";
import { __children, __root, __scope, type Scope } from "@reactre/core/features/context";
import type { Child } from "@reactre/core/jsx-runtime";

/** The key a boundary's handler is kept by in a scope. */
const ERR: unique symbol = Symbol();
/** What gets an error. */
type Handler = (err: unknown) => void;
/** What has a scope: an effect, or a list. */
type Scoped = { c?: Scope };

/** The handler of errors that no boundary catches; none: they are thrown on. */
let onError: Handler | undefined;

/** Hand `err`, thrown in scope `s`, to the nearest boundary, else to `onError`, else throw it on. */
function fail(err: unknown, s: Scope | undefined): void {
  const h = s?.[ERR] as Handler | undefined;
  if (h !== undefined) h(err);
  else if (onError !== undefined) onError(err);
  else throw err;
}

/** How many guarded runs (effects, rows) are under way; a boundary waits for none. */
let depth = 0;
/** Boundaries to show their fallback, once no guarded run is under way. */
const due: (() => void)[] = [];

/**
 * Call method `f` of `o` with `a`: what it throws goes to the boundary of `at`'s scope (`o`'s
 * own, for an effect; its list's, for a row's observer), read once it has thrown.
 */
function guard<O, A>(at: Scoped, o: O, f: (this: O, a: A) => void, a: A): void {
  depth++;
  try {
    f.call(o, a);
  } catch (err) {
    fail(err, at.c);
  } finally {
    // Each leaves the queue before it runs; one that throws leaves the rest for the next end.
    if (--depth === 0) while (due.length !== 0) due.shift()!();
  }
}

// Effects: every run, guarded. The scope is the effect's own, set by the context module's `once`
// (which this one calls) at the effect's first run.
const effects = __Owned.prototype as unknown as { once(this: Scoped): void };
const once = effects.once;
effects.once = function () {
  guard(this, this, once, undefined);
};

// Rows: a row's reactive holes run in its list's effect when the row is made or gets a new item,
// which the effect's guard covers. A signal they read re-runs them from its write, through the
// row's observer, whose `stale` is guarded here with the list's scope. The list takes the scope
// current when one of its rows first reads a signal: as the row is made, in the list's effect.
type Observer = InstanceType<typeof __RowObserver>;
type List = Observer["list"] & Scoped;
const observers = __RowObserver.prototype as Observer & { list: List };
const read = observers.read,
  stale = observers.stale;
observers.read = function (s) {
  this.list.c ??= __scope();
  read.call(this, s);
};
observers.stale = function () {
  guard(this.list, this, stale, undefined);
};

/** `<Errored>`'s fallback: an element, or a function of the error and a reset. */
export type ErroredFallback = Child | ((err: unknown, reset: () => void) => Child);

/** Stands in `<Errored>`'s error while its children are shown. */
const OK = {};

/**
 * `<Errored fallback>`: its children, until something they made throws: then `fallback`, which
 * may be a function of the error and `reset`. `reset()` builds the children again.
 *
 * It catches what is thrown while the children are built (a component's body, an effect's or a
 * slot's first run, a row's creation) and while they update (an effect's or a slot's later run, a
 * row's reactive holes). What they made is disposed; the fallback shows once the run that threw,
 * and every run around it, has ended. The first error is the one shown; what the fallback throws
 * goes to the boundary above. Event handlers, timers and promises throw to their caller.
 *
 * Its children are read inside it, so it must get them unbuilt: a getter (`get children()`), or a
 * function, which renders as a slot.
 *
 * @example
 *   import { Errored } from "@reactre/core/features/errors";
 *
 *   const App = () => (
 *     <Errored fallback={(err, reset) => <button onClick={reset}>{String(err)}: retry</button>}>
 *       <Profile />
 *     </Errored>
 *   );
 */
export function Errored(props: { fallback: ErroredFallback; children?: Child | (() => Child) }): unknown {
  let error: unknown = OK,
    // A throw has asked for the fallback, and this has not run since.
    asked = false;
  const [version, bump] = signal(0);
  const again = (): void => {
    if (asked) bump((n) => n + 1);
  };
  const s: Scope = Object.create(__scope());
  s[ERR] = (err: unknown): void => {
    if (error !== OK) return;
    error = err;
    asked = true;
    due.push(again);
  };
  const reset = (): void => {
    if (error === OK) return;
    error = OK;
    bump((n) => n + 1);
  };
  // The slot's own scope is the one around the boundary: what the fallback throws goes there.
  return __frag([
    () => {
      version();
      asked = false;
      return untrack(() => {
        if (error === OK) {
          const r = __root(s);
          try {
            return __Owned.within(r, () => __children(props.children));
          } catch (err) {
            r.dispose();
            if (error === OK) error = err;
          }
        }
        asked = false;
        const f = props.fallback;
        return typeof f === "function" ? f(error, reset) : f;
      });
    },
  ]);
}

/** `effect`'s options here. */
export interface EffectOptions {
  /**
   * Gets what a run of the effect throws, untracked, in place of the boundary above. The
   * effect still follows what the run read before it threw. What `error` throws goes to the
   * boundary.
   */
  error?: (err: unknown) => void;
}

/**
 * @reactre/core's `effect`, with Solid 2.0's error option: `effect(fn, { error })` hands what a
 * run of `fn` throws to `error`, and only what `fn` itself throws (the effects it makes have their
 * own runs, and their own boundary). Without `error`, it is the core's `effect`.
 *
 * @example
 *   import { effect } from "@reactre/core/features/errors";
 *
 *   effect(() => render(JSON.parse(text())), { error: (err) => setProblem(String(err)) });
 */
export function effect(fn: () => void, options?: EffectOptions): void {
  const error = options?.error;
  coreEffect(
    error === undefined
      ? fn
      : () => {
          try {
            fn();
          } catch (err) {
            untrack(() => error(err));
          }
        },
  );
}

/** `configureClientErrors`'s options. */
export interface ClientErrorOptions {
  /** Gets every error that an effect, a slot or a row throws and no boundary catches. */
  onError?: (err: unknown) => void;
}

/**
 * Set what gets the errors no `<Errored>` catches: those that an effect (the runtime's, a slot's,
 * a row's, or the app's) throws outside any boundary. With `onError`, they go to it and go no
 * further; without, they are thrown on to the code that caused the run (a signal's write, a
 * `render`), as without this module. A throw outside any effect (a component that `render` runs
 * directly) goes to its caller either way.
 *
 * @example
 *   import { configureClientErrors } from "@reactre/core/features/errors";
 *
 *   configureClientErrors({ onError: (err) => report(err) });
 */
export function configureClientErrors(options: ClientErrorOptions): void {
  onError = options.onError;
}
