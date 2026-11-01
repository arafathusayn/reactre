// @reactre/core/server/actions: @reactre/core/features/actions in a server build, where an app's
// imports of that module point (@reactre/compiler's server mode, once the module is compiled, as
// the compiler knows `createOptimisticStore`'s stores by the client's module). Everything is the
// module's own but these, inert there as in Solid 2.0's server: the page a server renders is
// settled state, and an optimistic write means something only on the client, until the work it
// goes with settles.
//
//   - `action(fn)` is `fn`: calling it makes its generator, and runs none of it.
//   - `createOptimistic` and `createOptimisticStore` read as the module's do, and their setters do
//     nothing: a function given to one is not called.

import {
  createOptimistic as clientOptimistic,
  createOptimisticStore as clientOptimisticStore,
} from "@reactre/core/features/actions";
import type { ProjectionOptions, Store, StoreSetter } from "@reactre/core/features/store";
import type { Setter } from "@reactre/core/server";

export * from "@reactre/core/features/actions";

/** `action` from @reactre/core/features/actions, on the server: `fn` itself, which never runs as an action. */
export function action<F extends (...args: never[]) => unknown>(fn: F): F {
  return fn;
}

/** `createOptimistic` from @reactre/core/features/actions, on the server: read as there; the setter does nothing. */
export function createOptimistic<T>(fn: () => T): [() => T, Setter<T>];
export function createOptimistic<T>(value: T): [() => T, Setter<T>];
export function createOptimistic<T>(init: T | (() => T)): [() => T, Setter<T>] {
  return [clientOptimistic(init as T)[0], () => {}];
}

/** `createOptimisticStore` from @reactre/core/features/actions, on the server: read as there; the setter does nothing. */
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
  const make = clientOptimisticStore as (a: unknown, b?: unknown, c?: unknown) => [Store<T>, StoreSetter<T>];
  return [make(a, b, c)[0], () => {}];
}
